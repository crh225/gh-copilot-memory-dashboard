import { readFilters } from "./store.js";
import { pricingSnapshot, estimateEvent, emptyEstimate, addEstimate } from "./pricing.js";

const valid = value => Number.isSafeInteger(value) && value >= 0;
const dateDay = value => {
  const day = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day ? day : null;
};
const previousDay = (day, n) => new Date(Date.parse(day) - n * 86400000).toISOString().slice(0, 10);
const fresh = () => ({ events: 0, inputTokens: null, outputTokens: null,
  inputSamples: 0, outputSamples: 0, cacheSamples: 0, cacheInput: 0, cacheRead: 0,
  pairedTokens: null, tokenSamples: 0, estimate: emptyEstimate() });
function collect(target, event, price) {
  target.events++;
  for (const [field, samples, column] of [
    ["inputTokens", "inputSamples", "input_tokens"], ["outputTokens", "outputSamples", "output_tokens"],
  ]) {
    if (valid(event[column])) {
      target[field] = (target[field] ?? 0) + event[column];
      target[samples]++;
    }
  }
  if (valid(event.input_tokens) && valid(event.output_tokens)) {
    target.pairedTokens = (target.pairedTokens ?? 0) + event.input_tokens + event.output_tokens;
    target.tokenSamples++;
  }
  if (valid(event.input_tokens) && valid(event.cache_read_tokens) &&
      event.cache_read_tokens <= event.input_tokens &&
      (event.cache_write_tokens === null || event.cache_write_tokens === undefined ||
        (valid(event.cache_write_tokens) && event.cache_read_tokens + event.cache_write_tokens <= event.input_tokens))) {
    target.cacheInput += event.input_tokens;
    target.cacheRead += event.cache_read_tokens;
    target.cacheSamples++;
  }
  addEstimate(target.estimate, price);
}
function shape(item) {
  return { events: item.events, inputTokens: item.inputTokens, outputTokens: item.outputTokens,
    cacheReadShare: item.cacheInput > 0 ? item.cacheRead / item.cacheInput : null,
    cacheSamples: item.cacheSamples,
    cachePairedInputTokens: item.cacheSamples ? item.cacheInput : null,
    cachePairedReadTokens: item.cacheSamples ? item.cacheRead : null,
    coverage: { events: item.events, inputSamples: item.inputSamples, outputSamples: item.outputSamples,
      cacheSamples: item.cacheSamples, tokenSamples: item.tokenSamples },
    usd: item.estimate.usd, pricedEvents: item.estimate.pricedEvents,
    excludedEvents: item.estimate.excludedEvents, estimate: item.estimate };
}

/**
 * Streams local event counters. Rates are estimates, never actual billed cost.
 * Only metadata/counters are selected and sorted; no conversation text is read.
 */
