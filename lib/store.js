import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { renderMarkdown, renderExcerpt } from "./markdown.js";

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const required = {
  sessions: ["id", "summary", "repository", "branch", "cwd", "created_at", "updated_at"],
  turns: ["id", "session_id", "turn_index", "user_message", "assistant_response", "timestamp"],
  checkpoints: ["id", "session_id", "checkpoint_number", "title", "overview", "history",
    "work_done", "technical_details", "important_files", "next_steps", "created_at"],
};

const checkpointContent = `COALESCE(title, '') || char(10) || COALESCE(overview, '') || char(10) ||
  COALESCE(history, '') || char(10) || COALESCE(work_done, '') || char(10) ||
  COALESCE(technical_details, '') || char(10) || COALESCE(important_files, '') ||
  char(10) || COALESCE(next_steps, '')`;

const entryQueries = [
  `SELECT 'summary' AS kind, s.id AS source_id, s.id AS session_id,
      NULL AS turn_index, COALESCE(s.summary, '') AS content, s.updated_at AS date
    FROM sessions s WHERE COALESCE(s.summary, '') != ''`,
  `SELECT 'user' AS kind, CAST(t.id AS TEXT) AS source_id, t.session_id, t.turn_index,
      t.user_message AS content, t.timestamp AS date FROM turns t WHERE COALESCE(t.user_message, '') != ''`,
  `SELECT 'assistant' AS kind, CAST(t.id AS TEXT) AS source_id, t.session_id, t.turn_index,
      t.assistant_response AS content, t.timestamp AS date FROM turns t WHERE COALESCE(t.assistant_response, '') != ''`,
  `SELECT 'checkpoint' AS kind, CAST(c.id AS TEXT) AS source_id, c.session_id, NULL AS turn_index,
      ${checkpointContent} AS content, c.created_at AS date FROM checkpoints c`,
];

function integer(params, name, fallback, max) {
  const value = params.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new AppError(400, "INVALID_INPUT", `${name} must be an integer between 0 and ${max}.`);
  }
  return Number(value);
}

export function databasePath() {
  return resolve(process.env.COPILOT_DB_PATH || `${homedir()}/.copilot/session-store.db`);
}

export function withStore(path, callback) {
  if (!existsSync(path)) {
    throw new AppError(503, "DATABASE_NOT_FOUND",
      "No local Copilot CLI database found. Run a Copilot CLI session or set COPILOT_DB_PATH. In Docker, mount its directory at /data.");
  }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 3000 });
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    for (const [table, columns] of Object.entries(required)) {
      const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      if (!columns.every(column => present.has(column))) {
        throw new AppError(503, "UNSUPPORTED_SCHEMA",
          "This database does not have the supported Copilot CLI session-history schema. Extension databases and cloud memory are not supported.");
      }
    }
    return callback(db);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (!error.code?.startsWith("ERR_SQLITE")) throw error;
    console.error(`SQLite request failed (${error.code || "SQLITE_ERROR"}).`);
    if (error.errcode === 13) {
      throw new AppError(503, "DATABASE_STORAGE_FULL",
        "SQLite ran out of storage while reading the archive. Check free disk space and Docker temporary-storage limits. The source database is never modified.");
    }
    throw new AppError(503, "DATABASE_UNAVAILABLE",
      "The Copilot database could not be read. Check file permissions and mount the database directory with its WAL and SHM files. The source database is never modified.");
  } finally {
    db?.close();
  }
}

export function overview(db) {
  return {
    counts: {
      sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,
      turns: db.prepare("SELECT COUNT(*) AS n FROM turns").get().n,
      checkpoints: db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get().n,
      repositories: db.prepare("SELECT COUNT(DISTINCT repository) AS n FROM sessions WHERE COALESCE(repository, '') != ''").get().n,
    },
    repositories: db.prepare("SELECT DISTINCT repository FROM sessions WHERE COALESCE(repository, '') != '' ORDER BY repository").all().map(row => row.repository),
    lastActivity: db.prepare("SELECT MAX(updated_at) AS date FROM sessions").get().date,
    source: "Copilot CLI local session history",
    readOnly: true,
  };
}

export function readFilters(params) {
  const repository = params.get("repository") || "";
  if (repository.length > 500) throw new AppError(400, "INVALID_INPUT", "Repository filter is too long.");
  const filters = { repository };
  for (const name of ["from", "to"]) {
    const date = params.get(name) || "";
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date)) {
      throw new AppError(400, "INVALID_INPUT", `${name} must be a valid YYYY-MM-DD date.`);
    }
    filters[name] = date;
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new AppError(400, "INVALID_INPUT", "Start date must not be later than end date.");
  }
  return filters;
}

