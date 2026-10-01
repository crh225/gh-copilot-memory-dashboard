import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateEvent, emptyEstimate, addEstimate, pricingSnapshot } from "../lib/pricing.js";

const event = overrides => ({
  model: "gpt-6.1-sol", input_tokens: 1000, output_tokens: 200,
  cache_read_tokens: 500, cache_write_tokens: 50, ...overrides,
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("current rates price uncached input, cached reads, cache writes and output exactly once", () => {
  const result = estimateEvent(event());
  near(result.usd, (450 * 2 + 500 * 0.1 + 50 * 2.5 + 200 * 10) / 1e6);
  near(result.credits, result.usd / 0.01);
  assert.equal(pricingSnapshot.asOf, "2026-10-01");
  assert.equal(result.basis, "normalizedCounters");
  assert.equal(result.tier, "default");
});

test("long-context threshold uses individual full context and is strictly greater than the threshold", () => {
  const normal = estimateEvent(event({ input_tokens: 272000 }));
  const long = estimateEvent(event({ input_tokens: 272001 }));
  assert.equal(normal.tier, "default");
  assert.equal(long.tier, "longContext");
  near(long.usd, ((272001 - 550) * 4 + 500 * 0.2 + 50 * 5 + 200 * 15) / 1e6);
  assert.equal(estimateEvent(event({ model: "gpt-5.6-luna", input_tokens: 200000 })).tier, "default");
  assert.equal(estimateEvent(event({ model: "gpt-5.6-luna", input_tokens: 200001 })).tier, "longContext");
});

test("recorded token categories take precedence over inconsistent aggregate counters and historical prices", () => {
  const result = estimateEvent(event({
    input_tokens: 9999999, output_tokens: null, cache_read_tokens: null,
    token_details_json: JSON.stringify([
      { tokenType: "input", tokenCount: 450, costPerBatch: 9999 },
      { tokenType: "cache_read", tokenCount: 500 },
      { tokenType: "cache_write", tokenCount: 50 },
      { tokenType: "output", tokenCount: 200 },
    ]),
  }));
  near(result.usd, estimateEvent(event()).usd);
  assert.equal(result.basis, "recordedBreakdown");
  assert.equal(result.tier, "default");
});

test("unpriced, incomplete, inconsistent, and malformed events are excluded rather than priced at zero", () => {
  for (const overrides of [
    { model: "unpublished-model" }, { cache_read_tokens: null }, { input_tokens: -1 },
    { input_tokens: 1 }, { cache_write_tokens: null }, { output_tokens: null },
    { token_details_json: "bad-json" }, { token_details_json: "{}" },
    { token_details_json: JSON.stringify([{ tokenType: "input", tokenCount: 1 }]) },
    { token_details_json: JSON.stringify([{ tokenType: "image", tokenCount: 1 }]) },
  ]) {
    const result = estimateEvent(event(overrides));
    assert.equal(result.usd, null);
    assert.ok(result.reason);
  }
  assert.equal(estimateEvent(event({ model: "gpt-5-mini" })).usd, null);
  assert.ok(estimateEvent(event({ model: "gpt-5-mini", cache_write_tokens: 0 })).usd > 0);
});

test("promotional rates stop producing estimates after their published expiry", () => {
  const promo = event({ model: "gemini-3.8-flash", cache_write_tokens: 0 });
  near(estimateEvent(promo, "2026-12-31").usd, (500 * 0.75 + 500 * 0.075 + 200 * 3.75) / 1e6);
  assert.equal(estimateEvent(promo, "2027-01-01").usd, null);
  assert.match(estimateEvent(promo, "2027-01-01").reason, /expired/);
});

test("missing estimates remain null while recorded zero usage remains a valid zero estimate", () => {
  const summary = emptyEstimate();
  addEstimate(summary, estimateEvent(event({ model: "unknown" })));
  assert.equal(summary.usd, null);
  assert.equal(summary.excludedEvents, 1);
  addEstimate(summary, estimateEvent(event({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })));
  assert.equal(summary.usd, 0);
  assert.equal(summary.pricedEvents, 1);
  assert.equal(summary.credits, 0);
});
