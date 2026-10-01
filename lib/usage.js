import { readFilters } from "./store.js";
import { pricingSnapshot, estimateEvent, emptyEstimate, addEstimate } from "./pricing.js";

const fields = {
  inputTokens: "input_tokens", outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens", cacheWriteTokens: "cache_write_tokens",
  reasoningTokens: "reasoning_tokens", nanoAiu: "total_nano_aiu",
  durationMs: "duration_ms", ttftMs: "time_to_first_token_ms",
  outputTtftMs: "output_ttft_ms", interTokenMs: "inter_token_latency_ms",
  multiplier: "request_multiplier",
};

function where(filters, dateColumn) {
  const clauses = [];
  const args = [];
  if (filters.repository) { clauses.push("s.repository = ?"); args.push(filters.repository); }
  if (filters.from) { clauses.push(`substr(${dateColumn}, 1, 10) >= ?`); args.push(filters.from); }
  if (filters.to) { clauses.push(`substr(${dateColumn}, 1, 10) <= ?`); args.push(filters.to); }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", args };
}

export function dashboard(db, params) {
  const filters = readFilters(params);
  const activityFilter = where(filters, "s.created_at");
  const activity = db.prepare(`SELECT substr(s.created_at, 1, 10) AS day, COUNT(*) AS sessions
    FROM sessions s ${activityFilter.sql} GROUP BY day ORDER BY day`).all(...activityFilter.args);
  const columns = new Set(db.prepare("PRAGMA table_info(assistant_usage_events)").all().map(row => row.name));
  const base = {
    filters, activity,
    dollarCost: null,
    costNote: "Actual dollar spending is not recorded. Estimated usage value applies the published GitHub token rates to supported local events; it is not an invoice.",
    pricing: pricingSnapshot,
    estimate: emptyEstimate(),
    notes: [
      "Counts cover locally recorded assistant usage events, including agent events; they are not billing statements.",
      "Cache and reasoning tokens are reported separately; they are not added to input/output totals because categories may overlap.",
      "Recorded AIU = total_nano_aiu / 1,000,000,000. AI usage units are not dollar amounts or premium-request counts.",
      "Session activity span is elapsed time between the first and last recorded usage event, including idle time. It is not active coding time.",
      "Missing metrics stay unavailable. Sample counts show coverage; filtered totals may be partial.",
    ],
  };
  if (!columns.size) return { ...base, available: false, reason: "This CLI database has no assistant usage records table." };
  if (!["session_id", "created_at"].every(column => columns.has(column))) {
    return { ...base, available: false, reason: "The local usage table lacks the session or timestamp columns needed for analytics." };
  }
  const usageFilter = where(filters, "u.created_at");
  const valid = column => columns.has(column)
    ? `CASE WHEN typeof(u.${column}) IN ('integer', 'real') AND u.${column} >= 0 THEN u.${column} END`
    : "NULL";
  const aggregates = Object.entries(fields).flatMap(([key, column]) => [
    `SUM(${valid(column)}) AS ${key}Total`,
    `AVG(${valid(column)}) AS ${key}Average`,
    `COUNT(${valid(column)}) AS ${key}Samples`,
  ]).join(", ");
  const join = `FROM assistant_usage_events u LEFT JOIN sessions s ON s.id = u.session_id ${usageFilter.sql}`;
  const aggregate = (group = "", key = "") => db.prepare(
    `SELECT ${key ? `${key} AS name,` : ""} COUNT(*) AS requests,
      COUNT(DISTINCT u.session_id) AS sessions, ${aggregates} ${join}
      ${group ? `GROUP BY ${group}` : ""}
      ${group ? "ORDER BY requests DESC, name" : ""}`).all(...usageFilter.args);
  const shape = row => ({
    name: row.name, requests: row.requests, sessions: row.sessions,
    metrics: Object.fromEntries(Object.keys(fields).map(key =>
      [key, { total: row[`${key}Total`], average: row[`${key}Average`], samples: row[`${key}Samples`] }])),
  });
  const daily = aggregate("substr(u.created_at, 1, 10)", "substr(u.created_at, 1, 10)")
    .map(shape).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const spans = db.prepare(`SELECT COUNT(*) AS samples, AVG(span_ms) AS averageMs FROM (
    SELECT CASE WHEN COUNT(*) > 1 THEN
      (julianday(MAX(u.created_at)) - julianday(MIN(u.created_at))) * 86400000 END AS span_ms
    ${join} GROUP BY u.session_id HAVING COUNT(*) > 1
  ) WHERE span_ms >= 0`).get(...usageFilter.args);
  const categorical = column => columns.has(column)
    ? db.prepare(`SELECT COALESCE(u.${column}, 'Unrecorded') AS name, COUNT(*) AS requests
        ${join} GROUP BY name ORDER BY requests DESC, name`).all(...usageFilter.args)
    : [];
  const flagged = columns.has("content_filter_triggered")
    ? db.prepare(`SELECT SUM(CASE WHEN u.content_filter_triggered = 1 THEN 1 ELSE 0 END) AS triggered,
        COUNT(u.content_filter_triggered) AS samples ${join}`).get(...usageFilter.args)
    : { triggered: null, samples: 0 };
  const agents = columns.has("agent_id")
    ? db.prepare(`SELECT COUNT(DISTINCT u.agent_id) AS distinctAgents,
        SUM(CASE WHEN u.agent_id IS NOT NULL THEN 1 ELSE 0 END) AS events ${join}`).get(...usageFilter.args)
    : { distinctAgents: null, events: null };
  const totals = shape(aggregate()[0]);
  const models = aggregate(columns.has("model") ? "u.model" : "'Unrecorded'",
    columns.has("model") ? "COALESCE(u.model, 'Unrecorded')" : "'Unrecorded'").map(shape);
  const repositories = aggregate("COALESCE(s.repository, 'Local / unassigned')",
    "COALESCE(s.repository, 'Local / unassigned')").map(shape);
  const groups = [
    new Map(models.map(row => [row.name, row])),
    new Map(repositories.map(row => [row.name, row])),
    new Map(daily.map(row => [row.name, row])),
  ];
  for (const row of [totals, ...models, ...repositories, ...daily]) row.estimate = emptyEstimate();
  const select = column => columns.has(column) ? `u.${column}` : "NULL";
  const events = db.prepare(`SELECT ${["model", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "token_details_json"].map(column => `${select(column)} AS ${column}`).join(", ")},
    COALESCE(s.repository, 'Local / unassigned') AS repository,
    substr(u.created_at, 1, 10) AS day ${join}`).iterate(...usageFilter.args);
  for (const event of events) {
    const result = estimateEvent(event);
    addEstimate(totals.estimate, result);
    [event.model ?? "Unrecorded", event.repository, event.day].forEach((name, index) =>
      addEstimate(groups[index].get(name).estimate, result));
  }
  return {
    ...base, available: true,
    estimate: totals.estimate, totals, models, repositories,
    daily, sessionSpan: spans, contentFilters: flagged, agents,
    finishReasons: categorical("finish_reason"),
    reasoningEfforts: categorical("reasoning_effort"),
    initiators: categorical("initiator"),
    endpoints: categorical("api_endpoint"),
    billingModels: categorical("copilot_usage_model"),
  };
}
