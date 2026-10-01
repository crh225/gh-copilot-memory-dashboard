import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, linkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNotebook } from "../lib/notebook.js";

test("notebook persists separately with editable decisions, tags, citations and safe Markdown", t => {
  const directory = mkdtempSync(`${tmpdir()}/notebook-test-`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let notebook = createNotebook(directory);
  const saved = notebook.save({ title: "Cache decision", body: "**Invalidate** after writes.", rationale: "Avoid stale reads.",
    tags: ["cache", "cache"], session_id: "demo-cache", source_kind: "assistant", source_id: "1", turn_index: 0 });
  assert.match(saved.body_html, /<strong>/);
  assert.deepEqual(saved.tags, ["cache"]);
  notebook.close();
  notebook = createNotebook(directory);
  t.after(() => notebook.close());
  assert.equal(notebook.get(saved.id).session_id, "demo-cache");
  assert.equal(notebook.list(new URLSearchParams({ q: "stale" })).total, 1);
  const updated = notebook.save({ ...saved, body: "<script>bad()</script>", status: "superseded" }, saved.id);
  assert.equal(updated.created_at, saved.created_at);
  assert.doesNotMatch(updated.body_html, /<script>/);
  notebook.remove(saved.id);
  assert.throws(() => notebook.get(saved.id), { code: "NOTE_NOT_FOUND" });
});

test("notebook rejects invalid records explicitly", t => {
  const directory = mkdtempSync(`${tmpdir()}/notebook-test-`);
  const notebook = createNotebook(directory);
  t.after(() => { notebook.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const record of [null, {}, { title: "A", kind: "other" }, { title: "A", tags: [1] },
    { title: "A", turn_index: -1 }, { title: "A", body: "x".repeat(30001) }]) {
    assert.throws(() => notebook.save(record), { status: 400 });
  }
});

test("notebook cannot open source history or symlink/hardlink aliases for writes", t => {
  const directory = mkdtempSync(`${tmpdir()}/notebook-test-`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source.db");
  writeFileSync(source, "Synthetic source must not be touched.");
  for (const kind of ["same", "symlink", "hardlink"]) {
    const dataPath = join(directory, kind);
    mkdirSync(dataPath);
    const target = join(dataPath, "notebook.sqlite");
    if (kind === "symlink") symlinkSync(source, target);
    else if (kind === "hardlink") linkSync(source, target);
    const before = readFileSync(source);
    assert.throws(() => createNotebook(dataPath, kind === "same" ? target : source), { code: "INVALID_STATE_DIRECTORY" });
    assert.deepEqual(readFileSync(source), before);
  }
});
