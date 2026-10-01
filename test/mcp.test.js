import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMemoryMcp } from "../scripts/mcp.js";
import { createApp } from "../server.js";
import { createDemo } from "../lib/demo-data.js";

test("stdio MCP exposes only bounded read-only context tools and preserves source bytes", async t => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-memory-test-"));
  const path = join(directory, "source.db");
  createDemo(path);
  const before = readFileSync(path);
  const app = createApp({ path, dataPath: join(directory, "state") });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "memory-test", version: "1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("scripts/mcp.js")],
    env: { COPILOT_MEMORY_URL: `http://127.0.0.1:${app.address().port}`, PATH: process.env.PATH } });
  t.after(async () => {
    await client.close();
    await new Promise(resolve => app.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 6);
  assert.ok(tools.tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const search = await client.callTool({ name: "search_history", arguments: { q: "cache", limit: 2 } });
  assert.equal(JSON.parse(search.content[0].text).group, "session");
  const session = await client.callTool({ name: "get_session", arguments: { id: "demo-cache", turn: 11 } });
  assert.equal(JSON.parse(session.content[0].text).offset, 10);
  const pack = await client.callTool({ name: "build_context_pack", arguments: { session_ids: ["demo-cache"] } });
  const output = JSON.parse(pack.content[0].text);
  assert.ok(output.tokenEstimate <= 4000);
  assert.match(output.markdown, /demo-cache/);
  const timeline = await client.callTool({ name: "project_timeline", arguments: { repository: "example/widget-api" } });
  assert.equal(JSON.parse(timeline.content[0].text).sessions.length, 2);
  const insights = await client.callTool({ name: "usage_insights", arguments: {} });
  assert.equal(JSON.parse(insights.content[0].text).available, true);
  assert.deepEqual(readFileSync(path), before);
});

test("MCP rejects nonlocal dashboards and URL credential/path tricks", () => {
  for (const url of ["https://example.com", "http://example.com", "http://localhost/private", "http://user:pass@localhost", "http://localhost/?x=1"]) {
    assert.throws(() => createMemoryMcp(url), /local loopback/);
  }
});
