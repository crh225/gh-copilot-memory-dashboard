import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDemo } from "../lib/demo-data.js";
import { withStore } from "../lib/store.js";
import { usageInsights } from "../lib/insights.js";
import { estimateEvent } from "../lib/pricing.js";

const params = values => new URLSearchParams(values);
function fixture(t, edit = () => {}) {
  const path = resolve(`.insights-test-${randomUUID()}.db`);
  t.after(() => rmSync(path, { force: true }));
  createDemo(path);
  const writer = new DatabaseSync(path);
  try { edit(writer); } finally { writer.close(); }
  return callback => {
    const before = readFileSync(path);
    try { return withStore(path, callback); }
    finally { assert.deepEqual(readFileSync(path), before, "source bytes unchanged"); }
  };
}
function events(db, rows) {
  db.exec(`DROP TABLE assistant_usage_events;
    CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, created_at TEXT,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, token_details_json TEXT, agent_id TEXT, turn_index INTEGER)`);
  const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  rows.forEach((row, i) => insert.run(i + 1, row.session || "demo-cache", row.date || `2026-01-20 10:${String(i).padStart(2, "0")}:00`,
    row.model === undefined ? "gpt-5.4-mini" : row.model,
    row.input === undefined ? 100 : row.input, row.output === undefined ? 20 : row.output,
    row.read === undefined ? 50 : row.read, row.write === undefined ? 0 : row.write,
    row.details ?? null, row.agent ?? null, i));
}

test("demo insights aggregate recorded hotspots and published-rate estimates with read-only bytes", t => {
  fixture(t)(db => {
    const data = usageInsights(db, params());
    assert.equal(data.available, true);
    assert.equal(data.total, 4);
    assert.equal(data.totals.events, 48);
    assert.equal(data.totals.inputTokens, 48000);
    assert.equal(data.totals.outputTokens, 9600);
    assert.equal(data.totals.cacheReadShare, 0.5);
    assert.equal(data.totals.cacheSamples, 16);
    assert.equal(data.totals.pricedEvents, 16);
    assert.equal(data.totals.excludedEvents, 32);
    assert.ok(Math.abs(data.totals.usd - 0.0355) < 1e-10);
    assert.ok(Math.abs(data.sessions.reduce((n, row) => n + row.usd, 0) - data.totals.usd) < 1e-10);
    assert.equal(data.daily.length, 4);
    assert.equal(data.modelChanges.length, 0);
    assert.match(data.costNote, /not an invoice/);
    assert.ok(data.sessions[0].usd >= data.sessions.at(-1).usd);
    assert.deepEqual(data, usageInsights(db, params()));
  });
});

test("repository/date filters and repo alias constrain hotspots, not baseline lookback", t => {
  fixture(t)(db => {
    const data = usageInsights(db, params({ repo: "example/widget-api", from: "2026-01-22", to: "2026-01-22" }));
    assert.deepEqual(data.sessions.map(row => row.id), ["demo-tests"]);
    assert.equal(data.totals.events, 12);
    assert.deepEqual(data.daily.map(row => row.day), ["2026-01-22"]);
    assert.equal(data.daily[0].baseline.observedDays, 1);
    assert.equal(usageInsights(db, params({ repository: "' OR 1=1 --" })).total, 0);
    assert.throws(() => usageInsights(db, params({ from: "2026-02-30" })), { status: 400 });
  });
});

test("paired cache share excludes unpaired and impossible counters, includes recorded zero, and exposes coverage", t => {
  fixture(t, db => events(db, [
    { input: 100, read: 60 }, { input: 300, read: null }, { input: null, read: 50 },
    { input: 100, read: 101 }, { input: -1, read: 0 }, { input: 200, read: 100 },
    { input: 100, read: 80, write: 30 }, { input: 0, read: 0 }, { input: 100, read: 50, write: -1 },
  ]))(db => {
    const data = usageInsights(db, params());
    const row = data.sessions[0];
    assert.equal(row.cacheSamples, 3);
    assert.equal(row.cachePairedInputTokens, 300);
    assert.equal(row.cachePairedReadTokens, 160);
    assert.equal(row.cacheReadShare, 160 / 300);
    assert.equal(row.coverage.inputSamples, 7);
    assert.equal(row.coverage.outputSamples, 9);
    assert.equal(row.pricedEvents, 3);
    assert.equal(row.excludedEvents, 6);
  });
});

test("zero paired input leaves share unavailable, not a fabricated effectiveness value", t => {
  fixture(t, db => events(db, [{ input: 0, read: 0 }]))(db => {
    const data = usageInsights(db, params());
    assert.equal(data.sessions[0].cacheSamples, 1);
    assert.equal(data.sessions[0].cacheReadShare, null);
    assert.equal(data.sessions[0].cachePairedReadTokens, 0);
  });
});

