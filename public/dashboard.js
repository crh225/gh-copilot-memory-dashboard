import { $, node, icon, section, empty, api, format, decimal } from "./ui.js";

let version = 0;
const missing = "Not recorded";
const value = (number, scale = 1) => number === null || number === undefined
  ? missing : decimal.format(number / scale);
const tokens = (row, key) => row.metrics[key].total;
const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const usd = number => number === null || number === undefined ? "Unavailable" :
  number > 0 && number < 0.0001 ? "< $0.0001" : currency.format(number);
const cell = (text, sortValue) => ({ text, sortValue });

function card(label, number, detail) {
  const container = node("div", "metric-card");
  container.append(node("span", "stat-label", label), node("strong", "", number),
    node("span", "stat-detail", detail));
  return container;
}

function table(headers, rows, caption) {
  const container = node("div", "table-scroll");
  container.tabIndex = 0;
  container.setAttribute("aria-label", caption);
  const element = node("table", "usage-table");
  element.append(node("caption", "sr-only", caption));
  const head = node("thead");
  const header = node("tr");
  const buttons = [];
  let sortColumn = null;
  let descending = false;
  const records = rows.map((row, index) => ({ row, index }));
  const body = node("tbody");
  const draw = () => {
    body.replaceChildren();
    for (const { row } of records) {
      const tr = node("tr");
      row.forEach((data, index) => {
        const text = typeof data === "object" && data !== null ? data.text : data;
        const item = node(index === 0 ? "th" : "td", "", text);
        if (index === 0) item.scope = "row";
        tr.append(item);
      });
      body.append(tr);
    }
  };
  const sortValue = data => typeof data === "object" && data !== null ? data.sortValue : data;
  for (const label of headers) {
    const index = buttons.length;
    const th = node("th");
    th.scope = "col";
    th.setAttribute("aria-sort", "none");
    const button = node("button", "sort-header");
    button.append(node("span", "", label), icon("sort"));
    button.type = "button";
    button.setAttribute("aria-label", `Sort by ${label}`);
    button.addEventListener("click", () => {
      descending = sortColumn === index ? !descending : false;
      sortColumn = index;
      records.sort((a, b) => {
        const left = sortValue(a.row[index]), right = sortValue(b.row[index]);
        const leftMissing = left === null || left === undefined;
        const rightMissing = right === null || right === undefined;
        if (leftMissing || rightMissing) return leftMissing === rightMissing ? a.index - b.index : leftMissing ? 1 : -1;
        const comparison = typeof left === "number" && typeof right === "number"
          ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
        return comparison === 0 ? a.index - b.index : descending ? -comparison : comparison;
      });
      buttons.forEach((item, column) => {
        item.th.setAttribute("aria-sort", column === index ? descending ? "descending" : "ascending" : "none");
        item.button.replaceChildren(node("span", "", headers[column]),
          icon(column === index ? descending ? "chevron-down" : "chevron-up" : "sort"));
      });
      draw();
    });
    th.append(button);
    buttons.push({ th, button });
    header.append(th);
  }
  head.append(header);
  draw();
  element.append(head, body);
  container.append(element);
  return container;
}

function breakdown(title, rows) {
  const container = section(title);
  container.append(table(["Name", "Events", "Input", "Output", "Cache read", "Cache write", "Recorded AIU", "Est. USD", "Priced events", "Avg response"],
    rows.map(row => [row.name, cell(format.format(row.requests), row.requests),
      ...["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].map(key =>
        cell(value(tokens(row, key)), tokens(row, key))),
      cell(value(tokens(row, "nanoAiu"), 1e9), tokens(row, "nanoAiu")),
      cell(usd(row.estimate.usd), row.estimate.usd),
      cell(`${row.estimate.pricedEvents}/${row.requests}`, row.estimate.pricedEvents),
      cell(row.metrics.durationMs.average === null ? missing : `${value(row.metrics.durationMs.average, 1000)}s`,
        row.metrics.durationMs.average)]), title));
  return container;
}

function svgNode(tag, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, val] of Object.entries(attributes)) element.setAttribute(key, String(val));
  return element;
}

