import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./store.js";
import { renderMarkdown } from "./markdown.js";

function text(input, name, max, required = false) {
  const value = input[name] ?? "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new AppError(400, "INVALID_NOTE", `${name} must be ${required ? "nonempty " : ""}text of at most ${max} characters.`);
  }
  return value.trim();
}

export function validateNote(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError(400, "INVALID_NOTE", "A notebook record is required.");
  const kind = input.kind ?? "decision";
  const status = input.status ?? "active";
  if (!["pin", "decision"].includes(kind) || !["active", "superseded"].includes(status)) {
    throw new AppError(400, "INVALID_NOTE", "Unknown notebook kind or status.");
  }
  const source_kind = input.source_kind ?? "summary";
  if (!["summary", "user", "assistant", "checkpoint"].includes(source_kind)) {
    throw new AppError(400, "INVALID_NOTE", "Unknown source kind.");
  }
  const turn_index = input.turn_index ?? null;
  if (turn_index !== null && (!Number.isSafeInteger(turn_index) || turn_index < 0)) {
    throw new AppError(400, "INVALID_NOTE", "Turn index must be a nonnegative integer.");
  }
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 10 || tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 80)) {
    throw new AppError(400, "INVALID_NOTE", "Use at most ten nonempty tags, each under 80 characters.");
  }
  return {
    kind, status, source_kind, turn_index,
    title: text(input, "title", 300, true), body: text(input, "body", 30000),
    rationale: text(input, "rationale", 10000), session_id: text(input, "session_id", 200),
    source_id: text(input, "source_id", 200), tags: [...new Set(tags.map(tag => tag.trim()))],
  };
}

export function createNotebook(dataPath, sourcePath) {
  const path = join(dataPath, "notebook.sqlite");
  if (sourcePath) {
    const source = existsSync(sourcePath) ? realpathSync(sourcePath) : resolve(sourcePath);
    const sourceStat = existsSync(sourcePath) ? statSync(sourcePath) : null;
    for (const target of [path, `${path}-wal`, `${path}-shm`]) {
      const resolved = existsSync(target) ? realpathSync(target) : resolve(target);
      const targetStat = existsSync(target) ? statSync(target) : null;
      if (resolved === source || (sourceStat && targetStat && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)) {
        throw new AppError(400, "INVALID_STATE_DIRECTORY", "Notebook storage must be separate from the Copilot source database and its aliases.");
      }
    }
  }
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, rationale TEXT NOT NULL, tags TEXT NOT NULL,
      session_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
      turn_index INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  const shape = row => ({ ...row, tags: JSON.parse(row.tags),
    body_html: renderMarkdown(row.body), rationale_html: renderMarkdown(row.rationale) });
  const get = id => {
    const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    if (!row) throw new AppError(404, "NOTE_NOT_FOUND", "Notebook record not found.");
    return shape(row);
  };
  return {
    get,
    list(params = new URLSearchParams()) {
      const q = params.get("q") || "";
      if (q.length > 200) throw new AppError(400, "INVALID_NOTE", "Notebook query is too long.");
      const where = "WHERE instr(lower(title || ' ' || body || ' ' || rationale || ' ' || tags), lower(?)) > 0";
      const total = db.prepare(`SELECT COUNT(*) AS total FROM notes ${where}`).get(q).total;
      const rows = db.prepare(`SELECT * FROM notes ${where} ORDER BY updated_at DESC, id LIMIT 200`).all(q);
      return { notes: rows.map(shape), total, truncated: total > 200 };
    },
    save(input, id) {
      if (id) get(id);
      const record = validateNote(input);
      const now = new Date().toISOString();
      const key = id || randomUUID();
      db.prepare(`INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, status=excluded.status,
        title=excluded.title, body=excluded.body, rationale=excluded.rationale,
        tags=excluded.tags, session_id=excluded.session_id, source_kind=excluded.source_kind,
        source_id=excluded.source_id, turn_index=excluded.turn_index, updated_at=excluded.updated_at`)
        .run(key, record.kind, record.status, record.title, record.body, record.rationale,
          JSON.stringify(record.tags), record.session_id, record.source_kind, record.source_id,
          record.turn_index, now, now);
      return get(key);
    },
    remove(id) {
      get(id);
      db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      return { deleted: true };
    },
    close() { db.close(); },
  };
}
