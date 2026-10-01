import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createDemo } from "../lib/demo-data.js";
import { createIntelligence } from "../lib/intelligence.js";

// All history and HTTP responses are synthetic. No real backend or archive is used.
async function fixture(t, provider = "ollama") {
  const directory = resolve("test", `.intelligence-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const sourcePath = join(directory, "source.sqlite");
  const dataPath = join(directory, "ai-state");
  createDemo(sourcePath);
  const writer = new DatabaseSync(sourcePath);
  writer.exec("DELETE FROM turns WHERE turn_index != 0;");
  writer.close();
  const calls = [];
  const behavior = { failure: false, badVector: false, answer: "Synthesis: invalidate after successful writes [S1].",
    answers: [], delay: 0, failAt: Infinity, digest: "synthetic-weight-v1", redirect: false, onChat: null };
  let embeddings = 0;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path: req.url, method: req.method, body, authorization: req.headers.authorization });
    const respond = result => {
      if (!res.destroyed) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); }
    };
    if (behavior.failure) { res.writeHead(500); res.end(); return; }
    if (behavior.redirect) { res.writeHead(302, { Location: `${endpoint}/redirected` }); res.end(); return; }
    if (req.url === "/api/tags") return respond({ models: [
      { name: "nomic-embed-text:latest", digest: behavior.digest }, { name: "qwen2.5:3b", digest: "synthetic-chat-v1" },
    ] });
    if (req.url === "/api/show") return respond({
      capabilities: body.model === "nomic-embed-text:latest" ? ["embedding"] : ["completion"],
      model_info: { "bert.context_length": 2048 },
    });
    if (req.url === "/v1/models") return respond({ data: [
      { id: "nomic-embed-text:latest", capabilities: ["embedding"], context_length: 2048 },
      { id: "qwen2.5:3b", capabilities: ["completion"], context_length: 8192 },
    ] });
    if (["/api/embed", "/v1/embeddings"].includes(req.url)) {
      embeddings++;
      if (embeddings >= behavior.failAt) { res.writeHead(503); res.end(); return; }
      if (behavior.delay) await sleep(behavior.delay);
      const content = String(body.input).toLowerCase();
      const embedding = behavior.badVector ? [] :
        /\bcache\b|invalidation|eviction/.test(content) ? [1, 0, 0] :
          /responsive|notebook|editorial|archive/.test(content) ? [0, 1, 0] : [0, 0, 1];
      return respond(req.url === "/api/embed" ? { embeddings: [embedding] } : { data: [{ index: 0, embedding }] });
    }
    if (["/api/chat", "/v1/chat/completions"].includes(req.url)) {
      behavior.onChat?.();
      const content = behavior.answers.length ? behavior.answers.shift() : behavior.answer;
      return respond(req.url === "/api/chat" ? { message: { content } } :
        { choices: [{ message: { content } }] });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const instances = [];
  const open = () => {
    const ai = createIntelligence({ sourcePath, dataPath, endpoint });
    instances.push(ai);
    return ai;
  };
  const ai = open();
  t.after(async () => {
    await Promise.all(instances.map(instance => instance.close()));
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const configure = overrides => ai.configure({ provider, embeddingModel: "nomic-embed-text:latest", completionModel: "qwen2.5:3b", ...overrides });
  return { ai, open, directory, sourcePath, dataPath, endpoint, calls, behavior, configure,
    embeddings: () => embeddings,
    write: sql => { const db = new DatabaseSync(sourcePath); try { db.exec(sql); } finally { db.close(); } } };
}

async function finished(ai) {
  for (let i = 0; i < 1000; i++) {
    const status = ai.indexStatus();
    if (!status.running) return status;
    await sleep(5);
  }
  assert.fail("Index job did not finish.");
}

async function index(ai, body = {}) {
  const initial = ai.startIndex(body);
  assert.equal(initial.running, true);
  const status = await finished(ai);
  assert.equal(status.state, "complete", JSON.stringify(status));
  return status;
}

test("safe defaults, model discovery, validated atomic settings and strictly local endpoints", async t => {
  const f = await fixture(t);
  assert.equal(f.ai.settings().embeddingModel, "");
  assert.equal(f.ai.settings().automaticIndexing, false);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.ai.startIndex(), { code: "MODEL_NOT_CONFIGURED", status: 409 });
  for (const endpoint of [
    "https://example.com", "http://localhost.evil.test", "file:///etc/passwd",
    "http://user:password@localhost", "http://localhost?token=x", "http://localhost/#x",
    "http://192.168.1.2", "http://[::ffff:127.0.0.1]", "http://0.0.0.0",
  ]) {
    await assert.rejects(f.ai.configure({ endpoint }), { code: "INVALID_ENDPOINT" });
    await assert.rejects(f.ai.models({ endpoint }), { code: "INVALID_ENDPOINT" });
  }
  assert.equal(f.calls.length, 0, "remote endpoints must be rejected before fetch");
  for (const endpoint of ["http://localhost:11434", "http://127.9.8.7:11434", "http://[::1]:11434", "http://host.docker.internal:11434"]) {
    await f.ai.configure({ endpoint });
    assert.equal(f.ai.settings().endpoint, endpoint);
  }
  await f.ai.configure({ endpoint: f.endpoint });
  for (const body of [{ provider: "cloud" }, { apiKey: "secret" }, { embeddingContext: 10 }, { maxTokens: 5000 }, { completionModel: "\ninvalid" }]) {
    await assert.rejects(f.ai.configure(body), { status: 400 });
  }
  const found = await f.ai.models();
  assert.equal(found.recommendations.embeddingModel, "nomic-embed-text:latest");
  assert.equal(found.recommendations.completionModel, "qwen2.5:3b");
  assert.equal(found.models[0].contextLength, 2048);
  assert.equal(f.embeddings(), 0);
  const original = f.ai.settings().provider;
  assert.equal((await f.ai.models({ endpoint: f.endpoint, provider: "openai" })).provider, "openai");
  assert.equal(f.ai.settings().provider, original, "connection preview does not save settings");
  await f.configure();
  const persisted = JSON.parse(readFileSync(join(f.dataPath, "settings.json"), "utf8"));
  assert.equal(persisted.embeddingModel, "nomic-embed-text:latest");
  assert.equal(persisted.index, undefined);
  await f.ai.close();
  assert.equal(f.open().settings().completionModel, "qwen2.5:3b");
});

test("explicit full indexing is bounded, read-only, incremental and detects configuration staleness", async t => {
  const f = await fixture(t);
  const original = readFileSync(f.sourcePath);
  await f.configure();
  await assert.rejects(f.ai.hybridSearch(new URLSearchParams({ q: "cache" })), { code: "INDEX_NOT_READY" });
  assert.equal(f.embeddings(), 0);
  const first = await index(f.ai);
  assert.equal(first.total, 16);
  assert.equal(first.processed, 16);
  assert.equal(first.indexed, 16);
  assert.equal(first.truncated, false);
  assert.equal(first.chunkChars, 480);
  const count = f.embeddings();
  assert.ok(count >= 16);
  assert.ok(f.calls.filter(c => c.path === "/api/embed").every(c =>
    c.body.truncate === false && c.body.input.length <= 480 && c.body.options.num_ctx === 2048));
  const second = await index(f.ai);
  assert.equal(f.embeddings(), count);
  assert.equal(second.embeddedChunks, 0);
  assert.equal(second.reusedChunks, count);
  assert.deepEqual(readFileSync(f.sourcePath), original);
  await f.ai.configure({ maxTokens: 256 });
  assert.equal(f.ai.indexStatus().state, "stale");
  await assert.rejects(f.ai.hybridSearch(new URLSearchParams({ q: "cache" })), { code: "INDEX_STALE" });
  await f.ai.close();
  const reopened = f.open();
  assert.equal(reopened.indexStatus().stale, true);
  await index(reopened);
  assert.ok(f.embeddings() > count);
});

test("hybrid ranking, session grouping, honest pagination and source/repository/date filters", async t => {
  const f = await fixture(t);
  await f.configure();
  await index(f.ai);
  const literal = await f.ai.hybridSearch(new URLSearchParams({ q: "cache invalidation" }));
  assert.equal(literal.group, "session");
  assert.equal(literal.results[0].session_id, "demo-cache");
  assert.equal(literal.results[0].literal_match, true);
  assert.ok(literal.results[0].match_count >= 2);
  const synonym = await f.ai.hybridSearch(new URLSearchParams({ q: "eviction" }));
  assert.equal(synonym.results[0].session_id, "demo-cache");
  assert.equal(synonym.results[0].literal_match, false);
  assert.equal(synonym.retrieval.semantic, true);
  const filtered = await f.ai.hybridSearch(new URLSearchParams({
    q: "eviction", repository: "example/widget-api", kind: "user", from: "2026-01-20", to: "2026-01-20",
  }));
  assert.equal(filtered.total, 1);
  assert.equal(filtered.totalEntries, 1);
  assert.equal(filtered.results[0].source_id, "1");
  assert.equal(filtered.results[0].turn_index, 0);
  assert.equal(filtered.results[0].kind, "user");
  const absent = await f.ai.hybridSearch(new URLSearchParams({ q: "eviction", repository: "missing" }));
  assert.equal(absent.total, 0);
  const all = await f.ai.hybridSearch(new URLSearchParams({ q: "implementation" }));
  const page = await f.ai.hybridSearch(new URLSearchParams({ q: "implementation", limit: "1", offset: "1" }));
  assert.equal(page.total, all.total);
  assert.equal(page.totalEntries, all.totalEntries);
  assert.deepEqual(page.results, all.results.slice(1, 2));
  assert.equal(all.results.reduce((sum, row) => sum + row.match_count, 0), all.totalEntries);
  const recent = await f.ai.hybridSearch(new URLSearchParams());
  assert.equal(recent.total, 4);
  assert.equal(recent.retrieval.mode, "recent");
  for (const params of [{ q: "x".repeat(201) }, { q: "cache", kind: "fake" },
    { q: "cache", limit: "0" }, { q: "cache", offset: "-1" }, { q: "cache", from: "2026-02-30" },
    { q: "cache", from: "2026-03-01", to: "2026-02-01" }]) {
    await assert.rejects(f.ai.hybridSearch(new URLSearchParams(params)), { status: 400 });
  }
});

test("subset coverage is explicit, changes reuse chunks, removed or changed records cannot be cited", async t => {
  const f = await fixture(t);
  await f.configure();
  const subset = await index(f.ai, { maxEntries: 2 });
  assert.equal(subset.total, 16);
  assert.equal(subset.indexed, 2);
  assert.equal(subset.truncated, true);
  assert.equal(subset.scope.maxEntries, 2);
  const partial = await f.ai.hybridSearch(new URLSearchParams({ q: "eviction" }));
  assert.equal(partial.retrieval.indexedEntries, 2);
  assert.equal(partial.retrieval.sourceEntries, 16);
  assert.equal(partial.retrieval.truncated, true);
  await index(f.ai);
  const before = f.embeddings();
  f.write("UPDATE turns SET user_message='cache invalidation updated synthetic' WHERE id=1;");
  const changed = await f.ai.hybridSearch(new URLSearchParams({ q: "eviction", kind: "user" }));
  assert.equal(changed.total, 0);
  assert.equal(changed.retrieval.excludedChangedSources, 1);
  await index(f.ai);
  assert.equal(f.embeddings(), before + 2, "one query embedding and one changed chunk");
  f.write("DELETE FROM turns WHERE id=1;");
  const removed = await f.ai.hybridSearch(new URLSearchParams({ q: "eviction", kind: "user" }));
  assert.equal(removed.total, 0);
  const completed = await index(f.ai);
  assert.equal(completed.total, 14);
  assert.equal(completed.indexed, 14);
  const state = new DatabaseSync(join(f.dataPath, "semantic-index.sqlite"), { readOnly: true });
  try {
    assert.equal(state.prepare("SELECT COUNT(*) AS n FROM records WHERE source_id='1' AND kind IN ('user','assistant')").get().n, 0);
    assert.equal(state.prepare("SELECT COUNT(*) AS n FROM chunks WHERE record_id NOT IN (SELECT id FROM records)").get().n, 0);
  } finally { state.close(); }
});

test("failed jobs resume completed chunks; cancel and restart never leave a permanent running flag", async t => {
  const f = await fixture(t);
  await f.configure();
  f.behavior.failAt = 4;
  f.ai.startIndex();
  const failed = await finished(f.ai);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "BACKEND_FAILURE");
  assert.equal(failed.resumable, true);
  f.behavior.failAt = Infinity;
  const resumed = await index(f.ai);
  assert.ok(resumed.reusedChunks >= 3);
  f.write("UPDATE turns SET user_message='cache cancellation fixture' WHERE id=1;");
  f.behavior.delay = 100;
  f.ai.startIndex();
  await assert.rejects(f.ai.configure({ completionModel: "" }), { code: "INDEX_BUSY" });
  assert.throws(() => f.ai.startIndex(), { code: "INDEX_BUSY" });
  f.ai.startIndex({ cancel: true });
  assert.equal((await finished(f.ai)).state, "cancelled");
  f.behavior.delay = 0;
  await index(f.ai);
  await f.ai.close();
  // Simulate process loss after the last persisted progress update, without killing a process.
  const state = new DatabaseSync(join(f.dataPath, "semantic-index.sqlite"));
  const old = JSON.parse(state.prepare("SELECT value FROM state").get().value);
  state.prepare("UPDATE state SET value=?").run(JSON.stringify({ ...old, state: "running" }));
  state.close();
  const reopened = f.open();
  assert.equal(reopened.indexStatus().state, "interrupted");
  assert.equal(reopened.indexStatus().running, false);
  assert.equal(reopened.indexStatus().resumable, true);
  assert.equal((await index(reopened)).embeddedChunks, 0);
});

test("Ollama ask is bounded, citation-backed, sanitized and rejects invented/absent citations", async t => {
  const f = await fixture(t);
  await f.configure();
  await index(f.ai);
  const answer = await f.ai.ask({ question: "cache invalidation", repository: "example/widget-api", kind: "user", limit: 1 });
  assert.match(answer.answer, /\[S1\]/);
  assert.equal(answer.citations.length, 1);
  assert.deepEqual(answer.citations[0], {
    id: "S1", session_id: "demo-cache", turn_index: 0, kind: "user", source_id: "1",
    summary: "A cache that knows when to let go.", excerpt: "Design a cache invalidation strategy for the widget API.",
  });
  assert.match(answer.notice, /synthesis\/inference/i);
  const chat = f.calls.find(c => c.path === "/api/chat");
  assert.equal(chat.body.stream, false);
  assert.equal(chat.body.options.num_predict, 512);
  assert.match(chat.body.messages[0].content, /untrusted DATA/);
  const prompt = JSON.parse(chat.body.messages[1].content);
  assert.equal(prompt.sources.length, 1);
  assert.equal(prompt.sources[0].label, "S1");
  for (const invalid of ["Unsupported [S99]", "No sources.", "Malicious [S01]", "Malformed [S-1]"]) {
    f.behavior.answer = invalid;
    await assert.rejects(f.ai.ask({ question: "cache invalidation" }), { code: "UNGROUNDED_ANSWER", status: 502 });
  }
  f.behavior.answer = "<script>bad()</script> Synthesis [S1]";
  assert.doesNotMatch((await f.ai.ask({ question: "cache invalidation" })).answer_html, /<script>/);
  await assert.rejects(f.ai.ask({ question: "cache", repository: "absent" }), { code: "NO_SOURCES" });
  await assert.rejects(f.ai.ask({ question: "x".repeat(201) }), { status: 400 });
  await assert.rejects(f.ai.ask({ question: "cache", limit: 9 }), { status: 400 });
});

test("OpenAI-compatible local requests use installed models and correct provider payloads", async t => {
  const f = await fixture(t, "openai");
  await f.configure({ endpoint: `${f.endpoint}/v1` });
  await index(f.ai);
  await f.ai.hybridSearch(new URLSearchParams({ q: "eviction" }));
  const answer = await f.ai.ask({ question: "cache invalidation" });
  assert.ok(answer.citations.length);
  assert.ok(f.calls.every(c => c.path.startsWith("/v1/")));
  assert.ok(f.calls.every(c => c.authorization === undefined));
  const embedding = f.calls.find(c => c.path === "/v1/embeddings");
  assert.equal(embedding.body.model, "nomic-embed-text:latest");
  assert.equal(embedding.body.encoding_format, "float");
  const chat = f.calls.find(c => c.path === "/v1/chat/completions");
  assert.equal(chat.body.model, "qwen2.5:3b");
  assert.equal(chat.body.max_tokens, 512);
  assert.equal(chat.body.stream, false);
  const preview = await f.ai.models({ endpoint: f.endpoint, provider: "openai" });
  assert.equal(preview.models.length, 2);
  assert.ok(f.calls.some(c => c.path === "/v1/models"));
});

test("structured claims retain model-selected original citations and allow exactly one bounded repair", async t => {
  const f = await fixture(t);
  await f.configure();
  await index(f.ai);
  const structured = JSON.stringify({ claims: [
    { text: "Synthesis: design resource-key invalidation after writes.", source_ids: ["S1"] },
  ] });
  f.behavior.answer = structured;
  let before = f.calls.filter(c => c.path === "/api/chat").length;
  const first = await f.ai.ask({ question: "cache invalidation", kind: "user", limit: 1 });
  assert.match(first.answer, /writes\. \[S1\]/);
  assert.equal(first.citations[0].source_id, "1");
  assert.equal(f.calls.filter(c => c.path === "/api/chat").length - before, 1);
  const initial = f.calls.find(c => c.path === "/api/chat");
  assert.deepEqual(initial.body.format.properties.claims.items.properties.source_ids.items.enum, ["S1"]);

  before = f.calls.filter(c => c.path === "/api/chat").length;
  f.behavior.answers = ["Missing references.", structured];
  const repaired = await f.ai.ask({ question: "cache invalidation", kind: "user", limit: 1 });
  assert.equal(repaired.citations[0].source_id, "1");
  const attempts = f.calls.filter(c => c.path === "/api/chat").slice(before);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].body.messages[1].content, attempts[1].body.messages[1].content, "repair has exactly the same bounded evidence");
  assert.match(attempts[1].body.messages[0].content, /Repair:/);
  assert.equal(attempts[0].body.options.num_predict, attempts[1].body.options.num_predict);

  for (const claims of [
    [{ text: "Invented source.", source_ids: ["S99"] }],
    [{ text: "Uncited statement.", source_ids: [] }],
    [{ text: "Invented inline reference [S99].", source_ids: ["S1"] }],
    [{ text: "Noncanonical label.", source_ids: ["S01"] }],
    [{ text: "A concise evidence-based claim", source_ids: ["S1"] }],
  ]) {
    before = f.calls.filter(c => c.path === "/api/chat").length;
    f.behavior.answer = JSON.stringify({ claims });
    await assert.rejects(f.ai.ask({ question: "cache invalidation", kind: "user", limit: 1 }),
      { code: "UNGROUNDED_ANSWER", status: 502 });
    assert.equal(f.calls.filter(c => c.path === "/api/chat").length - before, 2);
  }
  f.behavior.answer = '{"claims":';
  await assert.rejects(f.ai.ask({ question: "cache invalidation", kind: "user", limit: 1 }), { code: "UNGROUNDED_ANSWER" });
});

test("backend failures and unavailable models are explicit, never lexical pretend-semantic success", async t => {
  const f = await fixture(t);
  await f.configure({ embeddingModel: "missing" });
  f.ai.startIndex();
  assert.equal((await finished(f.ai)).error.code, "MODEL_NOT_INSTALLED");
  await f.configure({ embeddingModel: "qwen2.5:3b" });
  f.ai.startIndex();
  assert.equal((await finished(f.ai)).error.code, "MODEL_CAPABILITY");
  await f.configure();
  f.behavior.badVector = true;
  f.ai.startIndex();
  assert.equal((await finished(f.ai)).error.code, "BACKEND_INVALID_RESPONSE");
  f.behavior.badVector = false;
  await index(f.ai);
  f.behavior.failure = true;
  await assert.rejects(f.ai.models(), { code: "BACKEND_FAILURE" });
  await assert.rejects(f.ai.hybridSearch(new URLSearchParams({ q: "cache" })), { code: "BACKEND_FAILURE", status: 502 });
  await assert.rejects(f.ai.ask({ question: "cache" }), { code: "BACKEND_FAILURE" });
  assert.equal((await f.ai.hybridSearch(new URLSearchParams())).retrieval.mode, "recent");
  f.behavior.failure = false;
  f.behavior.redirect = true;
  const prior = f.calls.length;
  await assert.rejects(f.ai.models(), { code: "BACKEND_UNAVAILABLE", status: 503 });
  assert.equal(f.calls.length, prior + 1, "redirect:error does not follow local or remote redirects");
});

test("model weight fingerprints invalidate reuse, force rebuild works and context/input are bounded", async t => {
  const f = await fixture(t);
  await f.configure();
  const first = await index(f.ai);
  const before = f.embeddings();
  f.behavior.digest = "synthetic-weight-v2";
  await assert.rejects(f.ai.hybridSearch(new URLSearchParams({ q: "cache" })), { code: "INDEX_STALE" });
  const updated = await index(f.ai);
  assert.notEqual(updated.backendModelIdentity, first.backendModelIdentity);
  assert.equal(updated.reusedChunks, 0);
  assert.ok(f.embeddings() > before);
  assert.equal((await index(f.ai, { force: true })).reusedChunks, 0);
  await f.ai.configure({ embeddingContext: 512 });
  await index(f.ai);
  assert.ok(f.calls.filter(c => c.path === "/api/embed" && c.body.options.num_ctx === 512)
    .every(c => Buffer.byteLength(c.body.input) <= 384));
  await assert.rejects(f.ai.hybridSearch(new URLSearchParams({ q: "é".repeat(200) })), { status: 400 });
  await f.ai.configure({ maxTokens: 2048 });
  await index(f.ai);
  await assert.rejects(f.ai.ask({ question: "cache" }), { code: "MODEL_CONTEXT" });
});

test("evidence changed while generating is rejected and source aliases cannot become writable state", async t => {
  const f = await fixture(t);
  await f.configure();
  await index(f.ai);
  f.behavior.onChat = () => f.write("DELETE FROM turns WHERE id=1;");
  await assert.rejects(f.ai.ask({ question: "cache invalidation", kind: "user" }), { code: "SOURCE_CHANGED" });
  const symlinkDirectory = join(f.directory, "symlink-state");
  mkdirSync(symlinkDirectory);
  symlinkSync(f.sourcePath, join(symlinkDirectory, "semantic-index.sqlite"));
  assert.throws(() => createIntelligence({ sourcePath: f.sourcePath, dataPath: symlinkDirectory }), { code: "INVALID_INPUT" });
  const hardlinkDirectory = join(f.directory, "hardlink-state");
  mkdirSync(hardlinkDirectory);
  linkSync(f.sourcePath, join(hardlinkDirectory, "semantic-index.sqlite"));
  assert.throws(() => createIntelligence({ sourcePath: f.sourcePath, dataPath: hardlinkDirectory }), { code: "INVALID_INPUT" });
});

test("corrupt persisted settings and nonseparate state paths are rejected before use", async t => {
  const f = await fixture(t);
  assert.throws(() => createIntelligence({ sourcePath: f.sourcePath, dataPath: f.directory }), { status: 400 });
  await f.ai.close();
  writeFileSync(join(f.dataPath, "settings.json"), JSON.stringify({
    endpoint: "https://example.com", provider: "ollama", embeddingModel: "", completionModel: "", embeddingContext: 2048, maxTokens: 512,
  }));
  assert.throws(() => f.open(), { code: "INVALID_SETTINGS", status: 503 });
});

test("frontend chatModel alias, repository indexing scope, status aliases and ask token budgets", async t => {
  const f = await fixture(t);
  assert.equal((await f.ai.models({ provider: "ollama", endpoint: f.endpoint })).models[0].name, "nomic-embed-text:latest");
  const configured = await f.ai.configure({
    provider: "ollama", endpoint: f.endpoint, chatModel: "qwen2.5:3b", embeddingModel: "nomic-embed-text:latest",
  });
  assert.equal(configured.chatModel, "qwen2.5:3b");
  assert.equal(configured.index.configured, true);
  assert.equal(f.embeddings(), 0, "frontend configuration does not index automatically");
  await assert.rejects(f.ai.configure({ chatModel: "qwen2.5:3b", completionModel: "different" }), { status: 400 });
  const scoped = await index(f.ai, { repository: "example/widget-api" });
  assert.equal(scoped.scope.repository, "example/widget-api");
  assert.equal(scoped.total, 8);
  assert.equal(scoped.archiveTotal, 16);
  assert.equal(scoped.processed, 8);
  assert.equal(scoped.truncated, true);
  assert.equal(scoped.embedded, scoped.embeddedChunks);
  assert.equal(scoped.reused, scoped.reusedChunks);
  const result = await f.ai.hybridSearch(new URLSearchParams({ q: "cache", repository: "example/widget-api" }));
  assert.equal(result.retrieval.sourceEntries, 8);
  assert.equal(result.retrieval.archiveEntries, 16);
  assert.equal(result.retrieval.scope.repository, "example/widget-api");
  const answer = await f.ai.ask({ question: "cache invalidation", repository: "example/widget-api", token_budget: 2048 });
  assert.ok(answer.citations.length);
  for (const token_budget of [127, 32001, 2.5, "2048"]) {
    await assert.rejects(f.ai.ask({ question: "cache", token_budget }), { status: 400 });
  }
  await assert.rejects(f.ai.ask({ question: "cache", token_budget: 128 }), { code: "MODEL_CONTEXT" });
  assert.throws(() => f.ai.startIndex({ repository: 12 }), { status: 400 });
  assert.throws(() => f.ai.startIndex({ repository: "x".repeat(501) }), { status: 400 });
  const full = await index(f.ai, { repository: "" });
  assert.equal(full.total, 16);
  assert.equal(full.truncated, false);
  await f.ai.close();
  assert.equal(f.open().settings().chatModel, "qwen2.5:3b");
});