export function usageInsights(db, params) {
  const copy = new URLSearchParams(params);
  if (!copy.has("repository") && copy.has("repo")) copy.set("repository", copy.get("repo"));
  const filters = readFilters(copy);
  const columns = new Set(db.prepare("PRAGMA table_info(assistant_usage_events)").all().map(row => row.name));
  const base = { filters, sessions: [], daily: [], spikes: [], modelChanges: [],
    total: 0, truncated: false, pricing: pricingSnapshot,
    costNote: "Published-rate estimated usage value, not an invoice or actual spending.",
    limits: { sessions: 100, daily: 366, spikes: 100, modelChanges: 200, modelsPerSession: 20,
      tokenBreakdownCharacters: 64000, repositoryCharacters: 1000, modelCharacters: 200 },
    notes: [
      "Token categories unavailable or invalid remain null with sample coverage, not invented zeros.",
      "Cache share is sum(cache reads)/sum(input) over the same valid paired counter samples only; zero denominators remain null.",
      "Daily token spikes require paired input/output counters and at least 3 observed baseline days within the prior 7 calendar days; missing days are not zeros. A spike is at least twice the observed-day mean.",
      "Baseline days may precede the requested start date by up to 7 days; other outputs respect the requested event dates and repository.",
      "Model changes are adjacent recorded models in a session/recorded-agent stream with strictly ordered timestamps. Missing models and ambiguous equal-timestamp models break continuity; changes do not imply user intent.",
    ] };
  if (!columns.size) return { ...base, available: false, reason: "No assistant usage records table is available." };
  if (!["session_id", "created_at"].every(name => columns.has(name))) {
    return { ...base, available: false, reason: "Usage records lack the session or timestamp columns needed for insights." };
  }
  const clauses = [], bindings = [];
  if (filters.repository) { clauses.push("s.repository = ?"); bindings.push(filters.repository); }
  if (filters.from) { clauses.push("substr(u.created_at, 1, 10) >= ?"); bindings.push(previousDay(filters.from, 7)); }
  if (filters.to) { clauses.push("substr(u.created_at, 1, 10) <= ?"); bindings.push(filters.to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const select = name => columns.has(name) ? `u.${name}` : "NULL";
  const counters = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "agent_id"];
  const query = db.prepare(`SELECT u.session_id, u.created_at,
    ${counters.map(name => `${select(name)} AS ${name}`).join(", ")},
    CASE WHEN length(${select("model")}) <= 200 THEN ${select("model")} END AS model,
    length(${select("model")}) > 200 AS oversizedModel,
    substr(${select("token_details_json")}, 1, 64000) AS token_details_json,
    length(${select("token_details_json")}) AS tokenDetailsLength,
    substr(s.summary, 1, 240) AS summary, length(s.summary) AS summaryLength,
    s.id AS recorded_session_id, substr(s.repository, 1, 1000) AS repository,
    length(s.repository) > 1000 AS repositoryTruncated,
    ${select("id")} AS source_id, ${select("turn_index")} AS turn_index
    FROM assistant_usage_events u LEFT JOIN sessions s ON s.id = u.session_id ${where}
    ORDER BY u.session_id, ${select("agent_id")}, julianday(u.created_at), u.created_at,
      ${select("id")}, ${select("turn_index")}, ${select("model")}`);
  const sessions = new Map(), days = new Map(), changes = [];
  let modelChangesTotal = 0, invalidDateEvents = 0, missingSessionEvents = 0;
  let prior = null;
  const totals = fresh();
  for (const event of query.iterate(...bindings)) {
    const day = dateDay(event.created_at);
    const inRange = (!filters.from && !filters.to) || (day !== null &&
      (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to));
    const price = event.oversizedModel
      ? { usd: null, reason: "Recorded model identifier exceeds the 200-character analysis limit" }
      : event.tokenDetailsLength > 64000
      ? { usd: null, reason: "Recorded token breakdown exceeds the 64000-character analysis limit" }
      : estimateEvent(event);
    if (day) {
      if (!days.has(day)) days.set(day, fresh());
      collect(days.get(day), event, price);
    } else if (inRange) invalidDateEvents++;
    if (!inRange) continue;
    collect(totals, event, price);
    if (event.recorded_session_id === null) missingSessionEvents++;
    if (!sessions.has(event.session_id)) sessions.set(event.session_id, {
      ...fresh(), id: event.session_id, summary: event.summary, repository: event.repository,
      summaryTruncated: event.summaryLength > 240, repositoryTruncated: Boolean(event.repositoryTruncated),
      models: new Map(), missingModelEvents: 0 });
    const item = sessions.get(event.session_id);
    collect(item, event, price);
    const model = typeof event.model === "string" && event.model.trim() ? event.model : null;
    if (model) item.models.set(model, (item.models.get(model) || 0) + 1);
    else item.missingModelEvents++;
    const stream = JSON.stringify([event.session_id, event.agent_id]);
    const time = typeof event.created_at === "string" ? Date.parse(event.created_at) : NaN;
    const recorded = { stream, time, model, source_id: event.source_id,
      turn_index: event.turn_index, created_at: event.created_at, ambiguous: false };
    if (prior?.stream === stream && Number.isFinite(time) && Number.isFinite(prior.time)) {
      if (time === prior.time) recorded.ambiguous = prior.ambiguous || model !== prior.model;
      else if (time > prior.time && !prior.ambiguous && prior.model && model && model !== prior.model) {
        modelChangesTotal++;
        if (changes.length < 200) changes.push({ session_id: event.session_id,
          agent_id: event.agent_id, from: prior.model, to: model, created_at: event.created_at,
          from_source_id: prior.source_id, source_id: event.source_id,
          turn_index: event.turn_index, evidence: "recorded" });
      }
    }
    prior = recorded;
  }
  const daily = [...days].filter(([day]) => (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to))
    .sort(([a], [b]) => a.localeCompare(b)).map(([day, item]) => ({
      day, ...shape(item), tokens: item.pairedTokens,
      baseline: (() => {
        const samples = Array.from({ length: 7 }, (_, index) => days.get(previousDay(day, index + 1)))
          .filter(value => value?.tokenSamples > 0);
        return { calendarDays: 7, observedDays: samples.length, minimumObservedDays: 3,
          meanTokens: samples.length >= 3 ? samples.reduce((sum, value) => sum + value.pairedTokens, 0) / samples.length : null };
      })(),
    }));
  const spikes = daily.filter(item => item.tokens !== null && item.baseline.meanTokens > 0 &&
    item.tokens >= item.baseline.meanTokens * 2).map(item => ({
      day: item.day, tokens: item.tokens, ratio: item.tokens / item.baseline.meanTokens,
      baseline: item.baseline, coverage: item.coverage, usd: item.usd }));
  const ranked = [...sessions.values()].map(item => {
    const models = [...item.models].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
    return { id: item.id, summary: item.summary, repository: item.repository, summaryTruncated: item.summaryTruncated,
      repositoryTruncated: item.repositoryTruncated,
      ...shape(item), models: columns.has("model") ? models.slice(0, 20).map(([model, events]) => ({ model, events })) : null,
      modelsTotal: models.length, modelsTruncated: models.length > 20, missingModelEvents: item.missingModelEvents };
  }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) ||
    ((b.inputTokens ?? 0) + (b.outputTokens ?? 0)) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)) ||
    String(a.id).localeCompare(String(b.id)));
  const selected = ranked.slice(0, 100);
  return { ...base, available: true, sessions: selected, total: ranked.length,
    totals: shape(totals), daily: daily.slice(-366), dailyTotal: daily.length,
    spikes: spikes.slice(-100), spikesTotal: spikes.length,
    modelChanges: changes, modelChangesTotal,
    coverage: { columns: [...columns].sort(), invalidDateEvents, missingSessionEvents },
    truncated: ranked.length > 100 || daily.length > 366 || spikes.length > 100 ||
      modelChangesTotal > changes.length || selected.some(item => item.modelsTruncated || item.summaryTruncated || item.repositoryTruncated),
    ranking: "Estimated USD descending (unpriced last), then recorded input+output tokens, then session id." };
}
