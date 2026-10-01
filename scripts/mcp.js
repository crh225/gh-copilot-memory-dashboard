import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";

const string = { type: "string" };
const definitions = [
  ["search_history", "Search local history. Exact words by default; hybrid uses a configured local embedding index.",
    { q: string, repository: string, kind: string, from: string, to: string, hybrid: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, []],
  ["get_session", "Read a session page and its recorded checkpoints/files/references.", { id: string, offset: { type: "integer", minimum: 0 }, turn: { type: "integer", minimum: 0 } }, ["id"]],
  ["build_context_pack", "Build a bounded source-linked handoff. Token estimate and redaction are approximate; review before sharing.",
    { session_ids: { type: "array", items: string, minItems: 1, maxItems: 20 }, token_budget: { type: "integer", minimum: 128, maximum: 32000 }, redact: { type: "boolean" } }, ["session_ids"]],
  ["project_timeline", "Read recorded connections between sessions, repositories, files, branches and references.",
    { repository: string, file: string, branch: string, ref: string, from: string, to: string }, []],
  ["compare_checkpoints", "Compare recorded fields of two checkpoints in the same session.",
    { session_id: string, from: string, to: string }, ["session_id", "from", "to"]],
  ["usage_insights", "Inspect recorded token/cache/model activity and current-rate usage value, not billed spending.",
    { repository: string, from: string, to: string }, []],
];

export function createMemoryMcp(endpoint = process.env.COPILOT_MEMORY_URL || "http://127.0.0.1:3210") {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MCP must connect to a local loopback dashboard URL without credentials or path.");
  }
  const server = new Server({ name: "copilot-memory-local", version: "1.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map(([name, description, properties, required]) => ({
      name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const definition = definitions.find(([name]) => name === request.params.name);
    if (!definition) throw new Error("Unknown read-only history tool.");
    const args = request.params.arguments || {};
    if (Object.keys(args).some(key => !(key in definition[2])) ||
        definition[3].some(key => !(key in args))) throw new Error("Invalid history tool arguments.");
    for (const [name, value] of Object.entries(args)) {
      const type = definition[2][name];
      if ((type.type === "string" && typeof value !== "string") ||
          (type.type === "boolean" && typeof value !== "boolean") ||
          (type.type === "integer" && (!Number.isSafeInteger(value) || value < (type.minimum ?? 0) || value > (type.maximum ?? 1000000))) ||
          (type.type === "array" && (!Array.isArray(value) || value.length < type.minItems || value.length > type.maxItems || value.some(item => typeof item !== "string")))) {
        throw new Error(`Invalid ${name} argument.`);
      }
    }
    const routes = {
      search_history: args.hybrid ? "/api/hybrid-search" : "/api/search",
      get_session: "/api/session", build_context_pack: "/api/context-pack",
      project_timeline: "/api/timeline", compare_checkpoints: "/api/checkpoint-compare",
      usage_insights: "/api/usage-insights",
    };
    const path = new URL(routes[request.params.name], url);
    const post = ["build_context_pack", "compare_checkpoints"].includes(request.params.name);
    if (!post) {
      for (const [name, value] of Object.entries(args)) if (name !== "hybrid") path.searchParams.set(name, value);
      if (request.params.name === "search_history") path.searchParams.set("group", "session");
    }
    const response = await fetch(path, { redirect: "error", signal: AbortSignal.timeout(120000),
      ...(post ? { method: "POST", headers: { "Content-Type": "application/json", "X-Copilot-Memory": "local" },
        body: JSON.stringify(request.params.name === "build_context_pack" ? { token_budget: 4000, redact: true, ...args } : args) } : {}) });
    const data = await response.json();
    if (!response.ok) return { isError: true, content: [{ type: "text", text: data.error || "Local history request failed." }] };
    const text = JSON.stringify(data);
    if (text.length > 2000000) return { isError: true, content: [{ type: "text", text: "Context exceeds 2 MB. Narrow the query or use a smaller context pack." }] };
    return { content: [{ type: "text", text }] };
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createMemoryMcp();
  await server.connect(new StdioServerTransport());
}
