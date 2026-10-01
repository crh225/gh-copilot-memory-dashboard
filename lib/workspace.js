import { AppError, readFilters } from "./store.js";
import { renderMarkdown } from "./markdown.js";

const invalid = message => { throw new AppError(400, "INVALID_INPUT", message); };
const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
const url = (id, turn) => `/#session=${encodeURIComponent(id)}${turn === undefined || turn === null ? "" : `&turn=${encodeURIComponent(turn)}`}`;
const key = (...parts) => JSON.stringify(parts);
const fields = ["title", "overview", "history", "work_done", "technical_details", "important_files", "next_steps"];
const bodyObject = body => {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("A JSON object is required.");
};
const identifier = value => {
  if (typeof value !== "string" || !value.trim() || value.length > 200) invalid("A valid session id is required.");
  return value;
};

function filtersFor(params) {
  const copy = new URLSearchParams(params);
  if (!copy.has("repository") && copy.has("repo")) copy.set("repository", copy.get("repo"));
  const filters = readFilters(copy);
  for (const name of ["file", "branch", "ref"]) {
    filters[name] = copy.get(name) || "";
    if (filters[name].length > 500) invalid(`${name} filter is too long.`);
  }
  return filters;
}

/**
 * A bounded graph of recorded session metadata, not a causal/dependency graph.
 * Dates select sessions whose recorded lifetime overlaps the requested days.
 */