function trend(title, rows, getValue, className) {
  const container = section(title);
  if (!rows.length) { container.append(empty("No dated activity.", "There are no dated records in this range.")); return container; }
  const values = rows.map(getValue);
  const peak = Math.max(0, ...values.filter(item => item !== null));
  const pricing = className === "cost-trend";
  const step = pricing ? (peak || 1) / 4 : Math.max(1, Math.ceil(peak / 4));
  const max = step * 4;
  const display = number => pricing ? usd(number) : value(number);
  const axisCurrency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 });
  const axisNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const svg = svgNode("svg", { viewBox: "0 0 900 240", role: "img", "aria-label": title, class: `trend-chart ${className}` });
  const plot = { left: 80, top: 25, bottom: 195, width: 804, height: 170 };
  const width = plot.width / rows.length;
  const text = (label, attributes) => {
    const item = svgNode("text", { class: "chart-label", ...attributes });
    item.textContent = label;
    svg.append(item);
  };
  text(pricing ? "USD (estimated)" : className === "token-trend" ? "Tokens" : "Sessions",
    { x: plot.left, y: 13, class: "chart-unit" });
  for (let tick = 0; tick <= 4; tick++) {
    const amount = tick * step;
    const y = plot.bottom - (tick / 4) * plot.height;
    svg.append(svgNode("line", { x1: plot.left, y1: y, x2: plot.left + plot.width, y2: y, class: "chart-gridline" }));
    text(pricing ? axisCurrency.format(amount) : axisNumber.format(amount),
      { x: plot.left - 10, y: y + 4, "text-anchor": "end", class: "chart-y-label chart-label" });
  }
  rows.forEach((row, index) => {
    const count = values[index];
    const height = count === null ? 0 : (count / max) * plot.height;
    const bar = svgNode("rect", { x: plot.left + index * width + 3, y: plot.bottom - height,
      width: Math.max(1, width - 6), height, class: "chart-bar" });
    const tooltip = svgNode("title", {});
    tooltip.textContent = `${row.day}: ${display(count)}`;
    bar.append(tooltip);
    svg.append(bar);
  });
  let path = "";
  let connected = false;
  values.forEach((amount, index) => {
    if (amount === null) { connected = false; return; }
    const window = values.slice(Math.max(0, index - 6), index + 1).filter(item => item !== null);
    const average = window.reduce((sum, item) => sum + item, 0) / window.length;
    const x = plot.left + (index + 0.5) * width;
    const y = plot.bottom - (average / max) * plot.height;
    path += `${connected ? "L" : "M"}${x.toFixed(3)},${y.toFixed(3)} `;
    connected = true;
  });
  svg.append(svgNode("path", { d: path.trim(), class: "chart-trendline", fill: "none" }));
  const shortDate = day => day.slice(5);
  text(shortDate(rows[0].day), { x: plot.left, y: 220, "text-anchor": "start" });
  if (rows.length > 2) text(shortDate(rows[Math.floor(rows.length / 2)].day),
    { x: plot.left + plot.width / 2, y: 220, "text-anchor": "middle" });
  if (rows.length > 1) text(shortDate(rows.at(-1).day), { x: plot.left + plot.width, y: 220, "text-anchor": "end" });
  const legend = node("div", `chart-legend ${className}`);
  legend.append(node("span", "legend-bars", "Daily recorded value"),
    node("span", "legend-line", "7-day moving average"));
  container.append(legend);
  container.append(svg, node("p", "session-meta", `${rows[0].day} -> ${rows.at(-1).day} / Peak: ${display(peak)}`));
  const details = node("details");
  details.append(node("summary", "", "View exact daily values"),
    table(["Date", title], rows.map((row, index) => [row.day, cell(display(values[index]), values[index])]), title));
  container.append(details);
  return container;
}

function chartPanel(data) {
  const days = calendarDays(data);
  const charts = node("div", "chart-grid");
  if (data.available) {
    const cost = trend("ESTIMATED USD / LATEST 30 CALENDAR DAYS", days,
      row => row.usage ? row.usage.estimate.usd : 0, "cost-trend");
    cost.classList.add("cost-chart");
    charts.append(cost);
    charts.append(trend("INPUT + OUTPUT TOKENS / LATEST 30 CALENDAR DAYS", days, row => {
      if (!row.usage) return 0;
      const input = tokens(row.usage, "inputTokens"), output = tokens(row.usage, "outputTokens");
      return input === null && output === null ? null : (input || 0) + (output || 0);
    }, "token-trend"));
  }
  charts.append(trend("DAILY SESSIONS / LATEST 30 CALENDAR DAYS", days, row => row.sessions, "activity-trend"));
  return charts;
}

