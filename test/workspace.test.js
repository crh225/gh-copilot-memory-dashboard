import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDemo } from "../lib/demo-data.js";
import { withStore } from "../lib/store.js";
import { timeline, checkpointComparison, contextPack } from "../lib/workspace.js";

function fixture(t, edit = () => {}) {
  const path = resolve(`.workspace-test-${randomUUID()}.db`);
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
const params = values => new URLSearchParams(values);
const pack = (db, options = {}) => contextPack(db, {
  session_ids: ["demo-cache"], token_budget: 32000, redact: false, ...options,
});

test("timeline is recorded metadata only and files/ref numbers are repository scoped", t => {
  fixture(t, db => db.exec("UPDATE session_refs SET ref_type = 'pr'"))(db => {
    const data = timeline(db, params());
    assert.equal(data.total, 4);
    assert.equal(data.sessions.length, 4);
    assert.equal(data.nodes.filter(row => row.type === "file").length, 3);
    assert.equal(data.nodes.filter(row => row.type === "ref").length, 3);
    assert.ok(data.edges.every(row => row.evidence === "recorded"));
    assert.ok(data.edges.every(row => row.from.startsWith('["session"')));
    assert.ok(!JSON.stringify(data).includes("assistant_response"));
    const cache = data.edges.filter(row => row.from === '["session","demo-cache"]');
    const tests = data.edges.filter(row => row.from === '["session","demo-tests"]');
    assert.equal(cache.find(row => row.type === "file").to, tests.find(row => row.type === "file").to);
  });
});

test("timeline scopes unassigned relative paths by workspace, not global path", t => {
  fixture(t, db => db.exec("UPDATE sessions SET repository = NULL"))(db => {
    const data = timeline(db, params());
    assert.equal(data.nodes.filter(row => row.type === "file").length, 3);
  });
});

test("timeline filter aliases, literal file/ref/branch and inclusive lifetime overlap", t => {
  fixture(t)(db => {
    const data = timeline(db, params({ repo: "example/widget-api", from: "2026-01-22", to: "2026-01-22",
      file: "src/index.js", ref: "42", branch: "test/sqlite" }));
    assert.deepEqual(data.sessions.map(row => row.id), ["demo-tests"]);
    assert.equal(timeline(db, params({ ref: "' OR 1=1 --" })).total, 0);
    assert.equal(timeline(db, params({ file: "%" })).total, 0);
    assert.throws(() => timeline(db, params({ from: "2026-02-30" })), { status: 400 });
    assert.throws(() => timeline(db, params({ branch: "a".repeat(501) })), { status: 400 });
  });
});

test("optional missing and partial resource schemas expose coverage, not query failures", t => {
  fixture(t, db => db.exec(`DROP TABLE session_files; DROP TABLE session_refs;
    CREATE TABLE session_refs (session_id TEXT, ref_value TEXT)`))(db => {
    const data = timeline(db, params());
    assert.deepEqual(data.coverage, { filesAvailable: false, refsAvailable: false });
    assert.equal(data.nodes.filter(row => ["file", "ref"].includes(row.type)).length, 0);
    assert.equal(timeline(db, params({ file: "src/index.js" })).total, 0);
  });
});

test("graph has truthful session/resource/text caps and deterministic output", t => {
  fixture(t, db => {
    const insert = db.prepare("INSERT INTO sessions (id, summary, repository, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < 110; i++) insert.run(`synthetic-${i}`, "s".repeat(5000), "example/scoped", "2026-02-01", "2026-02-01");
    const file = db.prepare("INSERT INTO session_files (session_id, file_path) VALUES (?, ?)");
    for (let i = 0; i < 120; i++) file.run("synthetic-0", `src/file-${i}.js`);
  })(db => {
    const data = timeline(db, params());
    assert.equal(data.total, 114);
    assert.equal(data.sessions.length, 100);
    assert.equal(data.truncated, true);
    assert.equal(data.metadataTruncated, true);
    assert.ok(data.nodes.length <= 600);
    assert.ok(data.edges.length <= 1000);
    assert.ok(data.sessions.every(row => row.summary?.length <= 240));
    assert.deepEqual(data, timeline(db, params()));
  });
});

test("full PR URLs record a repository scope independent of session repository", t => {
  fixture(t, db => {
    db.exec("UPDATE session_refs SET ref_type = 'pr', ref_value = 'https://github.com/example/external/pull/42'");
  })(db => {
    assert.equal(timeline(db, params()).nodes.filter(row => row.type === "ref").length, 1);
  });
});

test("oversized graph metadata is omitted rather than forming clipped identities; minimal optional schemas work", t => {
  fixture(t, db => {
    db.exec(`DROP TABLE session_files; DROP TABLE session_refs;
      CREATE TABLE session_files (session_id TEXT, file_path TEXT);
      CREATE TABLE session_refs (session_id TEXT, ref_type TEXT, ref_value TEXT);
      INSERT INTO session_files VALUES ('demo-cache', 'src/synthetic.js');
      INSERT INTO session_refs VALUES ('demo-cache', 'pr', '7')`);
    db.prepare("INSERT INTO session_files VALUES ('demo-cache', ?)").run("x".repeat(70000));
    db.prepare("UPDATE sessions SET branch = ? WHERE id = 'demo-cache'").run("b".repeat(70000));
  })(db => {
    const data = timeline(db, params());
    assert.equal(data.coverage.filesAvailable, true);
    assert.equal(data.coverage.refsAvailable, true);
    assert.equal(data.metadataTruncated, true);
    assert.equal(data.sessions.find(row => row.id === "demo-cache").branch, null);
    assert.ok(data.nodes.some(row => row.label === "src/synthetic.js"));
    assert.ok(!JSON.stringify(data).includes("x".repeat(1001)));
    assert.ok(!JSON.stringify(data).includes("b".repeat(1001)));
  });
});

test("checkpoint comparison preserves exact null/whitespace and counts ordered-line replacements", t => {
  fixture(t, db => {
    db.exec(`INSERT INTO checkpoints (id, session_id, checkpoint_number, title, overview, history, work_done)
      VALUES (10, 'demo-cache', 2, 'Second', 'b
a
', '', NULL)`);
    db.prepare("UPDATE checkpoints SET overview = ?, history = NULL, work_done = ? WHERE id = 1").run("a\nb\n", " ");
  })(db => {
    const data = checkpointComparison(db, { session_id: "demo-cache", from: "1", to: 10 });
    const overview = data.fields.find(row => row.name === "overview");
    assert.equal(overview.before, "a\nb\n");
    assert.equal(overview.after, "b\na\n");
    assert.equal(overview.changed, true);
    assert.equal(overview.addedLines, 2);
    assert.equal(overview.removedLines, 2);
    const history = data.fields.find(row => row.name === "history");
    assert.equal(history.before, null);
    assert.equal(history.after, "");
    assert.equal(history.changed, true);
    assert.equal(data.fields.find(row => row.name === "work_done").before, " ");
    assert.match(data.diffMethod, /not minimal edits/);
    assert.equal(data.from.number, 1);
    assert.equal(data.to.number, 2);
    assert.ok(data.fields.every(row => typeof row.before_html === "string"));
  });
});

test("checkpoint comparison validates ownership and input; unchanged comparisons stay unchanged", t => {
  fixture(t)(db => {
    for (const body of [null, [], { session_id: "", from: 1, to: 1 },
      { session_id: "demo-cache", from: {}, to: 1 }]) {
      assert.throws(() => checkpointComparison(db, body), { status: 400 });
    }
    assert.throws(() => checkpointComparison(db, { session_id: "demo-cache", from: 1, to: 2 }), { status: 404 });
    assert.throws(() => checkpointComparison(db, { session_id: "absent", from: 1, to: 1 }), { status: 404 });
    assert.ok(checkpointComparison(db, { session_id: "demo-cache", from: 1, to: 1 })
      .fields.every(row => !row.changed && row.addedLines === 0 && row.removedLines === 0));
  });
});

test("huge checkpoint fields are explicitly partial, changed beyond the prefix, and HTML sanitized", t => {
  fixture(t, db => {
    db.prepare("UPDATE checkpoints SET overview = ?, title = ? WHERE id = 1").run("x".repeat(70000) + "a", "t".repeat(70000));
    db.exec("INSERT INTO checkpoints SELECT 10, session_id, 2, title, overview, history, work_done, technical_details, important_files, next_steps, created_at FROM checkpoints WHERE id = 1");
    db.prepare("UPDATE checkpoints SET overview = ?, next_steps = ? WHERE id = 10").run("x".repeat(70000) + "b", "<script>synthetic</script>");
  })(db => {
    const data = checkpointComparison(db, { session_id: "demo-cache", from: 1, to: 10 });
    const field = data.fields.find(row => row.name === "overview");
    assert.equal(field.before.length, 16000);
    assert.equal(field.after.length, 16000);
    assert.equal(field.changed, true);
    assert.equal(field.beforeLength, 70001);
    assert.equal(field.countsPartial, true);
    assert.equal(data.truncated, true);
    assert.equal(data.from.title.length, 16000);
    assert.ok(!data.fields.find(row => row.name === "next_steps").after_html.includes("<script>"));
  });
});

test("context pack is deterministic extractive text with included-material sources and honest coverage", t => {
  fixture(t)(db => {
    const data = pack(db);
    assert.equal(data.tokenEstimate, Math.ceil(data.markdown.length / 4));
    assert.ok(data.tokenEstimate <= data.tokenBudget);
    assert.match(data.markdown, /First recorded user request/);
    assert.match(data.markdown, /Latest checkpoint \/ recorded next steps/);
    assert.match(data.markdown, /not verified AI conclusions/);
    assert.ok(data.sources.some(row => row.kind === "checkpoint" && row.source_id === "1"));
    for (const source of data.sources) {
      assert.equal(source.session_id, "demo-cache");
      assert.ok(data.markdown.includes(source.url));
      assert.ok(["session", "summary", "checkpoint", "user", "assistant"].includes(source.kind));
    }
    assert.equal(data.truncated, true, "only six of twelve recent turns are retained");
    assert.deepEqual(data, pack(db));
  });
});

test("minimal budgets include all selected session labels without exceeding exact character accounting", t => {
  fixture(t)(db => {
    for (const budget of [128, 129, 256, 1000]) {
      const data = pack(db, { session_ids: ["demo-cache", "demo-layout"], token_budget: budget });
      assert.ok(data.markdown.length <= budget * 4, `budget ${budget}`);
      assert.equal(data.selections.length, 2);
      assert.equal(data.sources.filter(row => row.kind === "session").length, 2);
      assert.ok(data.selections.every(row => row.truncated));
      assert.ok(data.sources.filter(row => row.kind !== "session").length <= data.selections.reduce((n, row) => n + row.includedExcerpts, 0));
    }
    const subset = pack(db, { session_ids: ["demo-tests", "demo-tests"] });
    assert.equal(subset.selections.length, 1);
    assert.ok(subset.sources.every(row => row.session_id === "demo-tests"));
    const four = pack(db, { session_ids: ["demo-cache", "demo-layout", "demo-tests", "demo-release"], token_budget: 128 });
    assert.equal(four.selections.length, 4);
    assert.ok(four.tokenEstimate <= 128);
  });
});

test("pattern-based redaction removes synthetic emails, home usernames, credentials and keys without anonymity claims", t => {
  const synthetic = `reader@example.invalid /Users/synthetic-user/project /home/synthetic-user/x C:\\Users\\synthetic-user\\x
api_key="SYNTHETIC_ONLY_VALUE" Bearer synthetic-only-token
ghp_SYNTHETIC_ONLY_TOKEN_1234567890 sk-SYNTHETIC_ONLY_TOKEN_1234567890
-----BEGIN PRIVATE KEY-----
SYNTHETIC-NOT-A-KEY
-----END PRIVATE KEY-----`;
  fixture(t, db => {
    db.prepare("UPDATE sessions SET summary = ? WHERE id = 'demo-cache'").run(synthetic);
    db.exec("DELETE FROM turns; DELETE FROM checkpoints");
  })(db => {
    const data = pack(db, { redact: true, token_budget: 512 });
    assert.ok(!data.markdown.includes("reader@example.invalid"));
    assert.ok(!data.markdown.includes("synthetic-user"));
    assert.ok(!data.markdown.includes("SYNTHETIC_ONLY_VALUE"));
    assert.ok(!data.markdown.includes("SYNTHETIC_ONLY_TOKEN"));
    assert.ok(!data.markdown.includes("SYNTHETIC-NOT-A-KEY"));
    assert.match(data.redactionNote, /not complete anonymity/);
    assert.match(data.markdown, /REDACTED/);
    assert.ok(data.tokenEstimate <= 512);
    assert.ok(pack(db).markdown.includes("reader@example.invalid"));
  });
});

test("query selects literal recent turn excerpts, while missing source fields remain explicitly unavailable", t => {
  fixture(t, db => {
    db.exec("DELETE FROM checkpoints WHERE session_id = 'demo-layout'; UPDATE sessions SET summary = NULL WHERE id = 'demo-layout'");
    db.prepare("UPDATE turns SET assistant_response = ? WHERE session_id = 'demo-layout' AND turn_index = 11").run("Synthetic unique-marker recorded response");
  })(db => {
    const data = pack(db, { session_ids: ["demo-layout"], query: "unique-marker" });
    assert.match(data.markdown, /Synthetic unique-marker/);
    assert.equal(data.selections[0].checkpointAvailable, false);
    assert.equal(data.selections[0].relevantTurns, 1);
    assert.ok(!data.sources.some(row => row.kind === "checkpoint" || row.kind === "summary"));
    assert.equal(pack(db, { query: "' OR 1=1 --" }).selections[0].relevantTurns, 0);
  });
});

test("large source bodies do not starve goal, checkpoint work/next steps and recent-turn categories", t => {
  fixture(t, db => {
    db.prepare("UPDATE sessions SET summary = ? WHERE id = 'demo-cache'").run("Synthetic summary ".repeat(10000));
    db.prepare("UPDATE checkpoints SET overview = ?, work_done = ?, next_steps = ? WHERE id = 1")
      .run("Recorded overview ".repeat(10000), "Recorded work ".repeat(10000), "Recorded next steps ".repeat(10000));
  })(db => {
    const data = pack(db, { token_budget: 4096 });
    assert.ok(data.tokenEstimate <= 4096);
    assert.equal(data.truncated, true);
    for (const label of ["First recorded user request", "recorded overview", "recorded work done",
      "recorded next steps", "Recent recorded assistant"]) assert.ok(data.markdown.includes(label));
    assert.ok(data.sources.some(row => row.kind === "user"));
    assert.ok(data.sources.some(row => row.kind === "checkpoint"));
    assert.ok(data.sources.some(row => row.kind === "assistant"));
    assert.match(data.markdown, /truncated/);
  });
});

test("Unicode checkpoint values are exact within SQL character limits; Unicode excerpt clipping is disclosed", t => {
  const title = "🌱".repeat(10000);
  fixture(t, db => {
    db.prepare("UPDATE checkpoints SET title = ? WHERE id = 1").run(title);
    db.prepare("UPDATE sessions SET summary = ? WHERE id = 'demo-cache'").run("🌱".repeat(7000));
    db.exec("DELETE FROM turns; DELETE FROM checkpoints WHERE id != 1");
  })(db => {
    const comparison = checkpointComparison(db, { session_id: "demo-cache", from: 1, to: 1 });
    assert.equal(comparison.from.title, title);
    assert.equal(comparison.from.titleTruncated, false);
    const data = pack(db);
    assert.equal(data.truncated, true);
    assert.match(data.markdown, /truncated/);
    assert.ok(data.tokenEstimate <= data.tokenBudget);
  });
});

test("context pack rejects missing IDs, invalid inputs, and budgets unable to represent all selections", t => {
  fixture(t, db => {
    const insert = db.prepare("INSERT INTO sessions (id) VALUES (?)");
    for (let i = 0; i < 5; i++) insert.run(`long-${i}-${"x".repeat(180)}`);
  })(db => {
    for (const body of [null, [], {}, { session_ids: [] }, { session_ids: ["demo-cache"], token_budget: 127, redact: true },
      { session_ids: ["demo-cache"], token_budget: 32001, redact: true },
      { session_ids: ["demo-cache"], token_budget: 128, redact: "yes" },
      { session_ids: ["demo-cache"], token_budget: 128, redact: true, query: {} }]) {
      assert.throws(() => contextPack(db, body), { status: 400 });
    }
    assert.throws(() => pack(db, { session_ids: ["absent"] }), { status: 404 });
    const ids = db.prepare("SELECT id FROM sessions WHERE id LIKE 'long-%' ORDER BY id").all().map(row => row.id);
    assert.throws(() => pack(db, { session_ids: ids, token_budget: 128 }), { status: 400 });
  });
});