export function search(db, params) {
  const q = (params.get("q") || "").trim();
  const words = q.split(/\s+/).filter(Boolean);
  if (q.length > 200 || words.length > 12) {
    throw new AppError(400, "INVALID_INPUT", "Search accepts up to 200 characters and 12 words.");
  }
  const kind = params.get("kind") || "";
  const group = params.get("group") || "";
  if (!["", "session"].includes(group)) {
    throw new AppError(400, "INVALID_INPUT", "Unknown result grouping.");
  }
  if (!["", "summary", "user", "assistant", "checkpoint"].includes(kind)) {
    throw new AppError(400, "INVALID_INPUT", "Unknown source filter.");
  }
  const filters = readFilters(params);
  const clauses = [];
  const args = [];
  for (const word of words) {
    clauses.push("instr(lower(e.content), lower(?)) > 0");
    args.push(word);
  }
  if (kind) { clauses.push("e.kind = ?"); args.push(kind); }
  if (filters.repository) { clauses.push("s.repository = ?"); args.push(filters.repository); }
  for (const [name, op] of [["from", ">="], ["to", "<="]]) {
    const date = filters[name];
    if (!date) continue;
    clauses.push(`substr(e.date, 1, 10) ${op} ?`);
    args.push(date);
  }
  const limit = integer(params, "limit", 20, 50);
  if (limit === 0) throw new AppError(400, "INVALID_INPUT", "limit must be at least 1.");
  const offset = integer(params, "offset", 0, 1_000_000);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const selection = `
    SELECT e.kind, e.source_id, e.session_id, e.turn_index, e.date,
      length(e.content) AS content_length, substr(s.summary, 1, 180) AS summary,
      s.repository, s.branch`;
  // Project metadata before the UNION so SQLite never materializes all conversation bodies.
  const matched = `WITH matched AS (${entryQueries.map(source =>
    `${selection} FROM (${source}) e JOIN sessions s ON s.id = e.session_id ${where}`
  ).join(" UNION ALL ")})`;
  const bindings = entryQueries.flatMap(() => args);
  const counts = db.prepare(`${matched} SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions FROM matched`).get(...bindings);
  const total = group ? counts.sessions : counts.n;
  const rows = group
    ? db.prepare(`${matched}, ranked AS (
        SELECT *, COUNT(*) OVER (PARTITION BY session_id) AS match_count,
        ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY date DESC,
          CASE kind WHEN 'assistant' THEN 0 WHEN 'user' THEN 1 WHEN 'checkpoint' THEN 2 ELSE 3 END,
          source_id) AS rank
        FROM matched
      ) SELECT * FROM ranked WHERE rank = 1
      ORDER BY date DESC, session_id LIMIT ? OFFSET ?`).all(...bindings, limit, offset)
    : db.prepare(`${matched} SELECT * FROM matched
        ORDER BY date DESC, session_id, kind, source_id LIMIT ? OFFSET ?`
      ).all(...bindings, limit, offset);
  const sources = {
    summary: db.prepare("SELECT summary AS content FROM sessions WHERE id = ?"),
    user: db.prepare("SELECT user_message AS content FROM turns WHERE id = ?"),
    assistant: db.prepare("SELECT assistant_response AS content FROM turns WHERE id = ?"),
    checkpoint: db.prepare(`SELECT ${checkpointContent} AS content FROM checkpoints WHERE id = ?`),
  };
  return { results: rows.map(({ rank, ...row }) => {
    const text = sources[row.kind].get(row.source_id).content;
    return { ...row, ...renderExcerpt(text, words[0] || "") };
  }),
    total, totalEntries: counts.n, group, offset, limit, query: q };
}

export function session(db, params) {
  const id = params.get("id");
  if (!id || id.length > 200) throw new AppError(400, "INVALID_INPUT", "A valid session id is required.");
  const item = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!item) throw new AppError(404, "NOT_FOUND", "Session not found.");
  let offset = integer(params, "offset", 0, 1_000_000);
  if (params.has("turn")) {
    const turn = integer(params, "turn", 0, 1_000_000);
    offset = Math.floor(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND turn_index < ?").get(id, turn).n / 10) * 10;
  }
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  const files = tables.has("session_files")
    ? db.prepare("SELECT file_path, tool_name FROM session_files WHERE session_id = ? ORDER BY first_seen_at LIMIT 1001").all(id) : [];
  const refs = tables.has("session_refs")
    ? db.prepare("SELECT ref_type, ref_value FROM session_refs WHERE session_id = ? ORDER BY created_at LIMIT 1001").all(id) : [];
  return {
    session: item,
    turns: db.prepare("SELECT turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index LIMIT 10 OFFSET ?").all(id, offset)
      .map(turn => ({ ...turn, user_html: renderMarkdown(turn.user_message || ""),
        assistant_html: renderMarkdown(turn.assistant_response || "") })),
    totalTurns: db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(id).n,
    offset,
    limit: 10,
    checkpoints: db.prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number").all(id)
      .map(checkpoint => ({ ...checkpoint, html: Object.fromEntries(
        ["overview", "history", "work_done", "technical_details", "important_files", "next_steps"]
          .map(key => [key, renderMarkdown(checkpoint[key] || "")])) })),
    files: files.slice(0, 1000),
    refs: refs.slice(0, 1000),
    metadataTruncated: files.length > 1000 || refs.length > 1000,
  };
}
