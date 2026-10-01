export const pricingSnapshot = {
  asOf: "2026-10-01",
  source: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
  creditUsd: 0.01,
  currency: "USD",
  assumptions: [
    "Estimated usage value at GitHub's published rates as of 2026-10-01, applied to historical local events; not an invoice or actual out-of-pocket spending.",
    "Excludes subscription fees, included allowances, taxes, legacy premium-request billing, and discounts such as paid-plan auto selection.",
    "Recorded token breakdowns take precedence. Without them, normalized input is assumed to include cache reads/writes, which are subtracted before applying uncached-input rates.",
    "Long-context thresholds are evaluated per event using total input context, not aggregate token totals. Reasoning tokens are not charged again on top of output.",
    "Missing tokens, unknown models, invalid breakdowns, and expired promotional rates are excluded and shown in coverage counts.",
    "1 GitHub AI credit = $0.01 USD. Estimated credits are derived from estimated dollars, not from the internal recorded AIU field.",
  ],
};

// Rates are USD per million tokens: uncached input, cache read, cache write, output.
const rates = new Map();
function add(ids, base, threshold = null, long = null, expires = null) {
  for (const id of ids) rates.set(id, { base, threshold, long, expires });
}
add(["gpt-5-mini"], [0.25, 0.025, null, 2]);
add(["gpt-5.3-codex"], [1.75, 0.175, null, 14]);
add(["gpt-5.4"], [2.5, 0.25, null, 15], 272000, [5, 0.5, null, 22.5]);
add(["gpt-5.4-mini"], [0.75, 0.075, null, 4.5]);
add(["gpt-5.4-nano"], [0.2, 0.02, null, 1.25]);
add(["gpt-5.5"], [5, 0.5, null, 30], 272000, [10, 1, null, 45]);
add(["gpt-5.6-luna"], [0.2, 0.02, 0.25, 1.2], 200000, [0.4, 0.04, 0.5, 1.8]);
add(["gpt-5.6-sol"], [4, 0.4, 5, 20], 272000, [8, 0.8, 10, 30]);
add(["gpt-5.6-terra"], [2, 0.2, 2.5, 12], 272000, [4, 0.4, 5, 18]);
add(["gpt-6-astra"], [10, 1, 12.5, 50], 272000, [20, 2, 25, 75]);
add(["gpt-6-luna"], [0.1, 0.01, 0.125, 0.5], 272000, [0.2, 0.02, 0.25, 0.75]);
add(["gpt-6-sol"], [2, 0.2, 2.5, 10], 272000, [4, 0.4, 5, 15]);
add(["gpt-6.1-sol"], [2, 0.1, 2.5, 10], 272000, [4, 0.2, 5, 15]);
add(["claude-haiku-4.5"], [1, 0.1, 1.25, 5]);
add(["claude-sonnet-4", "claude-sonnet-4.6"], [3, 0.3, 3.75, 15]);
add(["claude-opus-4.7", "claude-opus-4.8", "claude-opus-5"], [5, 0.5, 6.25, 25]);
add(["claude-opus-5.5"], [4, 0.2, 5, 20]);
add(["claude-sonnet-5", "claude-sonnet-5.5"], [2, 0.2, 2.5, 10]);
add(["claude-opus-4.8-fast", "claude-fable-5"], [10, 1, 12.5, 50]);
add(["claude-fable-5.1"], [10, 0.25, 12.5, 50]);
add(["gemini-3.5-flash"], [1.5, 0.15, null, 9]);
add(["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"],
  [0.75, 0.075, null, 3.75], null, null, "2026-12-31");
add(["mai-code-1.1-flash"], [0.2, 0.02, null, 1.2]);
add(["grok-4.5", "grok-4.6", "grok-4.7"], [2, 0.5, null, 6], 200000, [4, 1, null, 12]);
add(["kimi-k2.7-code"], [0.95, 0.19, null, 4]);
add(["kimi-k3"], [3, 0.3, null, 15]);

const validCount = value => Number.isSafeInteger(value) && value >= 0;

export function estimateEvent(event, today = new Date().toISOString().slice(0, 10)) {
  const model = typeof event.model === "string" ? event.model.trim().toLowerCase().replace(/\s+/g, "-") : "";
  const rate = rates.get(model);
  if (!rate) return { usd: null, reason: "Model has no published rate in this snapshot" };
  if (rate.expires && today > rate.expires) return { usd: null, reason: "Promotional rate has expired" };
  let counts;
  let basis;
  if (event.token_details_json !== null && event.token_details_json !== undefined && event.token_details_json !== "") {
    let details;
    try {
      details = JSON.parse(event.token_details_json);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { usd: null, reason: "Invalid recorded token breakdown" };
    }
    if (!Array.isArray(details) || !details.length) return { usd: null, reason: "Unsupported recorded token breakdown" };
    const categories = new Map();
    for (const item of details) {
      if (!item || !["input", "cache_read", "cache_write", "output"].includes(item.tokenType) || !validCount(item.tokenCount)) {
        return { usd: null, reason: "Unsupported recorded token category or count" };
      }
      categories.set(item.tokenType, (categories.get(item.tokenType) || 0) + item.tokenCount);
    }
    if (!categories.has("input") || !categories.has("output") || !categories.has("cache_read") ||
        (rate.base[2] !== null && !categories.has("cache_write"))) {
      return { usd: null, reason: "Missing recorded token categories" };
    }
    counts = [categories.get("input"), categories.get("cache_read"), categories.get("cache_write") || 0, categories.get("output")];
    basis = "recordedBreakdown";
  } else {
    const { input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_write_tokens: write } = event;
    if (!validCount(input) || !validCount(output) || !validCount(read) ||
        (rate.base[2] !== null && !validCount(write))) {
      return { usd: null, reason: "Missing or invalid token counters" };
    }
    if (write !== null && write !== undefined && !validCount(write)) {
      return { usd: null, reason: "Invalid cache-write counter" };
    }
    const cacheWrite = write || 0;
    if (read + cacheWrite > input) return { usd: null, reason: "Cache counters exceed total input" };
    counts = [input - read - cacheWrite, read, cacheWrite, output];
    basis = "normalizedCounters";
  }
  if (rate.base[2] === null && counts[2] > 0) return { usd: null, reason: "Cache writes have no published rate for this model" };
  const context = counts[0] + counts[1] + counts[2];
  const tier = rate.threshold !== null && context > rate.threshold ? "longContext" : "default";
  const prices = tier === "longContext" ? rate.long : rate.base;
  const usd = counts.reduce((sum, count, index) => sum + count * (prices[index] || 0), 0) / 1e6;
  return { usd, credits: usd / pricingSnapshot.creditUsd, basis, tier };
}

export function emptyEstimate() {
  return { usd: null, credits: null, pricedEvents: 0, excludedEvents: 0, reasons: {},
    recordedBreakdownEvents: 0, normalizedCounterEvents: 0, longContextEvents: 0 };
}

export function addEstimate(summary, result) {
  if (result.usd === null) {
    summary.excludedEvents++;
    summary.reasons[result.reason] = (summary.reasons[result.reason] || 0) + 1;
    return;
  }
  summary.usd = (summary.usd || 0) + result.usd;
  summary.credits = summary.usd / pricingSnapshot.creditUsd;
  summary.pricedEvents++;
  if (result.basis === "recordedBreakdown") summary.recordedBreakdownEvents++;
  else summary.normalizedCounterEvents++;
  if (result.tier === "longContext") summary.longContextEvents++;
}
