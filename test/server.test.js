import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createDemo } from "../lib/demo-data.js";
import { createApp } from "../server.js";

async function app(t, missing = false, aiEndpoint) {
  const directory = mkdtempSync(join(tmpdir(), "memory-http-"));
  const path = join(directory, "test.db");
  if (!missing) createDemo(path);
  const server = createApp({ path, dataPath: join(directory, "state"), aiEndpoint });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("disconnecting a history request aborts outstanding local model inference", async t => {
  let started;
  let stopped;
  const received = new Promise(resolve => { started = resolve; });
  const disconnected = new Promise(resolve => { stopped = resolve; });
  const backend = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const respond = result => res.end(JSON.stringify(result));
    if (req.url === "/api/tags") return respond({ models: [{ name: "synthetic-embed", digest: "v1" }] });
    if (req.url === "/api/show") return respond({ capabilities: ["embedding"],
      model_info: { "synthetic.context_length": 2048 } });
    if (req.url === "/api/embed" && body.input === "api") {
      res.once("close", () => stopped(true));
      started();
      return;
    }
    if (req.url === "/api/embed") return respond({ embeddings: [[1, 0, 0]] });
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const url = await app(t, false, `http://127.0.0.1:${backend.address().port}`);
  const write = (path, body) => fetch(`${url}${path}`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Copilot-Memory": "local" }, body: JSON.stringify(body) });
  assert.equal((await write("/api/settings", { embeddingModel: "synthetic-embed" })).status, 200);
  assert.equal((await write("/api/index", {})).status, 200);
  let status;
  for (let i = 0; i < 200; i++) {
    status = await (await fetch(`${url}/api/index`)).json();
    if (!status.running) break;
    await sleep(10);
  }
  assert.equal(status.state, "complete");
  const controller = new AbortController();
  const pending = fetch(`${url}/api/hybrid-search?q=api`, { signal: controller.signal });
  assert.equal(await Promise.race([received.then(() => true), sleep(3000).then(() => false)]), true);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(await Promise.race([disconnected, sleep(3000).then(() => false)]), true);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
});

test("HTTP serves local assets and read-only API with private-response headers", async t => {
  const url = await app(t);
  const html = await fetch(url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Memory explorer\./);
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.match(html.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await (await fetch(`${url}/api/health`)).json()).readOnly, true);
  const search = await fetch(`${url}/api/search?q=cache&kind=user`);
  assert.equal((await search.json()).total, 1);
  assert.equal((await fetch(`${url}/api/session?id=demo-cache`)).status, 200);
  assert.equal((await fetch(`${url}/dashboard`)).status, 200);
  assert.equal((await (await fetch(`${url}/api/dashboard`)).json()).totals.metrics.inputTokens.total, 48000);
  assert.equal((await fetch(`${url}/api/search?limit=999`)).status, 400);
  assert.equal((await fetch(`${url}/api/other`)).status, 404);
  assert.equal((await fetch(`${url}/../package.json`)).status, 404);
});

test("write methods, cross-origin reads, and DNS-rebinding hosts are denied", async t => {
  const url = await app(t);
  assert.equal((await fetch(`${url}/api/search`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${url}/api/search`, { headers: { Origin: "https://example.com" } })).status, 403);
  assert.equal((await fetch(`${url}/api/search`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/search`, { headers: { Host: "attacker.example" } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${url}/api/search`, { headers: { Origin: url } })).status, 200);
});

test("the UI loads even when the database is missing and API explains setup", async t => {
  const url = await app(t, true);
  assert.equal((await fetch(url)).status, 200);
  const response = await fetch(`${url}/api/overview`);
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.code, "DATABASE_NOT_FOUND");
  assert.ok(!data.error.includes(tmpdir()));
});

test("context tools and separate notebook writes require explicit local JSON requests", async t => {
  const url = await app(t);
  const headers = { "Content-Type": "application/json", "X-Copilot-Memory": "local" };
  const send = (route, body, method = "POST") => fetch(`${url}${route}`, { method, headers, body: JSON.stringify(body) });
  assert.equal((await fetch(`${url}/workbench`)).status, 200);
  assert.equal((await fetch(`${url}/api/timeline?repository=example/widget-api`)).status, 200);
  assert.equal((await fetch(`${url}/api/usage-insights`)).status, 200);
  assert.equal((await fetch(`${url}/api/settings`)).status, 200);
  assert.equal((await fetch(`${url}/api/index`)).status, 200);
  const note = { title: "Synthetic décision", kind: "pin", session_id: "demo-cache", source_kind: "assistant", source_id: "1", turn_index: 0 };
  assert.equal((await fetch(`${url}/api/notebook`, { method: "POST", body: JSON.stringify(note) })).status, 400);
  assert.equal((await fetch(`${url}/api/notebook`, { method: "POST", headers: { ...headers, Origin: "https://example.com" }, body: JSON.stringify(note) })).status, 403);
  const saved = await (await send("/api/notebook", note)).json();
  assert.equal(saved.title, note.title);
  assert.equal((await send("/api/notebook", { ...note, session_id: "demo-layout" })).status, 400);
  const updated = await send(`/api/notebook/${saved.id}`, { ...note, title: "Updated" }, "PATCH");
  assert.equal((await updated.json()).title, "Updated");
  assert.equal((await (await fetch(`${url}/api/notebook`)).json()).total, 1);
  assert.equal((await send(`/api/notebook/${saved.id}`, {}, "DELETE")).status, 200);
  const pack = await send("/api/context-pack", { session_ids: ["demo-cache"], token_budget: 512, redact: true });
  assert.ok((await pack.json()).tokenEstimate <= 512);
  const html = await (await send("/api/render-markdown", { markdown: "**Decision**\n\n<script>bad()</script>" })).json();
  assert.match(html.html, /<strong>/);
  assert.doesNotMatch(html.html, /<script>/);
  const rejected = await send("/api/settings", { provider: "ollama", endpoint: "https://example.com", chatModel: "a", embeddingModel: "b" });
  assert.equal(rejected.status, 400);
  assert.equal((await send("/api/render-markdown", { markdown: "x".repeat(200001) })).status, 413);
});

test("decision generation uses the protected local JSON route and reports missing configuration explicitly", async t => {
  const url = await app(t);
  const headers = { "Content-Type": "application/json", "X-Copilot-Memory": "local" };
  const body = JSON.stringify({ question: "Are cached reads invalidated after writes?" });
  assert.equal((await fetch(`${url}/api/decision`, { method: "POST", body })).status, 400);
  assert.equal((await fetch(`${url}/api/decision`, { method: "POST",
    headers: { ...headers, Origin: "https://example.com" }, body })).status, 403);
  const response = await fetch(`${url}/api/decision`, { method: "POST", headers, body });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "DECISION_NOT_CONFIGURED");
  const invalid = await fetch(`${url}/api/decision`, { method: "POST", headers,
    body: JSON.stringify({ question: "" }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_INPUT");
});
