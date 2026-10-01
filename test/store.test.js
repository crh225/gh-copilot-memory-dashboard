import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDemo } from "../lib/demo-data.js";
import { withStore, overview, search, session } from "../lib/store.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "memory-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "test.db");
  createDemo(path);
  return path;
}

test("async source reads retain a read-only connection across awaits and close it afterwards", async t => {
  const path = fixture(t);
  const before = readFileSync(path);
  let connection;
  const count = await withStore(path, async db => {
    connection = db;
    await new Promise(resolve => setImmediate(resolve));
    return db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  });
  assert.equal(count, 4);
  assert.throws(() => connection.prepare("SELECT 1"), /not open|closed/i);
  await assert.rejects(withStore(path, async db => {
    connection = db;
    await new Promise(resolve => setImmediate(resolve));
    db.exec("DELETE FROM sessions");
  }), { code: "DATABASE_UNAVAILABLE" });
  assert.throws(() => connection.prepare("SELECT 1"), /not open|closed/i);
  assert.deepEqual(readFileSync(path), before);
});

test("overview identifies the supported local archive", t => {
  withStore(fixture(t), db => {
    assert.deepEqual(overview(db).counts, { sessions: 4, turns: 48, checkpoints: 4, repositories: 3 });
    assert.equal(overview(db).readOnly, true);
  });
});

test("search matches all literal words, filters repository and source, and pages stably", t => {
  withStore(fixture(t), db => {
    const results = search(db, new URLSearchParams({ q: "CACHE invalidation", kind: "user", repository: "example/widget-api" }));
    assert.equal(results.total, 1);
    assert.equal(results.results[0].session_id, "demo-cache");
    assert.equal(search(db, new URLSearchParams({ q: "' OR 1=1 --" })).total, 0);
    assert.equal(search(db, new URLSearchParams({ q: "%" })).total, 0);
    assert.equal(search(db, new URLSearchParams({ q: "_" })).total, 0);
    const first = search(db, new URLSearchParams({ limit: 3 }));
    const second = search(db, new URLSearchParams({ limit: 3, offset: 3 }));
    assert.equal(first.total, 104);
    assert.equal(new Set([...first.results, ...second.results].map(row => `${row.kind}:${row.source_id}`)).size, 6);
    assert.ok(first.results.every(row => row.excerpt.length <= 650));
    const previews = search(db, new URLSearchParams({ kind: "assistant", q: "Implementation notes" }));
    assert.match(previews.results[0].excerpt_html, /<h2>Implementation notes<\/h2>/);
    assert.match(previews.results[0].excerpt_html, /language-javascript/);
  });
});

test("all checkpoint content is searchable and date filters include whole days", t => {
  withStore(fixture(t), db => {
    for (const q of ["TTL", "Explored", "Completed", "index.test.js", "Review edge"]) {
      assert.ok(search(db, new URLSearchParams({ q, kind: "checkpoint" })).total > 0);
    }
    const found = search(db, new URLSearchParams({ from: "2026-01-20", to: "2026-01-20" }));
    assert.equal(found.total, 26);
    assert.ok(found.results.every(row => row.date.startsWith("2026-01-20")));
  });

});

test("grouped search pages unique sessions without losing match counts or source filters", t => {
  withStore(fixture(t), db => {
    const grouped = search(db, new URLSearchParams({ group: "session", limit: "2" }));
    const next = search(db, new URLSearchParams({ group: "session", limit: "2", offset: "2" }));
    assert.equal(grouped.total, 4);
    assert.equal(grouped.totalEntries, 104);
    assert.equal(new Set([...grouped.results, ...next.results].map(row => row.session_id)).size, 4);
    assert.equal([...grouped.results, ...next.results].reduce((sum, row) => sum + row.match_count, 0), 104);
    const filtered = search(db, new URLSearchParams({ group: "session", kind: "user", q: "cache invalidation" }));
    assert.equal(filtered.total, 1);
    assert.equal(filtered.results[0].match_count, 1);
    assert.equal(filtered.results[0].kind, "user");
    assert.throws(() => search(db, new URLSearchParams({ group: "unknown" })), { status: 400 });
  });
});
test("bad input has explicit errors instead of empty-success results", t => {
  withStore(fixture(t), db => {
    for (const params of [
      { q: "a".repeat(201) }, { kind: "cloud" }, { offset: "-1" }, { limit: "0" },
      { limit: "51" }, { from: "2026-02-30" }, { from: "2026-02-01", to: "2026-01-01" },
    ]) {
      assert.throws(() => search(db, new URLSearchParams(params)), { status: 400 });
    }
    assert.throws(() => session(db, new URLSearchParams({ id: "missing" })), { status: 404 });
  });
});

test("session inspector returns checkpoints, metadata, and the page containing a matched turn", t => {
  withStore(fixture(t), db => {
    const data = session(db, new URLSearchParams({ id: "demo-cache", turn: "11" }));
    assert.equal(data.offset, 10);
    assert.equal(data.totalTurns, 12);
    assert.deepEqual(data.turns.map(row => row.turn_index), [10, 11]);
    assert.equal(data.checkpoints.length, 1);
    assert.equal(data.files[0].file_path, "src/index.js");
    assert.equal(data.refs[0].ref_value, "42");
  });
});

test("queries cannot write and leave the source database byte-for-byte unchanged", t => {
  const path = fixture(t);
  const before = readFileSync(path);
  withStore(path, db => {
    assert.throws(() => db.exec("DELETE FROM sessions"), /readonly|read-only/i);
    search(db, new URLSearchParams({ q: "cache" }));
    session(db, new URLSearchParams({ id: "demo-cache" }));
  });
  assert.deepEqual(readFileSync(path), before);
});

test("missing, corrupt, and unrelated extension databases report distinct errors", t => {
  const path = fixture(t);
  assert.throws(() => withStore(`${path}-missing`, overview), { code: "DATABASE_NOT_FOUND", status: 503 });
  const unrelated = new DatabaseSync(`${path}-other`);
  unrelated.exec("CREATE TABLE notes (content TEXT)");
  unrelated.close();
  assert.throws(() => withStore(`${path}-other`, overview), { code: "UNSUPPORTED_SCHEMA" });
  writeFileSync(`${path}-corrupt`, "This is not a SQLite database.");
  assert.throws(() => withStore(`${path}-corrupt`, overview), { code: "DATABASE_UNAVAILABLE" });
});

test("read-only connections see new committed WAL records without modifying the main file", t => {
  const path = fixture(t);
  const writer = new DatabaseSync(path);
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  const before = readFileSync(path);
  writer.prepare("INSERT INTO sessions (id, summary, created_at, updated_at) VALUES (?, ?, ?, ?)").run("wal-new", "A fresh WAL record", "2026-02-01", "2026-02-01");
  withStore(path, db => assert.equal(search(db, new URLSearchParams({ q: "fresh WAL" })).total, 1));
  assert.deepEqual(readFileSync(path), before);
});

test("optional files and references tables are not required", t => {
  const path = fixture(t);
  const writer = new DatabaseSync(path);
  writer.exec("DROP TABLE session_files; DROP TABLE session_refs;");
  writer.close();
  withStore(path, db => assert.deepEqual(session(db, new URLSearchParams({ id: "demo-cache" })).files, []));
});

test("SQLite storage exhaustion is not mislabeled as a permissions or WAL problem", t => {
  assert.throws(() => withStore(fixture(t), () => {
    throw Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 });
  }), { code: "DATABASE_STORAGE_FULL", status: 503 });
});
