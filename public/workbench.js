import { $, node, api, section, date, format, empty } from "./ui.js";

async function write(path, body, method = "POST") {
  const response = await fetch(path, { method, headers: {
    "Content-Type": "application/json", "X-Copilot-Memory": "local",
  }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Local request failed (${response.status}).`);
  return data;
}

function button(label, action, className = "") {
  const element = node("button", className, label);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}

function field(label, control) {
  const wrapper = node("label", "power-field");
  wrapper.append(node("span", "", label), control);
  return wrapper;
}

function input(name, value = "", type = "text") {
  const element = node("input");
  element.type = type;
  element.name = name;
  element.value = value;
  return element;
}

function textarea(name, value = "") {
  const element = node("textarea");
  element.name = name;
  element.value = value;
  element.rows = 6;
  return element;
}

function select(name, options, selected = "") {
  const element = node("select");
  element.name = name;
  for (const [value, label] of options) {
    const option = node("option", "", label);
    option.value = value;
    element.append(option);
  }
  element.value = selected;
  return element;
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = node("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createWorkbench({ navigate, openSession, getDocuments, markdownBody }) {
  const selected = new Map();
  const views = [
    ["ask", "Ask history"], ["packs", "Context packs"], ["timeline", "Timeline & graph"],
    ["notebook", "Decision notebook"], ["compare", "Compare checkpoints"],
    ["insights", "Usage investigations"], ["settings", "Local AI & index"],
  ];
  let active = "ask";
  let generation = 0;
  let timer;
  const status = text => { $("workbench-status").textContent = text; $("workbench-status").hidden = false; };
  const error = problem => {
    console.warn("Context tool failed:", problem.name);
    $("workbench-error").textContent = problem.message;
    $("workbench-error").hidden = false;
  };
  const attempt = action => async event => {
    const control = event?.currentTarget;
    if (control?.tagName === "BUTTON") control.disabled = true;
    $("workbench-error").hidden = true;
    try { await action(event); }
    catch (problem) { error(problem); }
    finally { if (control?.isConnected && control.tagName === "BUTTON") control.disabled = false; }
  };
  const sessionButton = source => button(source.summary || source.session_id || source.id,
    attempt(() => openSession({ ...source, session_id: source.session_id || source.id, kind: source.kind || "summary", turn_index: source.turn_index ?? null })),
    "source-link");
  const linkSources = sources => {
    const group = node("div", "source-list");
    for (const source of sources) {
      const row = node("div");
      row.append(node("span", "session-meta", `${source.id ? `[${source.id}] ` : ""}${source.kind || "session"} `), sessionButton(source));
      group.append(row);
    }
    return group;
  };

  async function show(next = active, options = {}) {
    active = next;
    navigate("workbench");
    await render(options);
  }

  async function render(options = {}) {
    const current = ++generation;
    clearTimeout(timer);
    $("workbench-error").hidden = true;
    $("tool-navigation").replaceChildren(...views.map(([id, title]) => {
      const item = button(title, attempt(() => show(id)));
      item.setAttribute("aria-pressed", String(active === id));
      return item;
    }));
    const content = $("tool-content");
    content.replaceChildren(node("p", "session-meta", "Loading local tool..."));
    try {
      const builders = { ask, packs, timeline, notebook, compare, insights, settings };
      const panel = await builders[active](options, current);
      if (current === generation) content.replaceChildren(panel);
    } catch (problem) {
      if (current === generation) { content.replaceChildren(); error(problem); }
    }
  }

  async function ask() {
    const panel = section("ASK YOUR HISTORY / SOURCE-BACKED SYNTHESIS");
    panel.append(node("p", "session-meta", "Answers use your configured local chat model and cite retrieved history. AI synthesis is not a verified decision; inspect its sources."));
    const form = node("form", "power-form");
    const question = textarea("question");
    question.required = true;
    question.maxLength = 200;
    const repository = input("repository");
    const submit = node("button", "", "Ask local model");
    submit.type = "submit";
    form.append(field("Question (up to 200 characters / 12 words)", question), field("Repository (optional exact name)", repository), submit);
    const answer = node("div", "answer-content");
    form.addEventListener("submit", attempt(async event => {
      event.preventDefault();
      submit.disabled = true;
      answer.replaceChildren(node("p", "session-meta", "Retrieving sources and asking the local model..."));
      try {
        const result = await write("/api/ask", { question: question.value, repository: repository.value });
        answer.replaceChildren(markdownBody(result.answer_html || "", ""),
          node("p", "session-meta", result.notice || "Local AI synthesis. Verify the cited records."),
          linkSources(result.citations || []));
        answer.append(button("Save answer as decision", attempt(() => show("notebook", { draft: {
          title: question.value.slice(0, 300), body: `${result.answer}\n\nSources:\n${(result.citations || []).map(source =>
            `- [${source.id}](/#session=${encodeURIComponent(source.session_id)}${source.turn_index !== null ? `&turn=${source.turn_index}` : ""})`).join("\n")}`,
          session_id: result.citations?.[0]?.session_id || "",
          rationale: "AI-generated synthesis; verify linked sources before treating it as a decision.",
        } }))));
      } catch (problem) { answer.replaceChildren(); throw problem; }
      finally { submit.disabled = false; }
    }));
    panel.append(form, answer);
    return panel;
  }

  async function packs() {
    const panel = section("CONTEXT PACK / REVIEW BEFORE SHARING");
    panel.append(node("p", "session-meta", "Select results or open sessions to build a source-linked handoff. Token counts are approximate. Redaction is best-effort; review names, private facts, and secrets yourself."));
    const selection = node("div", "source-list");
    for (const [id, source] of selected) {
      const row = node("div", "pack-selection");
      row.append(sessionButton(source), button("Remove", attempt(() => { selected.delete(id); return render(); })));
      selection.append(row);
    }
    if (!selected.size) selection.append(node("p", "", "No sessions selected yet. Use “Add to context pack” on a result or session."));
    const manual = input("session_id");
    const add = button("Add session ID", attempt(async () => {
      const data = await api("/api/session", new URLSearchParams({ id: manual.value }));
      selected.set(data.session.id, { session_id: data.session.id, summary: data.session.summary });
      await render();
    }));
    const budget = input("token_budget", "4000", "number");
    budget.min = "128";
    budget.max = "32000";
    const redact = input("redact", "", "checkbox");
    redact.checked = true;
    const form = node("form", "power-form");
    const generate = node("button", "", "Build context pack");
    generate.type = "submit";
    generate.disabled = !selected.size;
    form.append(field("Add another source session", manual), add,
      field("Approximate token budget", budget), field("Redact recognizable secrets, email and home paths", redact), generate);
    const output = node("div");
    form.addEventListener("submit", attempt(async event => {
      event.preventDefault();
      generate.disabled = true;
      try {
        const pack = await write("/api/context-pack", { session_ids: [...selected.keys()], token_budget: Number(budget.value), redact: redact.checked });
        const editor = textarea("pack_markdown", pack.markdown);
        editor.rows = 16;
        const count = node("p", "session-meta");
        const update = () => {
          const tokens = Math.ceil(editor.value.length / 4);
          count.textContent = `Approximate tokens: ${format.format(tokens)} / ${format.format(pack.tokenBudget)}${tokens > pack.tokenBudget ? " / OVER BUDGET" : ""}${pack.truncated ? " / Original selection was truncated; omitted material is identified in the pack." : ""}`;
        };
        editor.addEventListener("input", update);
        update();
        const preview = node("div", "pack-preview");
        const tools = node("div", "tool-actions");
        tools.append(button("Preview edited pack", attempt(async () => {
          const result = await write("/api/render-markdown", { markdown: editor.value });
          preview.replaceChildren(markdownBody(result.html, ""));
        })),
          button("Copy edited pack", attempt(async () => { await navigator.clipboard.writeText(editor.value); status("Context pack copied. Review it before sharing."); })),
          button("Export Markdown", () => download(editor.value, "context-pack.md")));
        output.replaceChildren(count, node("p", "session-meta", pack.redactionNote), field("Editable context pack", editor), tools, preview);
      } finally { generate.disabled = false; }
    }));
    panel.append(selection, form, output);
    return panel;
  }

  async function timeline(options) {
    const panel = section("PROJECT TIMELINE & RECORDED WORK GRAPH");
    const form = node("form", "power-form compact-form");
    for (const name of ["repository", "branch", "file", "ref"]) form.append(field(name.toUpperCase(), input(name, options[name] || "")));
    const submit = node("button", "", "Find connected work");
    submit.type = "submit";
    form.append(submit);
    const output = node("div");
    const load = async params => {
      const data = await api("/api/timeline", params);
      output.replaceChildren(node("p", "session-meta", `${format.format(data.total)} sessions${data.truncated ? " / Showing a bounded subset." : ""}. Graph edges represent recorded resources, not inferred causality.`));
      const graph = node("div", "work-graph");
      const sessions = new Map(data.sessions.map(item => [item.id, item]));
      for (const resource of data.nodes.filter(item => item.type !== "session")) {
        const card = node("details", "graph-resource");
        card.append(node("summary", "", `${resource.type} / ${resource.label}`));
        const ids = data.edges.filter(edge => edge.from === resource.id || edge.to === resource.id)
          .map(edge => edge.from === resource.id ? edge.to : edge.from);
        for (const id of ids) {
          const match = sessions.get(id) || data.nodes.find(item => item.id === id && item.type === "session");
          if (match) card.append(sessionButton({ session_id: match.session_id || match.id, summary: match.summary || match.label }));
        }
        graph.append(card);
      }
      output.append(graph);
      const list = node("div", "timeline-list");
      for (const item of data.sessions) {
        const row = node("article", "timeline-entry");
        row.append(node("p", "session-meta", `${date(item.created_at)} / ${item.repository || "Local workspace"} / ${item.branch || "No branch recorded"}`),
          sessionButton({ ...item, session_id: item.id }));
        list.append(row);
      }
      if (!data.sessions.length) list.append(empty("No connected work.", "Try another repository, file, branch, or recorded reference."));
      output.append(list);
    };
    form.addEventListener("submit", attempt(async event => { event.preventDefault(); await load(new URLSearchParams(new FormData(form))); }));
    panel.append(form, output);
    await load(new URLSearchParams(Object.entries(options).filter(([key]) => ["repository", "file", "branch", "ref"].includes(key))));
    return panel;
  }

  async function notebook(options) {
    const panel = section("DECISION NOTEBOOK / YOUR ANNOTATIONS");
    panel.append(node("p", "session-meta", "Saved in a separate local database. Pinned history is a citation plus a snapshot; it is never written back to Copilot."));
    const data = await api("/api/notebook", new URLSearchParams({ q: options.q || "" }));
    const search = input("q", options.q || "");
    const filter = node("form", "power-form compact-form");
    const find = node("button", "", "Search notebook");
    find.type = "submit";
    filter.append(field("Notebook search", search), find);
    filter.addEventListener("submit", attempt(event => { event.preventDefault(); return render({ q: search.value }); }));
    panel.append(filter);
    const draft = options.draft || {};
    const form = node("form", "power-form");
    const title = input("title", draft.title || "");
    title.required = true;
    title.maxLength = 300;
    const body = textarea("body", draft.body || "");
    body.maxLength = 30000;
    const rationale = textarea("rationale", draft.rationale || "");
    rationale.maxLength = 10000;
    const tags = input("tags", (draft.tags || []).join(", "));
    const source = input("session_id", draft.session_id || "");
    const state = select("status", [["active", "Active"], ["superseded", "Superseded"]], draft.status || "active");
    const save = node("button", "", draft.id ? "Save changes" : "Save decision");
    save.type = "submit";
    form.append(field("Title", title), field("Decision / Markdown", body), field("Rationale", rationale),
      field("Tags (comma separated)", tags), field("Source session ID (optional)", source), field("Status", state), save);
    form.addEventListener("submit", attempt(async event => {
      event.preventDefault();
      await write(draft.id ? `/api/notebook/${draft.id}` : "/api/notebook", {
        ...draft, kind: draft.kind || "decision", title: title.value, body: body.value, rationale: rationale.value,
        tags: tags.value.split(",").map(item => item.trim()).filter(Boolean), session_id: source.value,
        source_kind: source.value === draft.session_id ? draft.source_kind || "summary" : "summary",
        source_id: source.value === draft.session_id ? draft.source_id || "" : "",
        turn_index: source.value === draft.session_id ? draft.turn_index ?? null : null, status: state.value,
      }, draft.id ? "PATCH" : "POST");
      status("Decision saved locally.");
      await render();
    }));
    const editor = node("details");
    editor.open = Boolean(options.draft);
    editor.append(node("summary", "", draft.id ? "Edit notebook record" : "Write a decision"), form);
    panel.append(editor, node("p", "session-meta", `${data.total} saved records${data.truncated ? " / Showing first 200; narrow your search." : ""}`));
    for (const note of data.notes) {
      const item = node("article", "notebook-record");
      item.append(node("h3", "", note.title),
        node("p", "session-meta", `${note.kind} / ${note.status} / ${note.tags.join(", ")} / ${date(note.updated_at)}`),
        markdownBody(note.body_html, ""), markdownBody(note.rationale_html, ""));
      if (note.session_id) item.append(sessionButton(note));
      const actions = node("div", "tool-actions");
      actions.append(button("Edit", attempt(() => render({ draft: note }))),
        button("Delete", attempt(async () => {
          if (!window.confirm(`Delete “${note.title}” from the local notebook? Source history will not be changed.`)) return;
          await write(`/api/notebook/${note.id}`, {}, "DELETE");
          await render();
        })));
      item.append(actions);
      panel.append(item);
    }
    return panel;
  }

  async function compare(options) {
    const panel = section("COMPARE CHECKPOINTS / BEFORE & AFTER");
    const id = input("session_id", options.session_id || getDocuments()[0]?.id || "");
    const load = button("Load checkpoints", attempt(async () => {
      const data = await api("/api/session", new URLSearchParams({ id: id.value }));
      const choices = data.checkpoints.map(item => [String(item.id), `${item.checkpoint_number} / ${item.title || "Checkpoint"}`]);
      const from = select("from", choices, choices[0]?.[0]);
      const to = select("to", choices, choices.at(-1)?.[0]);
      const run = button("Compare selected checkpoints", attempt(async () => {
        const diff = await write("/api/checkpoint-compare", { session_id: id.value, from: from.value, to: to.value });
        output.replaceChildren(node("p", "session-meta",
          "Ordered-line replacement counts after matching prefix/suffix; not minimal edits. Reordering counts as change."));
        if (diff.from && diff.to) output.append(node("p", "session-meta",
          `${diff.from.title || `Checkpoint ${diff.from.number}`} -> ${diff.to.title || `Checkpoint ${diff.to.number}`}`));
        for (const item of diff.fields) {
          const group = section(`${item.name.replaceAll("_", " ").toUpperCase()} / ${item.changed ? "CHANGED" : "UNCHANGED"}`);
          if (typeof item.addedLines === "number" && typeof item.removedLines === "number") {
            group.append(node("p", "session-meta",
              `${format.format(item.addedLines)} added / ${format.format(item.removedLines)} removed${item.countsPartial ? " / Counts cover a clipped prefix only." : ""}`));
          }
          if (item.truncated) group.append(node("p", "session-meta", "This field is truncated; inspect the original checkpoint for full context."));
          const columns = node("div", "comparison-grid");
          for (const [label, html] of [["Before", item.before_html], ["After", item.after_html]]) {
            const column = node("div");
            column.append(node("h4", "", label), markdownBody(html || "", ""));
            columns.append(column);
          }
          group.append(columns);
          output.append(group);
        }
      }));
      chooser.replaceChildren();
      if (choices.length < 2) chooser.append(node("p", "session-meta", "This session has fewer than two checkpoints. You can inspect its current saved checkpoint; a meaningful comparison requires another."));
      chooser.append(field("Before checkpoint", from), field("After checkpoint", to), run);
      run.disabled = choices.length < 2;
    }));
    const form = node("div", "power-form compact-form");
    const chooser = node("div", "power-form compact-form");
    const output = node("div");
    form.append(field("Source session ID", id), load);
    panel.append(form, chooser, output);
    return panel;
  }

  async function insights(options) {
    const panel = section("USAGE INVESTIGATIONS / RECORDED ACTIVITY");
    const form = node("form", "power-form compact-form");
    for (const name of ["repository", "from", "to"]) form.append(field(name.toUpperCase(), input(name, options[name] || "", name === "repository" ? "text" : "date")));
    const load = node("button", "", "Investigate usage");
    load.type = "submit";
    form.append(load);
    const data = await api("/api/usage-insights", new URLSearchParams(options));
    form.addEventListener("submit", attempt(event => { event.preventDefault(); return render(Object.fromEntries(new FormData(form))); }));
    panel.append(form, node("p", "session-meta", "Current-rate usage value, not actual billed spending. Cache ratios use only paired valid samples; inspect coverage before comparing."));
    if (!data.available) { panel.append(empty("Usage investigations unavailable.", data.reason)); return panel; }
    const sort = select("sort", [["usd", "Estimated USD"], ["tokens", "Input + output tokens"], ["events", "Recorded events"]], "usd");
    const rows = node("div", "investigation-list");
    const value = number => number === null || number === undefined ? "Not recorded" : format.format(number);
    const fill = () => {
      const metric = item => sort.value === "tokens" ? (item.inputTokens ?? 0) + (item.outputTokens ?? 0) : item[sort.value];
      const ordered = [...data.sessions].sort((a, b) => (metric(b) ?? -1) - (metric(a) ?? -1));
      rows.replaceChildren(...ordered.map(item => {
        const row = node("article", "notebook-record");
        row.append(sessionButton({ ...item, session_id: item.id }),
          node("p", "session-meta", `${value(item.events)} events / ${value(item.inputTokens)} input / ${value(item.outputTokens)} output`),
          node("p", "session-meta", `Estimated USD: ${item.usd === null ? "Unavailable" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(item.usd)} / ${value(item.pricedEvents)} priced / ${value(item.excludedEvents)} excluded`),
          node("p", "session-meta", `Cache read share: ${item.cacheReadShare === null ? "Not recorded" : `${(item.cacheReadShare * 100).toFixed(1)}%`} / ${value(item.cacheSamples)} paired samples / models: ${(item.models || []).map(model => model.model).join(", ") || "Not recorded"}`));
        return row;
      }));
    };
    sort.addEventListener("change", fill);
    fill();
    panel.append(field("Rank sessions by", sort), node("p", "session-meta", `${data.total ?? data.sessions.length} sessions${data.truncated ? " / Bounded subset." : ""}`), rows);
    const spikes = section("DAILY SPIKES");
    if (!data.spikes?.length) spikes.append(node("p", "session-meta", "No qualifying records in this range."));
    for (const entry of data.spikes || []) {
      const row = node("article", "notebook-record usage-spike");
      row.append(node("h4", "", `${entry.day} / ${entry.ratio.toFixed(1)}x baseline`),
        node("p", "session-meta", `${value(entry.tokens)} recorded tokens / ${value(entry.baseline.meanTokens)} daily baseline tokens`),
        node("p", "session-meta", `Baseline: ${entry.baseline.observedDays} observed days within the preceding ${entry.baseline.calendarDays} calendar days / ${entry.coverage.tokenSamples} token samples across ${entry.coverage.events} events`),
        node("p", "session-meta", entry.usd === null ? "Estimated usage value unavailable." :
          `Estimated usage value: ${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(entry.usd)} / not actual billed spending`));
      spikes.append(row);
    }
    const changes = section("RECORDED MODEL CHANGES");
    if (!data.modelChanges?.length) changes.append(node("p", "session-meta", "No qualifying records in this range."));
    for (const entry of data.modelChanges || []) {
      const row = node("article", "notebook-record model-transition");
      row.append(node("h4", "", `${entry.from} -> ${entry.to}`),
        node("p", "session-meta", `${date(entry.created_at)} / ${entry.agent_id ? `Agent: ${entry.agent_id}` : "No agent identity recorded"}`),
        sessionButton({ session_id: entry.session_id, turn_index: entry.turn_index, summary: "Inspect model transition" }));
      changes.append(row);
    }
    panel.append(spikes, changes);
    return panel;
  }

  async function settings(options, current) {
    const panel = section("LOCAL AI / USER-CONFIGURED MODELS");
    panel.append(node("p", "session-meta", "Only loopback or Docker-host model endpoints are accepted. No history is sent until you explicitly index or ask. Models are not downloaded by this app."));
    const config = await api("/api/settings");
    const form = node("form", "power-form");
    const provider = select("provider", [["ollama", "Ollama"], ["openai", "OpenAI-compatible local server"]], config.provider || "ollama");
    const endpoint = input("endpoint", config.endpoint);
    const chat = input("chatModel", config.chatModel || "");
    const embedding = input("embeddingModel", config.embeddingModel || "");
    const models = node("div", "model-list");
    const connect = button("Detect installed models", attempt(async () => {
      const result = await api("/api/models", new URLSearchParams({ provider: provider.value, endpoint: endpoint.value }));
      models.replaceChildren(node("p", "session-meta", "Select a role for an installed model:"));
      for (const model of result.models) {
        const row = node("div", "model-choice");
        row.append(node("span", "", model.name), node("span", "session-meta", (model.capabilities || []).join(", ")),
          button("Use for chat", () => { chat.value = model.name; }),
          button("Use for embeddings", () => { embedding.value = model.name; }));
        models.append(row);
      }
      if (!result.models.length) models.append(node("p", "session-meta", "No installed models were reported. Install models through your local model server, then detect again."));
    }));
    const save = node("button", "", "Save local AI settings");
    save.type = "submit";
    form.append(field("Backend", provider), field("Local endpoint", endpoint), connect, models,
      field("Chat model", chat), field("Embedding model", embedding), save);
    form.addEventListener("submit", attempt(async event => {
      event.preventDefault();
      await write("/api/settings", { provider: provider.value, endpoint: endpoint.value, chatModel: chat.value, embeddingModel: embedding.value });
      status("Local AI settings saved. Rebuild the index after changing embedding models.");
      await render();
    }));
    panel.append(form);
    const index = section("SEMANTIC INDEX / SEPARATE LOCAL STATE");
    const scope = input("repository");
    const progress = node("pre", "plain-preview");
    const start = button("Index / refresh history", attempt(async () => {
      await write("/api/index", { repository: scope.value });
      await refresh();
    }));
    const cancel = button("Stop indexing", attempt(async () => { await write("/api/index", { cancel: true }); await refresh(); }));
    const refresh = async () => {
      const state = await api("/api/index");
      if (current !== generation) return;
      progress.textContent = JSON.stringify(state, null, 2);
      start.disabled = ["running", "cancelling"].includes(state.state);
      cancel.disabled = !["running", "indexing"].includes(state.state);
      clearTimeout(timer);
      if (!document.hidden && ["running", "cancelling"].includes(state.state)) timer = setTimeout(() => refresh().catch(error), 2000);
    };
    index.append(field("Repository scope (blank for all history)", scope), node("div", "tool-actions"));
    index.lastChild.append(start, cancel, button("Refresh index status", attempt(refresh)));
    index.append(progress);
    panel.append(index);
    await refresh();
    return panel;
  }

  async function pin(source) {
    await write("/api/notebook", { kind: "pin", title: (source.summary || "Pinned session").slice(0, 300),
      body: source.excerpt || "", session_id: source.session_id,
      source_kind: source.kind || "summary", source_id: String(source.source_id ?? source.session_id),
      turn_index: source.turn_index ?? null });
    status("Source pinned in your local notebook.");
  }

  function sourceTools(source, compareAvailable = false) {
    const actions = node("div", "tool-actions source-tools");
    const choose = button(selected.has(source.session_id) ? "Selected for context pack" : "Add to context pack", () => {
      if (selected.has(source.session_id)) selected.delete(source.session_id);
      else selected.set(source.session_id, source);
      choose.textContent = selected.has(source.session_id) ? "Selected for context pack" : "Add to context pack";
      choose.setAttribute("aria-pressed", String(selected.has(source.session_id)));
    });
    choose.setAttribute("aria-pressed", String(selected.has(source.session_id)));
    actions.append(button("Pin source", attempt(() => pin(source))), choose);
    if (compareAvailable) actions.append(button("Compare checkpoints", attempt(() => show("compare", { session_id: source.session_id }))));
    return actions;
  }

  const palette = node("dialog", "command-palette");
  palette.setAttribute("aria-label", "Command palette");
  const query = input("command");
  query.setAttribute("aria-label", "Find a command");
  const list = node("div", "command-list");
  palette.append(field("COMMAND PALETTE / ESC TO CLOSE", query), list);
  document.body.append(palette);
  let commands = [];
  let cursor = 0;
  let previousFocus;
  const commandsForVisit = () => [
    { label: "Search archive", run: () => { navigate("explorer"); $("query").focus(); } },
    { label: "Usage dashboard", run: () => navigate("dashboard") },
    ...views.map(([id, label]) => ({ label, run: () => show(id) })),
    ...getDocuments().map(doc => ({ label: `Switch tab: ${doc.title}`, run: () => navigate("explorer", doc.id) })),
  ];
  const fillCommands = () => {
    commands = commandsForVisit().filter(item => item.label.toLowerCase().includes(query.value.toLowerCase()));
    cursor = Math.min(cursor, Math.max(0, commands.length - 1));
    list.replaceChildren(...commands.map((command, index) => {
      const item = button(command.label, attempt(() => { palette.close(); return command.run(); }));
      item.dataset.selected = String(index === cursor);
      return item;
    }));
    if (!commands.length) list.append(node("p", "session-meta", "No matching commands."));
  };
  query.addEventListener("input", () => { cursor = 0; fillCommands(); });
  query.addEventListener("keydown", event => {
    if (["ArrowDown", "ArrowUp"].includes(event.key) && commands.length) {
      event.preventDefault();
      cursor = (cursor + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length;
      fillCommands();
      list.children[cursor].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && commands[cursor]) {
      event.preventDefault();
      palette.close();
      attempt(commands[cursor].run)();
    }
  });
  palette.addEventListener("close", () => { if (previousFocus?.isConnected) previousFocus.focus(); });
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (palette.open) { palette.close(); return; }
      previousFocus = document.activeElement;
      query.value = "";
      cursor = 0;
      fillCommands();
      palette.showModal();
      query.focus();
    }
  });
  return { show, render, sourceTools };
}
