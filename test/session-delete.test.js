import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDemo } from "../lib/demo-data.js";
import { createIntelligence } from "../lib/intelligence.js";
import { withStore, search } from "../lib/store.js";
import { createApp } from "../server.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "memory-delete-"));
  const path = join(directory, "session-store.db");
  const dataPath = join(directory, "dashboard");
  createDemo(path);
  const ai = createIntelligence({ sourcePath: path, dataPath });
  const db = new DatabaseSync(path);
  const index = new DatabaseSync(join(dataPath, "semantic-index.sqlite"));
  index.exec(`INSERT INTO records (id, session_id, complete) VALUES
    ('saved', 'demo-cache', 1), ('partial', 'demo-cache', 0), ('keep', 'demo-layout', 1);
    INSERT INTO chunks (record_id, part, text) VALUES
    ('saved', 0, 'private text'), ('partial', 0, 'partial text'), ('keep', 0, 'keep text');`);
  t.after(async () => {
    db.close();
    index.close();
    await ai.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, dataPath, ai, db, index };
}

test("session deletion removes all related history, FTS, usage, and complete or partial index rows", t => {
  const { ai, db, index, path } = fixture(t);
  db.exec(`CREATE VIRTUAL TABLE search_index USING fts5(content, session_id UNINDEXED);
    INSERT INTO search_index VALUES ('private text', 'demo-cache'), ('keep text', 'demo-layout');
    CREATE TRIGGER sessions_delete AFTER DELETE ON sessions BEGIN
      DELETE FROM search_index WHERE session_id = old.id; END;
    CREATE TABLE extra_history (session_id TEXT, value TEXT);
    INSERT INTO extra_history VALUES ('demo-cache', 'private text'), ('demo-layout', 'keep text');`);
  const result = ai.deleteSession("demo-cache");
  assert.equal(result.deleted, true);
  for (const table of ["turns", "checkpoints", "session_files", "session_refs", "assistant_usage_events", "search_index", "extra_history"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get("demo-cache").n, 0, table);
    assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get("demo-layout").n > 0, table);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 3);
  assert.equal(index.prepare("SELECT COUNT(*) AS n FROM records").get().n, 1);
  assert.equal(index.prepare("SELECT COUNT(*) AS n FROM chunks").get().n, 1);
  withStore(path, store => {
    assert.equal(search(store, new URLSearchParams({ q: "cache invalidation", kind: "user" })).total, 0);
    assert.throws(() => store.exec("DELETE FROM sessions"), /readonly|read-only/i);
  });
  assert.throws(() => ai.deleteSession("demo-cache"), { code: "SESSION_NOT_FOUND" });
  for (const id of ["", null, "x".repeat(201), "' OR 1=1 --"]) {
    assert.throws(() => ai.deleteSession(id), { status: id === "' OR 1=1 --" ? 404 : 400 });
  }
});

test("deletion supports stores without optional metadata and usage tables", t => {
  const { ai, db } = fixture(t);
  db.exec("DROP TABLE session_files; DROP TABLE session_refs; DROP TABLE assistant_usage_events;");
  assert.equal(ai.deleteSession("demo-cache").deleted, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'demo-cache'").get().n, 0);
});

test("related usage rows with restrictive turn foreign keys are deleted before turns", t => {
  const { ai, db } = fixture(t);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE turn_usage (session_id TEXT REFERENCES sessions(id),
      turn_id INTEGER REFERENCES turns(id) ON DELETE RESTRICT);
    INSERT INTO turn_usage VALUES ('demo-cache', 1), ('demo-layout', 13);`);
  assert.equal(ai.deleteSession("demo-cache").deleted, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM turn_usage").get().n, 1);
});

test("source failure rolls back source rows and intelligence cleanup together", t => {
  const { ai, db, index } = fixture(t);
  db.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON sessions BEGIN
    SELECT RAISE(ABORT, 'synthetic deletion failure'); END;`);
  assert.throws(() => ai.deleteSession("demo-cache"), { code: "SESSION_DELETE_FAILED" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'demo-cache'").get().n, 12);
  assert.equal(index.prepare("SELECT COUNT(*) AS n FROM records").get().n, 3);
  assert.equal(index.prepare("SELECT COUNT(*) AS n FROM chunks").get().n, 3);
  db.exec("DROP TRIGGER reject_delete");
  assert.equal(ai.deleteSession("demo-cache").deleted, true);
});

for (const locked of ["db", "index"]) {
  test(`a locked ${locked} denies deletion without partial cleanup`, t => {
    const f = fixture(t);
    f[locked].exec("BEGIN IMMEDIATE");
    try {
      assert.throws(() => f.ai.deleteSession("demo-cache"), { code: "SESSION_STORE_BUSY", status: 409 });
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 4);
      assert.equal(f.index.prepare("SELECT COUNT(*) AS n FROM records").get().n, 3);
    } finally {
      f[locked].exec("ROLLBACK");
    }
    assert.equal(f.ai.deleteSession("demo-cache").deleted, true);
  });
}

test("an exclusive source lock returns retry guidance rather than a read-permissions error", t => {
  const { ai, db } = fixture(t);
  db.exec("BEGIN EXCLUSIVE");
  try {
    assert.throws(() => ai.deleteSession("demo-cache"), { code: "SESSION_STORE_BUSY", status: 409 });
  } finally { db.exec("ROLLBACK"); }
  assert.equal(ai.deleteSession("demo-cache").deleted, true);
});

test("a read-only source denies deletion and preserves the index", t => {
  const { ai, db, index, path } = fixture(t);
  chmodSync(path, 0o400);
  try {
    assert.throws(() => ai.deleteSession("demo-cache"), { code: "SESSION_DELETE_FAILED", status: 503 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 4);
    assert.equal(index.prepare("SELECT COUNT(*) AS n FROM records").get().n, 3);
  } finally { chmodSync(path, 0o600); }
});

test("HTTP deletion requires local JSON and confirmation, retains artifacts and independent notes", async t => {
  const { directory, path, dataPath, db } = fixture(t);
  const artifact = join(directory, "session-state", "demo-cache", "events.jsonl");
  mkdirSync(join(directory, "session-state", "demo-cache"), { recursive: true });
  writeFileSync(artifact, "synthetic artifact");
  const server = createApp({ path, dataPath });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const route = `${url}/api/session?id=demo-cache`;
  const headers = { "Content-Type": "application/json", "X-Copilot-Memory": "local" };
  const send = (body, extra = {}) => fetch(route, { method: "DELETE", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const note = await fetch(`${url}/api/notebook`, { method: "POST", headers,
    body: JSON.stringify({ title: "Independent note", session_id: "demo-cache" }) });
  assert.equal(note.status, 200);
  assert.equal((await fetch(route, { method: "DELETE" })).status, 400);
  assert.equal((await send({ confirm: true }, { Origin: "https://example.com" })).status, 403);
  assert.equal((await send({ confirm: true }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await send({})).status, 400);
  assert.equal((await send({ confirm: "true" })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 4);
  const response = await send({ confirm: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    deleted: true, session_id: "demo-cache", artifactsRemoved: false, notebookNotesRemoved: false,
  });
  assert.equal((await fetch(route)).status, 404);
  assert.equal((await (await fetch(`${url}/api/overview`)).json()).counts.sessions, 3);
  assert.equal((await (await fetch(`${url}/api/notebook`)).json()).total, 1);
  assert.equal(readFileSync(artifact, "utf8"), "synthetic artifact");
  assert.equal((await send({ confirm: true })).status, 404);
  assert.equal((await fetch(`${url}/api/session?id=demo-layout`)).status, 200);
});