test("absent/unsupported schemas explicitly unavailable; absent categories remain null", t => {
  fixture(t, db => db.exec("DROP TABLE assistant_usage_events"))(db => {
    const data = usageInsights(db, params());
    assert.equal(data.available, false);
    assert.match(data.reason, /No assistant usage/);
  });
  fixture(t, db => db.exec(`DROP TABLE assistant_usage_events;
    CREATE TABLE assistant_usage_events (session_id TEXT, input_tokens INTEGER)`))(db => {
    assert.equal(usageInsights(db, params()).available, false);
  });
  fixture(t, db => db.exec(`DROP TABLE assistant_usage_events;
    CREATE TABLE assistant_usage_events (session_id TEXT, created_at TEXT, input_tokens INTEGER);
    INSERT INTO assistant_usage_events VALUES ('demo-cache', '2026-01-20', 7)`))(db => {
    const row = usageInsights(db, params()).sessions[0];
    assert.equal(row.inputTokens, 7);
    assert.equal(row.outputTokens, null);
    assert.equal(row.cacheReadShare, null);
    assert.equal(row.cacheSamples, 0);
    assert.equal(row.usd, null);
    assert.equal(row.models, null);
    assert.equal(row.coverage.outputSamples, 0);
    assert.equal(row.excludedEvents, 1);
  });
});

test("published pricing handles recorded breakdowns, unknown models and oversize breakdown exclusions", t => {
  const details = JSON.stringify([
    { tokenType: "input", tokenCount: 100 }, { tokenType: "output", tokenCount: 20 },
    { tokenType: "cache_read", tokenCount: 50 },
  ]);
  fixture(t, db => events(db, [
    { input: null, output: null, read: null, details }, { model: "synthetic-unknown-model" },
    { details: "x".repeat(70000) },
  ]))(db => {
    const data = usageInsights(db, params());
    assert.equal(data.totals.pricedEvents, 1);
    assert.equal(data.totals.excludedEvents, 2);
    assert.equal(data.totals.estimate.recordedBreakdownEvents, 1);
    assert.equal(data.totals.usd, estimateEvent({ model: "gpt-5.4-mini", token_details_json: details }).usd);
    assert.ok(Object.keys(data.totals.estimate.reasons).some(value => value.includes("analysis limit")));
    assert.equal(data.totals.cacheSamples, 2, "breakdown-only event is not counter-paired");
  });
});

test("daily spikes use prior seven calendar days with minimum observed-day coverage and a twofold threshold", t => {
  fixture(t, db => events(db, [
    { date: "2026-01-27", input: 80, output: 20 },
    { date: "2026-01-29", input: 80, output: 20 },
    { date: "2026-01-31", input: 80, output: 20 },
    { date: "2026-02-01", input: 480, output: 20 },
    { date: "2026-02-02", input: 80, output: 20 },
    { date: "2026-02-10", input: 1000, output: 20 },
  ]))(db => {
    const data = usageInsights(db, params({ from: "2026-02-01" }));
    assert.equal(data.spikes.length, 1);
    assert.equal(data.spikes[0].day, "2026-02-01");
    assert.equal(data.spikes[0].ratio, 5);
    assert.equal(data.spikes[0].baseline.observedDays, 3);
    assert.equal(data.spikes[0].baseline.meanTokens, 100);
    assert.equal(data.daily.find(row => row.day === "2026-02-10").baseline.meanTokens, null);
    assert.equal(data.totals.events, 3, "lookback events do not contaminate selected totals");
  });
});

test("fewer than three valid baseline days and zero baseline never produce spikes", t => {
  fixture(t, db => events(db, [
    { date: "2026-01-01", input: 0, output: 0, read: 0 },
    { date: "2026-01-02", input: 0, output: 0, read: 0 },
    { date: "2026-01-03", input: 0, output: 0, read: 0 },
    { date: "2026-01-04", input: 10000 },
    { date: "2026-01-15", input: null },
    { date: "2026-01-16", input: 10000 },
  ]))(db => {
    const data = usageInsights(db, params());
    assert.equal(data.spikes.length, 0);
    assert.equal(data.daily.find(row => row.day === "2026-01-16").baseline.observedDays, 0);
    assert.equal(data.daily.find(row => row.day === "2026-01-15").tokens, null);
  });
});

