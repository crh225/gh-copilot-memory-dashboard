import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AppError, databasePath, withStore, overview, search, session } from "./lib/store.js";
import { dashboard } from "./lib/usage.js";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/dashboard", ["index.html", "text/html; charset=utf-8"]],
  ["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/ui.js", ["ui.js", "text/javascript; charset=utf-8"]],
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

export function createApp({ path = databasePath() } = {}) {
  return createServer((req, res) => {
    try {
      const host = req.headers.host || "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
        throw new AppError(403, "LOCAL_ONLY", "Use localhost or a loopback address to access this app.");
      }
      if ((req.headers.origin && req.headers.origin !== `http://${host}`) ||
          req.headers["sec-fetch-site"] === "cross-site") {
        throw new AppError(403, "CROSS_ORIGIN", "Cross-origin requests are not allowed.");
      }
      if (req.method !== "GET") throw new AppError(405, "READ_ONLY", "Only GET requests are supported.");
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === "/api/health") {
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
}

export function start({ path = databasePath(), host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 3210) } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host)) throw new Error("HOST must be a loopback address or 0.0.0.0 for Docker.");
  const server = createApp({ path });
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