function calendarDays(data) {
  const days = [...data.activity.map(row => row.day), ...(data.daily || []).map(row => row.name)]
    .filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day || "")).sort();
  if (!days.length) return [];
  const last = new Date(`${days.at(-1)}T00:00:00Z`);
  const usage = new Map((data.daily || []).map(row => [row.name, row]));
  const activity = new Map(data.activity.map(row => [row.day, row.sessions]));
  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(last.valueOf() - (29 - index) * 86400000).toISOString().slice(0, 10);
    return { day, usage: usage.get(day), sessions: activity.get(day) || 0 };
  }).filter(row => (!data.filters.from || row.day >= data.filters.from) && (!data.filters.to || row.day <= data.filters.to));
}

function render(data) {
  const content = $("dashboard-content");
  content.replaceChildren();
  const billing = node("div", "billing-note");
  const estimate = data.estimate;
  billing.append(node("strong", "", `Estimated usage value / ${usd(estimate?.usd)}`),
    node("p", "", data.costNote));
  if (data.pricing) {
    const reference = node("p", "pricing-reference");
    const link = node("a", "", "GitHub published rates");
    link.href = data.pricing.source;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    reference.append(link, document.createTextNode(` / as of ${data.pricing.asOf} / 1 AI credit = $0.01 USD`));
    billing.append(reference);
    if (estimate) {
      billing.append(node("p", "", `Coverage: ${format.format(estimate.pricedEvents)} priced / ${format.format(estimate.pricedEvents + estimate.excludedEvents)} recorded events. Actual billed spending remains unavailable.`));
      const assumptions = node("details", "pricing-assumptions");
      assumptions.append(node("summary", "", "Pricing assumptions and excluded events"));
      for (const text of data.pricing.assumptions) assumptions.append(node("p", "session-meta", text));
      for (const [reason, count] of Object.entries(estimate.reasons)) assumptions.append(node("p", "session-meta", `${reason}: ${format.format(count)} events excluded`));
      assumptions.append(node("p", "session-meta", `Token basis: ${format.format(estimate.recordedBreakdownEvents)} recorded breakdowns / ${format.format(estimate.normalizedCounterEvents)} normalized-counter assumptions / ${format.format(estimate.longContextEvents)} long-context events.`));
      billing.append(assumptions);
    }
  }
  content.append(billing);
  const charts = chartPanel(data);
  let chartsShown = false;
  if (!data.available) {
    content.append(empty("Usage analytics unavailable.", data.reason));
  } else if (data.totals.requests === 0) {
    content.append(empty("No usage events in this range.", "Try a different repository or date range. Empty results are not a zero-dollar bill."));
  } else {
    const total = data.totals;
    const grid = node("div", "metric-grid");
    grid.append(card("RECORDED EVENTS", format.format(total.requests), `${format.format(total.sessions)} sessions with usage`));
    const input = tokens(total, "inputTokens"), output = tokens(total, "outputTokens");
    grid.append(card("INPUT + OUTPUT TOKENS", value(input === null && output === null ? null : (input || 0) + (output || 0)),
      "Recorded categories only / may be partial"));
    for (const [label, key, scale] of [
      ["INPUT TOKENS", "inputTokens", 1], ["OUTPUT TOKENS", "outputTokens", 1],
      ["CACHE READ TOKENS", "cacheReadTokens", 1], ["CACHE WRITE TOKENS", "cacheWriteTokens", 1],
      ["REASONING TOKENS", "reasoningTokens", 1], ["RECORDED AIU", "nanoAiu", 1e9],
    ]) {
      const metric = total.metrics[key];
      const item = card(label, value(metric.total, scale), `${format.format(metric.samples)} / ${format.format(total.requests)} events recorded`);
      item.dataset.metric = key;
      grid.append(item);
    }
    content.append(grid);
    const estimated = node("div", "metric-grid estimate-grid");
    estimated.append(card("ESTIMATED USAGE / USD", usd(data.estimate.usd), "Current-rate value / not your bill"),
      card("ESTIMATED AI CREDITS", data.estimate.credits === null ? "Unavailable" : value(data.estimate.credits), "$0.01 USD per credit"),
      card("PRICED EVENTS", format.format(data.estimate.pricedEvents), `${format.format(data.estimate.excludedEvents)} excluded / may be partial`));
    content.append(estimated, charts);
    chartsShown = true;
    const performance = section("PERFORMANCE / RECORDED AVERAGES");
    const metrics = node("div", "metric-grid performance-grid");
    for (const [label, key] of [["RESPONSE DURATION", "durationMs"], ["FIRST TOKEN", "ttftMs"],
      ["OUTPUT FIRST TOKEN", "outputTtftMs"], ["INTER-TOKEN LATENCY", "interTokenMs"]]) {
      const metric = total.metrics[key];
      metrics.append(card(label, metric.average === null ? missing : `${value(metric.average)} ms`,
        `${format.format(metric.samples)} samples`));
    }
    metrics.append(card("SESSION ACTIVITY SPAN", data.sessionSpan.averageMs === null ? missing :
      `${value(data.sessionSpan.averageMs, 60000)} min`, `${format.format(data.sessionSpan.samples)} sessions / includes idle time`));
    metrics.append(card("REQUEST MULTIPLIER", value(total.metrics.multiplier.average),
      `${format.format(total.metrics.multiplier.samples)} samples / not a price`));
    performance.append(metrics);
    content.append(performance, breakdown("USAGE BY MODEL", data.models), breakdown("USAGE BY REPOSITORY", data.repositories));
    const categories = node("div", "category-grid");
    for (const [title, rows] of [["FINISH REASONS", data.finishReasons],
      ["REASONING EFFORT", data.reasoningEfforts], ["INITIATORS", data.initiators],
      ["API ENDPOINTS", data.endpoints], ["RECORDED BILLING MODELS", data.billingModels]]) {
      const group = section(title);
      group.append(rows.length ? table(["Value", "Events"], rows.map(row => [row.name, cell(format.format(row.requests), row.requests)]), title)
        : node("p", "session-meta", missing));
      categories.append(group);
    }
    content.append(categories, node("p", "session-meta", data.contentFilters.samples
      ? `Content filter triggered: ${format.format(data.contentFilters.triggered || 0)} / ${format.format(data.contentFilters.samples)} recorded events`
      : "Content filter status: not recorded"));
    content.append(node("p", "session-meta", data.agents.distinctAgents === null
      ? "Agent identities: not recorded"
      : `Recorded agent identities: ${format.format(data.agents.distinctAgents)} / ${format.format(data.agents.events || 0)} associated events`));
  }
  if (!chartsShown) content.append(charts);
  const notes = section("READING THESE NUMBERS");
  for (const text of data.notes) notes.append(node("p", "session-meta", text));
  notes.append(node("p", "session-meta", "Daily sessions use the session creation date. Usage metrics use the event timestamp. Undated events appear in totals, not charts. Missing token categories can make combined daily totals partial. Trend lines show seven-day averages of available values, with shorter windows at the start. Unavailable values are gaps; zero-event days count as zero."));
  content.append(notes);
}

export async function loadDashboard() {
  const current = ++version;
  $("dashboard-error").hidden = true;
  $("dashboard-content").setAttribute("aria-busy", "true");
  try {
    const data = await api("/api/dashboard", new URLSearchParams(new FormData($("dashboard-filters"))));
    if (current === version) render(data);
  } catch (error) {
    if (current !== version) return;
    $("dashboard-content").replaceChildren();
    $("dashboard-error").textContent = error.message;
    $("dashboard-error").hidden = false;
  } finally {
    if (current === version) $("dashboard-content").setAttribute("aria-busy", "false");
  }
}

$("dashboard-filters").addEventListener("submit", event => { event.preventDefault(); loadDashboard(); });
$("dashboard-filters").addEventListener("change", () => loadDashboard());
$("dashboard-reset").addEventListener("click", () => { $("dashboard-filters").reset(); loadDashboard(); });
