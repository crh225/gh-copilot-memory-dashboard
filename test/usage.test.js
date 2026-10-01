import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDemo } from "../lib/demo-data.js";
import { withStore } from "../lib/store.js";
import { dashboard } from "../lib/usage.js";

function fixture(t, change) {
  const directory = mkdtempSync(join(tmpdir(), "memory-usage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "test.db");
  createDemo(path);
  if (change) {
    const writer = new DatabaseSync(path);
    try { change(writer); } finally { writer.close(); }
  }
  return path;
}

test("aggregates exact recorded metrics with sample coverage and no inferred spending", t => {
  const path = fixture(t);
  const before = readFileSync(path);
  withStore(path, db => {
    const data = dashboard(db, new URLSearchParams());
    assert.equal(data.available, true);
    assert.equal(data.totals.requests, 48);
    assert.equal(data.totals.sessions, 4);
    assert.equal(data.totals.metrics.inputTokens.total, 48000);
    assert.equal(data.totals.metrics.outputTokens.total, 9600);
    assert.equal(data.totals.metrics.cacheReadTokens.total, 8000);
    assert.equal(data.totals.metrics.cacheReadTokens.samples, 16);
    assert.equal(data.totals.metrics.nanoAiu.total / 1e9, 48);
    assert.equal(data.totals.metrics.durationMs.average, 2000);
    assert.ok(Math.abs(data.sessionSpan.averageMs - 660000) < 1);
    assert.equal(data.sessionSpan.samples, 4);
    assert.equal(data.models.length, 2);
    assert.equal(data.repositories.length, 3);
    assert.equal(data.daily.length, 4);
    assert.equal(data.contentFilters.triggered, 0);
    assert.equal(data.dollarCost, null);
    assert.match(data.costNote, /not recorded/);
    assert.ok(Math.abs(data.estimate.usd - 0.0355) < 1e-10);
    assert.equal(data.estimate.pricedEvents, 16);
    assert.equal(data.estimate.excludedEvents, 32);
    assert.ok(Math.abs(data.models.reduce((sum, row) => sum + (row.estimate.usd || 0), 0) - data.estimate.usd) < 1e-10);
    assert.ok(Math.abs(data.repositories.reduce((sum, row) => sum + (row.estimate.usd || 0), 0) - data.estimate.usd) < 1e-10);
  });
  assert.deepEqual(readFileSync(path), before);
});

test("repository and date filters apply to events and activity without double-counting joins", t => {
  withStore(fixture(t), db => {
    const data = dashboard(db, new URLSearchParams({ repository: "example/widget-api", from: "2026-01-22", to: "2026-01-22" }));
    assert.equal(data.totals.requests, 12);
    assert.equal(data.totals.metrics.inputTokens.total, 12000);
    assert.equal(data.activity.length, 1);
    assert.equal(data.activity[0].sessions, 1);
    assert.equal(data.models.length, 1);
    assert.equal(data.daily[0].name, "2026-01-22");
    assert.ok(Math.abs(data.estimate.usd - 0.0125) < 1e-10);
    assert.equal(data.estimate.pricedEvents, 4);
    assert.throws(() => dashboard(db, new URLSearchParams({ from: "2026-02-30" })), { status: 400 });
  });
});

test("missing usage tables preserve activity and explain unavailability", t => {
  withStore(fixture(t, db => db.exec("DROP TABLE assistant_usage_events")), db => {
    const data = dashboard(db, new URLSearchParams());
    assert.equal(data.available, false);
    assert.match(data.reason, /no assistant usage/);
    assert.equal(data.activity.length, 4);
    assert.equal(data.dollarCost, null);
  });
});

test("older usage schemas expose only available columns, not fabricated zeros", t => {
  withStore(fixture(t, db => {
    db.exec("DROP TABLE assistant_usage_events; CREATE TABLE assistant_usage_events (session_id TEXT, created_at TEXT, input_tokens INTEGER)");
    db.exec("INSERT INTO assistant_usage_events VALUES ('demo-cache', '2026-01-20', 7)");
  }), db => {
    const data = dashboard(db, new URLSearchParams());
    assert.equal(data.totals.metrics.inputTokens.total, 7);
    assert.equal(data.totals.metrics.outputTokens.total, null);
    assert.equal(data.totals.metrics.nanoAiu.total, null);
    assert.equal(data.totals.metrics.durationMs.samples, 0);
    assert.equal(data.sessionSpan.averageMs, null);
    assert.equal(data.models[0].name, "Unrecorded");
  });
});

test("usage schemas without timestamps are explicitly unsupported while activity remains usable", t => {
  withStore(fixture(t, db => {
    db.exec("DROP TABLE assistant_usage_events; CREATE TABLE assistant_usage_events (session_id TEXT, input_tokens INTEGER)");
  }), db => {
    const data = dashboard(db, new URLSearchParams());
    assert.equal(data.available, false);
    assert.match(data.reason, /timestamp/);
    assert.equal(data.activity.length, 4);
  });
});

test("invalid and absent samples are excluded, and empty ranges remain explicitly empty", t => {
  withStore(fixture(t, db => {
    db.exec("UPDATE assistant_usage_events SET duration_ms = -1, total_nano_aiu = NULL, reasoning_tokens = -10");
  }), db => {
    const data = dashboard(db, new URLSearchParams());
    assert.equal(data.totals.metrics.durationMs.total, null);
    assert.equal(data.totals.metrics.durationMs.samples, 0);
    assert.equal(data.totals.metrics.nanoAiu.total, null);
    assert.equal(data.totals.metrics.reasoningTokens.total, null);
    const empty = dashboard(db, new URLSearchParams({ from: "2030-01-01" }));
    assert.equal(empty.totals.requests, 0);
    assert.equal(empty.totals.metrics.inputTokens.total, null);
    assert.equal(empty.dollarCost, null);
    assert.equal(empty.estimate.usd, null);
  });
});
