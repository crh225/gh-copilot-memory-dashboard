import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createDemo } from "../lib/demo-data.js";
import { createApp } from "../server.js";

async function app(t, missing = false) {
  const directory = mkdtempSync(join(tmpdir(), "memory-http-"));
  const path = join(directory, "test.db");
  if (!missing) createDemo(path);
  const server = createApp({ path });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

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
