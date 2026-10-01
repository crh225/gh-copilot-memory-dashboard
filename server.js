import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError, databasePath, withStore, overview, search, session } from "./lib/store.js";
import { dashboard } from "./lib/usage.js";
import { createNotebook, validateNote } from "./lib/notebook.js";
import { createIntelligence } from "./lib/intelligence.js";
import { timeline, checkpointComparison, contextPack } from "./lib/workspace.js";
import { usageInsights } from "./lib/insights.js";
import { renderMarkdown } from "./lib/markdown.js";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/dashboard", ["index.html", "text/html; charset=utf-8"]],
  ["/workbench", ["index.html", "text/html; charset=utf-8"]],
  ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/ui.js", ["ui.js", "text/javascript; charset=utf-8"]],
  ["/workbench.js", ["workbench.js", "text/javascript; charset=utf-8"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/icons.svg", ["icons.svg", "image/svg+xml"]],
].map(([route, [file, type]]) => [route, {
  body: readFileSync(new URL(`./public/${file}`, import.meta.url)), type,
}]));

function respond(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function requestBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json") ||
      req.headers["x-copilot-memory"] !== "local") {
    throw new AppError(400, "LOCAL_REQUEST_REQUIRED", "Use JSON and the X-Copilot-Memory: local header for local tool requests.");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 200000) throw new AppError(413, "BODY_TOO_LARGE", "The request exceeds 200 KB.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError(400, "INVALID_JSON", "Request body must be valid JSON."); }
}

function verifySource(db, note) {
  if (!note.session_id) {
    if (note.source_id || note.kind === "pin") throw new AppError(400, "INVALID_SOURCE", "A pinned source must belong to a session.");
    return;
  }
  if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(note.session_id)) {
    throw new AppError(404, "SOURCE_NOT_FOUND", "The selected source session no longer exists.");
  }
  if (note.source_kind === "summary") {
    if (note.source_id && note.source_id !== note.session_id) throw new AppError(400, "INVALID_SOURCE", "Summary citation must identify its session.");
  } else {
    const table = note.source_kind === "checkpoint" ? "checkpoints" : "turns";
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND session_id = ?`).get(note.source_id, note.session_id);
    if (!row || (table === "turns" && note.turn_index !== null && note.turn_index !== row.turn_index)) {
      throw new AppError(400, "INVALID_SOURCE", "Source citation does not identify a record in this session.");
    }
  }
}

export function createApp({ path = databasePath(),
  dataPath = process.env.LOCAL_DATA_DIR || join(homedir(), ".local", "share", "copilot-memory-dashboard"),
  aiEndpoint = process.env.LOCAL_AI_URL } = {}) {
  let notebook;
  let intelligence;
  const notes = () => notebook ||= createNotebook(dataPath, path);
  const ai = () => intelligence ||= createIntelligence({ sourcePath: path, dataPath, endpoint: aiEndpoint });
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host || "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
        throw new AppError(403, "LOCAL_ONLY", "Use localhost or a loopback address to access this app.");
      }
      if ((req.headers.origin && req.headers.origin !== `http://${host}`) ||
          req.headers["sec-fetch-site"] === "cross-site") {
        throw new AppError(403, "CROSS_ORIGIN", "Cross-origin requests are not allowed.");
      }
      const url = new URL(req.url, `http://${host}`);
      const mutations = new Set(["/api/settings", "/api/index", "/api/ask", "/api/decision", "/api/context-pack", "/api/checkpoint-compare", "/api/notebook", "/api/render-markdown"]);
      const noteRoute = url.pathname.match(/^\/api\/notebook\/([a-zA-Z0-9-]{1,100})$/);
      if (req.method !== "GET") {
        if (!(req.method === "POST" && mutations.has(url.pathname)) &&
            !(noteRoute && ["PATCH", "DELETE"].includes(req.method))) {
          throw new AppError(405, "READ_ONLY", "Source history is read-only; this route does not accept writes.");
        }
        const body = await requestBody(req);
        let result;
        if (url.pathname === "/api/settings") result = await ai().configure(body);
        else if (url.pathname === "/api/index") result = ai().startIndex(body);
        else if (url.pathname === "/api/ask") result = await ai().ask(body);
        else if (url.pathname === "/api/decision") result = await ai().decide(body);
        else if (url.pathname === "/api/context-pack") result = withStore(path, db => contextPack(db, body));
        else if (url.pathname === "/api/checkpoint-compare") result = withStore(path, db => checkpointComparison(db, body));
        else if (url.pathname === "/api/render-markdown") {
          if (!body || typeof body.markdown !== "string" || body.markdown.length > 128000) throw new AppError(400, "INVALID_INPUT", "Markdown preview accepts at most 128,000 characters.");
          result = { html: renderMarkdown(body.markdown) };
        }
        else if (req.method === "DELETE") result = notes().remove(noteRoute[1]);
        else {
          const record = validateNote(body);
          withStore(path, db => verifySource(db, record));
          result = notes().save(record, noteRoute?.[1]);
        }
        respond(res, 200, result);
      } else if (url.pathname === "/api/settings") {
        respond(res, 200, await ai().settings());
      } else if (url.pathname === "/api/models") {
        respond(res, 200, await ai().models(Object.fromEntries(url.searchParams)));
      } else if (url.pathname === "/api/index") {
        respond(res, 200, await ai().indexStatus());
      } else if (url.pathname === "/api/hybrid-search") {
        respond(res, 200, await ai().hybridSearch(url.searchParams));
      } else if (url.pathname === "/api/notebook") {
        respond(res, 200, notes().list(url.searchParams));
      } else if (noteRoute) {
        respond(res, 200, notes().get(noteRoute[1]));
      } else if (url.pathname === "/api/timeline") {
        respond(res, 200, withStore(path, db => timeline(db, url.searchParams)));
      } else if (url.pathname === "/api/usage-insights") {
        respond(res, 200, withStore(path, db => usageInsights(db, url.searchParams)));
      } else if (url.pathname === "/api/health") {
        const data = withStore(path, () => ({ ok: true, readOnly: true }));
        respond(res, 200, data);
      } else if (url.pathname === "/api/overview") {
        respond(res, 200, withStore(path, overview));
      } else if (url.pathname === "/api/search") {
        respond(res, 200, withStore(path, db => search(db, url.searchParams)));
      } else if (url.pathname === "/api/session") {
        respond(res, 200, withStore(path, db => session(db, url.searchParams)));
      } else if (url.pathname === "/api/dashboard") {
        respond(res, 200, withStore(path, db => dashboard(db, url.searchParams)));
      } else if (assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        respond(res, 200, asset.body, asset.type);
      } else {
        throw new AppError(404, "NOT_FOUND", "Route not found.");
      }
    } catch (error) {
      if (error instanceof AppError) {
        respond(res, error.status, { error: error.message, code: error.code });
      } else {
        console.error("Unexpected server error:", error.name);
        respond(res, 500, { error: "Unexpected server error. See the local server log.", code: "INTERNAL_ERROR" });
      }
    }
  });
  server.once("close", () => { notebook?.close(); intelligence?.close(); });
  return server;
}

export function start({ path = databasePath(), dataPath, aiEndpoint, host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 3210) } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host)) throw new Error("HOST must be a loopback address or 0.0.0.0 for Docker.");
  const server = createApp({ path, dataPath, aiEndpoint });
  server.on("error", error => {
    console.error(`Server failed to start (${error.code}). Check PORT and whether another process is listening.`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`Copilot Memory Dashboard: http://localhost:${port} (read-only, no telemetry)`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