test("model changes are recorded adjacent stream models; missing and equal-timestamp ambiguity breaks continuity", t => {
  fixture(t, db => events(db, [
    { model: "gpt-5.4-mini", agent: "synthetic-agent-a", date: "2026-01-20 10:00:00" },
    { model: "claude-sonnet-5", agent: "synthetic-agent-a", date: "2026-01-20 10:01:00" },
    { model: null, agent: "synthetic-agent-a", date: "2026-01-20 10:02:00" },
    { model: "gpt-5.4-mini", agent: "synthetic-agent-a", date: "2026-01-20 10:03:00" },
    { model: "claude-sonnet-5", agent: "synthetic-agent-b", date: "2026-01-20 10:00:00" },
    { model: "gpt-5.4-mini", agent: "synthetic-agent-b", date: "2026-01-20 10:00:00" },
    { model: "claude-sonnet-5", agent: "synthetic-agent-b", date: "2026-01-20 10:01:00" },
  ]))(db => {
    const data = usageInsights(db, params());
    assert.equal(data.modelChanges.length, 1);
    assert.equal(data.modelChanges[0].agent_id, "synthetic-agent-a");
    assert.equal(data.modelChanges[0].from, "gpt-5.4-mini");
    assert.equal(data.modelChanges[0].to, "claude-sonnet-5");
    assert.equal(data.modelChanges[0].evidence, "recorded");
    assert.equal(data.modelChanges[0].from_source_id, 1);
    assert.equal(data.modelChanges[0].source_id, 2);
    assert.equal(data.sessions[0].missingModelEvents, 1);
  });
});

test("empty ranges and invalid dates have honest coverage", t => {
  fixture(t, db => events(db, [{ date: "synthetic-invalid-date" }, { date: "2026-02-30" },
    { date: "2026-01-20", session: "synthetic-absent-session" }]))(db => {
    const data = usageInsights(db, params());
    assert.equal(data.coverage.invalidDateEvents, 2);
    assert.equal(data.coverage.missingSessionEvents, 1);
    assert.equal(data.daily.length, 1);
    const empty = usageInsights(db, params({ from: "2030-01-01" }));
    assert.equal(empty.total, 0);
    assert.equal(empty.totals.events, 0);
    assert.equal(empty.totals.inputTokens, null);
    assert.equal(empty.totals.usd, null);
  });
});

test("bounded hotspots/daily/model changes show truthful totals and truncation", t => {
  fixture(t, db => {
    const rows = [];
    for (let i = 0; i < 110; i++) rows.push({ session: `synthetic-session-${i}`, date: "2026-01-01" });
    for (let i = 0; i < 400; i++) rows.push({
      session: "demo-cache", date: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
      model: i % 2 ? "gpt-5.4-mini" : "claude-sonnet-5",
    });
    events(db, rows);
  })(db => {
    const data = usageInsights(db, params());
    assert.equal(data.total, 111);
    assert.equal(data.sessions.length, 100);
    assert.equal(data.dailyTotal, 401);
    assert.equal(data.daily.length, 366);
    assert.equal(data.modelChangesTotal, 399);
    assert.equal(data.modelChanges.length, 200);
    assert.equal(data.truncated, true);
    assert.equal(data.totals.events, 510);
  });
});

test("model lists and descriptive metadata are capped with truthful coverage", t => {
  fixture(t, db => {
    events(db, Array.from({ length: 30 }, (_, i) => ({ model: `synthetic-model-${i}` })));
    db.prepare("UPDATE sessions SET summary = ?, repository = ? WHERE id = 'demo-cache'")
      .run("s".repeat(70000), "r".repeat(70000));
  })(db => {
    const data = usageInsights(db, params());
    const row = data.sessions[0];
    assert.equal(row.models.length, 20);
    assert.equal(row.modelsTotal, 30);
    assert.equal(row.modelsTruncated, true);
    assert.equal(row.summary.length, 240);
    assert.equal(row.summaryTruncated, true);
    assert.equal(row.repository.length, 1000);
    assert.equal(row.repositoryTruncated, true);
    assert.equal(data.truncated, true);
    assert.equal(row.usd, null);
    assert.equal(row.excludedEvents, 30);
  });
});

test("old complete usage schemas without event IDs still support counters and recorded-model evidence", t => {
  fixture(t, db => {
    db.exec(`DROP TABLE assistant_usage_events;
      CREATE TABLE assistant_usage_events (session_id TEXT, created_at TEXT, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER);
      INSERT INTO assistant_usage_events VALUES ('demo-cache', '2026-01-20 10:00:00', 'gpt-5.4-mini', 100, 10, 20);
      INSERT INTO assistant_usage_events VALUES ('demo-cache', '2026-01-20 10:01:00', 'gpt-5.4', 100, 10, 20)`);
  })(db => {
    const data = usageInsights(db, params());
    assert.equal(data.totals.pricedEvents, 2);
    assert.equal(data.modelChanges.length, 1);
    assert.equal(data.modelChanges[0].source_id, null);
    assert.equal(data.modelChanges[0].from_source_id, null);
    assert.equal(data.modelChanges[0].turn_index, null);
  });
});