export function timeline(db, params) {
  const filters = filtersFor(params);
  const files = columns(db, "session_files");
  const refs = columns(db, "session_refs");
  const filesAvailable = ["session_id", "file_path"].every(name => files.has(name));
  const refsAvailable = ["session_id", "ref_type", "ref_value"].every(name => refs.has(name));
  const clauses = [], args = [];
  for (const [name, sql] of [
    ["repository", "s.repository = ?"], ["branch", "s.branch = ?"],
    ["from", "substr(s.updated_at, 1, 10) >= ?"], ["to", "substr(s.created_at, 1, 10) <= ?"],
  ]) {
    if (filters[name]) { clauses.push(sql); args.push(filters[name]); }
  }
  if (filters.file) {
    clauses.push(filesAvailable
      ? "EXISTS (SELECT 1 FROM session_files f WHERE f.session_id = s.id AND f.file_path = ?)" : "0");
    if (filesAvailable) args.push(filters.file);
  }
  if (filters.ref) {
    clauses.push(refsAvailable
      ? "EXISTS (SELECT 1 FROM session_refs r WHERE r.session_id = s.id AND r.ref_value = ?)" : "0");
    if (refsAvailable) args.push(filters.ref);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM sessions s ${where}`).get(...args).n;
  const sessions = db.prepare(`SELECT s.id, substr(s.summary, 1, 240) AS summary,
    length(s.summary) AS summaryLength,
    ${["repository", "branch", "cwd"].map(name =>
      `CASE WHEN length(s.${name}) <= 1000 THEN s.${name} END AS ${name}`).join(", ")},
    (length(s.repository) > 1000 OR length(s.branch) > 1000 OR length(s.cwd) > 1000) AS metadataOversize,
    substr(s.created_at, 1, 100) AS created_at, substr(s.updated_at, 1, 100) AS updated_at
    FROM sessions s ${where ? `${where} AND` : "WHERE"} length(s.id) <= 200
    ORDER BY s.updated_at DESC, s.id LIMIT 100`).all(...args);
  const nodes = new Map(), edges = [], seenEdges = new Set();
  let metadataTruncated = sessions.some(item => item.metadataOversize);
  const node = item => {
    if (nodes.has(item.id)) return true;
    if (nodes.size >= 600) { metadataTruncated = true; return false; }
    nodes.set(item.id, item);
    return true;
  };
  const link = (sessionId, type, value, scope, extra = {}) => {
    if (typeof value !== "string" || !value) return;
    if (value.length > 1000 || String(scope).length > 1000) { metadataTruncated = true; return; }
    const id = key(type, scope, value);
    const edge = { from: key("session", sessionId), to: id, type, evidence: "recorded" };
    const edgeId = key(edge.from, id, type);
    if (seenEdges.has(edgeId)) return;
    if (edges.length >= 1000) { metadataTruncated = true; return; }
    if (!node({ id, type, label: value, scope, ...extra })) return;
    seenEdges.add(edgeId);
    edges.push(edge);
  };
  for (const item of sessions) {
    node({ id: key("session", item.id), type: "session", label: item.summary || item.id,
      session_id: item.id, url: url(item.id) });
  }
  for (const item of sessions) {
    const scope = item.repository ? key("repository", item.repository)
      : item.cwd ? key("workspace", item.cwd) : key("session", item.id);
    link(item.id, "repository", item.repository, "repository");
    link(item.id, "branch", item.branch, scope);
    if (filesAvailable) {
      const rows = db.prepare(`SELECT DISTINCT
        CASE WHEN length(file_path) <= 1000 THEN file_path END AS file_path,
        length(file_path) > 1000 AS oversized FROM session_files
        WHERE session_id = ? ORDER BY file_path LIMIT 101`).all(item.id);
      metadataTruncated ||= rows.length > 100 || rows.some(row => row.oversized);
      for (const row of rows.slice(0, 100)) link(item.id, "file", row.file_path, scope);
    }
    if (refsAvailable) {
      const rows = db.prepare(`SELECT DISTINCT
        CASE WHEN length(ref_type) <= 100 THEN ref_type END AS ref_type,
        CASE WHEN length(ref_value) <= 1000 THEN ref_value END AS ref_value,
        (length(ref_type) > 100 OR length(ref_value) > 1000) AS oversized FROM session_refs
        WHERE session_id = ? ORDER BY ref_type, ref_value LIMIT 101`).all(item.id);
      metadataTruncated ||= rows.length > 100 || rows.some(row => row.oversized);
      for (const row of rows.slice(0, 100)) {
        if (row.oversized) continue;
        // A full GitHub PR/issue URL records its repository independently of the session.
        const recordedRepo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+(?:[/?#]|$)/i.exec(row.ref_value || "")?.[1];
        link(item.id, "ref", row.ref_value, key(recordedRepo || scope, row.ref_type),
          { ref_type: row.ref_type });
      }
    }
  }
  const summaryTruncated = sessions.some(item => item.summaryLength > 240);
  return { sessions: sessions.map(item => ({ ...item, summaryTruncated: item.summaryLength > 240 })),
    nodes: [...nodes.values()], edges, total, truncated: total > sessions.length || metadataTruncated || summaryTruncated,
    metadataTruncated, filters, coverage: { filesAvailable, refsAvailable },
    limits: { sessions: 100, nodes: 600, edges: 1000, resourcesPerKindPerSession: 100,
      metadataCharacters: 1000, sessionIdCharacters: 200 },
    note: "Edges are recorded session-to-resource associations, not inferred dependencies. Relative file paths and branches are scoped by repository, or workspace when no repository is recorded." };
}

function lineChanges(before, after) {
  if (before === after) return { addedLines: 0, removedLines: 0 };
  const a = before === null || before === "" ? [] : before.split("\n");
  const b = after === null || after === "" ? [] : after.split("\n");
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start &&
      a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { addedLines: b.length - start - end, removedLines: a.length - start - end };
}

/** Counts replace the changed middle after equal prefix/suffix lines; not a minimal edit script. */
export function checkpointComparison(db, body) {
  bodyObject(body);
  const sessionId = identifier(body.session_id);
  for (const name of ["from", "to"]) {
    const value = body[name];
    if (!(typeof value === "string" && value.length > 0 && value.length <= 200) &&
        !(Number.isSafeInteger(value) && value >= 0)) invalid(`${name} must be a checkpoint id.`);
  }
  const select = db.prepare(`SELECT id, substr(title, 1, 16000) AS title, checkpoint_number AS number, created_at,
    ${fields.filter(name => name !== "title").map(name => `substr(${name}, 1, 16000) AS ${name}`).join(", ")},
    ${fields.map(name => `length(${name}) AS ${name}_length`).join(", ")}
    FROM checkpoints WHERE session_id = ? AND CAST(id AS TEXT) = ?`);
  const from = select.get(sessionId, String(body.from)), to = select.get(sessionId, String(body.to));
  if (!from || !to) throw new AppError(404, "NOT_FOUND", "Both checkpoints must belong to the selected session.");
  const equality = db.prepare(`SELECT ${fields.map(name =>
    `(a.${name} IS b.${name}) AS ${name}`).join(", ")} FROM checkpoints a JOIN checkpoints b
    ON b.session_id = a.session_id WHERE a.session_id = ? AND CAST(a.id AS TEXT) = ? AND CAST(b.id AS TEXT) = ?`)
    .get(sessionId, String(body.from), String(body.to));
  const comparison = fields.map(name => {
    const before = from[name], after = to[name];
    const truncated = from[`${name}_length`] > 16000 || to[`${name}_length`] > 16000;
    return { name, before, after, before_html: renderMarkdown(before ?? ""),
      after_html: renderMarkdown(after ?? ""), changed: !equality[name],
      ...lineChanges(before, after), truncated,
      beforeLength: from[`${name}_length`], afterLength: to[`${name}_length`],
      countsPartial: truncated };
  });
  const metadata = item => ({ id: item.id, title: item.title, number: item.number,
    created_at: item.created_at, titleTruncated: item.title_length > 16000 });
  return { session_id: sessionId, from: metadata(from), to: metadata(to), fields: comparison,
    truncated: comparison.some(item => item.truncated), fieldCharacterLimit: 16000,
    diffMethod: "Ordered-line changed-middle replacement after common prefix/suffix; counts are not minimal edits. Reorders count as changes. Counts cover only retained prefixes when truncated; changed compares complete stored values." };
}

function redact(text) {
  return text
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED TOKEN]")
    .replace(/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)["']?\s*[:=]\s*(?:["'][^"'\n]*["']|[^\s,;]+)/gi, "[REDACTED CREDENTIAL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED TOKEN]")
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, "[REDACTED EMAIL]")
    .replace(/(?:\/Users\/|\/home\/)[^\s/`"'<>]+/g, "/home/[REDACTED]")
    .replace(/[A-Z]:\\Users\\[^\\\s`"'<>]+/gi, "C:\\Users\\[REDACTED]");
}

/** Deterministic, extractive excerpts: no AI-derived goals/decisions are asserted. */
export function contextPack(db, body) {
  bodyObject(body);
  if (!Array.isArray(body.session_ids) || !body.session_ids.length || body.session_ids.length > 20) {
    invalid("Select between 1 and 20 sessions.");
  }
  const ids = [...new Set(body.session_ids.map(identifier))];
  if (!Number.isSafeInteger(body.token_budget) || body.token_budget < 128 || body.token_budget > 32000) {
    invalid("token_budget must be an integer between 128 and 32000.");
  }
  if (typeof body.redact !== "boolean") invalid("redact must be a boolean.");
  if (body.query !== undefined && (typeof body.query !== "string" || body.query.length > 200)) invalid("query must be a string of at most 200 characters.");
  const clean = text => body.redact ? redact(text) : text;
  const charBudget = body.token_budget * 4;
  const redactionNote = body.redact
    ? "Pattern-based redaction covers recognizable credentials, emails and home usernames; not complete anonymity."
    : "Redaction disabled; recorded excerpts may contain private data.";
  const intro = `# Recorded context excerpts\n\nApproximate tokens: ceil(characters/4). Recorded text, not verified AI conclusions.\n${redactionNote}\n`;
  const sessions = ids.map(id => {
    const item = db.prepare("SELECT id, substr(summary, 1, 6000) AS summary, length(summary) AS summaryLength FROM sessions WHERE id = ?").get(id);
    if (!item) throw new AppError(404, "NOT_FOUND", "A selected session was not found.");
    return item;
  });
  const placeholder = "\n(No excerpt included.)\n";
  const sections = sessions.map((item, index) => `\n## Session ${index + 1} ([source](${url(item.id)}))\n`);
  const minimum = intro + sections.map(text => text + placeholder).join("");
  if (clean(minimum).length > charBudget) invalid("The token budget cannot fit source labels for every selection; increase it or select fewer sessions.");
  const sourceMap = new Map();
  const addSource = source => sourceMap.set(key(source.session_id, source.kind, source.source_id), source);
  const selections = [];
  let remaining = charBudget - clean(intro).length - sections.reduce((sum, text) => sum + clean(text).length, 0);
  const parts = [];
  let truncated = false;
  sessions.forEach((item, index) => {
    const allocation = Math.floor(remaining / (sessions.length - index));
    const candidates = [];
    const source = (kind, sourceId, turnIndex = null) => ({ session_id: item.id, kind,
      source_id: String(sourceId), turn_index: turnIndex, url: url(item.id, turnIndex) });
    const candidate = (label, text, length, origin) => {
      if (typeof text === "string" && text.length) candidates.push({ label, text: clean(text), clipped: length > 6000, origin });
    };
    candidate("Recorded session summary", item.summary, item.summaryLength, source("summary", item.id));
    const goal = db.prepare(`SELECT id, turn_index, substr(user_message, 1, 6000) AS text,
      length(user_message) AS length FROM turns WHERE session_id = ? AND COALESCE(user_message, '') != ''
      ORDER BY turn_index, id LIMIT 1`).get(item.id);
    if (goal) candidate("First recorded user request (goal context)", goal.text, goal.length, source("user", goal.id, goal.turn_index));
    const checkpoint = db.prepare(`SELECT id, ${fields.map(name => `substr(${name}, 1, 6000) AS ${name}, length(${name}) AS ${name}_length`).join(", ")}
      FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number DESC, created_at DESC, id DESC LIMIT 1`).get(item.id);
    if (checkpoint) {
      for (const name of ["overview", "work_done", "next_steps"]) candidate(`Latest checkpoint / recorded ${name.replaceAll("_", " ")}`,
        checkpoint[name], checkpoint[`${name}_length`], source("checkpoint", checkpoint.id));
    }
    const query = body.query?.trim() || "";
    const turns = db.prepare(`SELECT id, turn_index,
      substr(user_message, 1, 6000) AS user_message, length(user_message) AS user_length,
      substr(assistant_response, 1, 6000) AS assistant_response, length(assistant_response) AS assistant_length
      FROM turns WHERE session_id = ? ${query ? "AND (instr(lower(COALESCE(user_message, '')), lower(?)) > 0 OR instr(lower(COALESCE(assistant_response, '')), lower(?)) > 0)" : ""}
      ORDER BY turn_index DESC, id DESC LIMIT 6`).all(item.id, ...(query ? [query, query] : []));
    const totalTurns = db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE session_id = ?
      ${query ? "AND (instr(lower(COALESCE(user_message, '')), lower(?)) > 0 OR instr(lower(COALESCE(assistant_response, '')), lower(?)) > 0)" : ""}`)
      .get(item.id, ...(query ? [query, query] : [])).n;
    for (const turn of turns) {
      if (turn.id !== goal?.id) candidate(`Recent recorded user / turn ${turn.turn_index}`, turn.user_message,
        turn.user_length, source("user", turn.id, turn.turn_index));
      candidate(`Recent recorded assistant / turn ${turn.turn_index}`, turn.assistant_response,
        turn.assistant_length, source("assistant", turn.id, turn.turn_index));
    }
    if (checkpoint) {
      for (const name of ["title", "technical_details", "important_files", "history"]) {
        candidate(`Latest checkpoint / recorded ${name.replaceAll("_", " ")}`,
          checkpoint[name], checkpoint[`${name}_length`], source("checkpoint", checkpoint.id));
      }
    }
    let content = "", included = 0, omitted = 0;
    let partial = totalTurns > turns.length;
    const localSources = [];
    for (const entry of candidates) {
      const heading = `\n### ${entry.label} ([source](${entry.origin.url}))\n`;
      const space = allocation - content.length - heading.length - 16;
      if (space < 1) { omitted++; continue; }
      // Share room across source kinds rather than letting one huge summary consume the pack.
      const excerptCap = Math.max(64, Math.floor(allocation / Math.max(candidates.length, 1)));
      const text = entry.text.slice(0, Math.min(space, excerptCap));
      const clipped = entry.clipped || text.length < entry.text.length;
      content += `${heading}${text}${clipped ? "\n[… truncated]" : ""}\n`;
      partial ||= clipped;
      localSources.push(entry.origin);
      included++;
    }
    partial ||= omitted > 0;
    if (!content) content = placeholder;
    // Placeholders were reserved for all selections, even when a very small fair share remains.
    remaining -= clean(content).length;
    addSource(source("session", item.id));
    for (const origin of localSources) addSource(origin);
    parts.push(clean(sections[index]) + content);
    selections.push({ session_id: item.id, includedExcerpts: included, omittedExcerpts: omitted,
      truncated: partial, checkpointAvailable: Boolean(checkpoint), goalAvailable: Boolean(goal),
      relevantTurns: totalTurns });
    truncated ||= partial;
  });
  const markdown = clean(intro) + parts.join("");
  return { markdown, tokenEstimate: Math.ceil(markdown.length / 4), tokenBudget: body.token_budget,
    tokenEstimateMethod: "ceil(markdown.length / 4); approximate, not model-tokenizer accounting",
    truncated, sources: [...sourceMap.values()], selections, redactionNote,
    selectionNote: "Input order is preserved, duplicate selections are deduplicated. Remaining characters are divided fairly per session and excerpt. Priority: recorded summary, first user request, latest checkpoint overview/work/next steps, up to six recent query-matching turns, other checkpoint fields. Missing fields are omitted, not inferred." };
}
