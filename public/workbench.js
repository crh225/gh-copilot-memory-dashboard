import { $, node, api, requestJson, section, format, date } from "./ui.js";

function write(path, body, options) {
  return requestJson(path, { body, ...options });
}

function field(label, control) {
  const wrapper = node("label", "power-field");
  wrapper.append(node("span", "", label), control);
  return wrapper;
}

function input(name, value = "") {
  const control = node("input");
  control.name = name;
  control.value = value;
  return control;
}

function select(name, options, value) {
  const control = node("select");
  control.name = name;
  for (const [key, text] of options) {
    const option = node("option", "", text);
    option.value = key;
    control.append(option);
  }
  control.value = value;
  return control;
}

export function createWorkbench({ navigate, openSession, getDocuments, markdownBody }) {
  let built = false;
  let requestVersion = 0;
  let timer;
  let refreshReadiness = async () => {};
  const status = text => { $("workbench-status").textContent = text; $("workbench-status").hidden = false; };
  const error = problem => {
    console.warn("Ask History failed:", problem.name);
    $("workbench-error").textContent = problem.message;
    $("workbench-error").hidden = false;
    if (!$("workbench-page").hidden) $("workbench-error").scrollIntoView({ block: "nearest" });
  };
  const attempt = (action, manageDisabled = true) => async event => {
    const control = event?.currentTarget;
    if (manageDisabled && control?.tagName === "BUTTON") control.disabled = true;
    $("workbench-error").hidden = true;
    try { await action(event); }
    catch (problem) { error(problem); }
    finally { if (manageDisabled && control?.isConnected && control.tagName === "BUTTON") control.disabled = false; }
  };
  const button = (label, action, manageDisabled = true) => {
    const control = node("button", "", label);
    control.type = "button";
    control.addEventListener("click", attempt(action, manageDisabled));
    return control;
  };
  const sourceLink = (source, label) => {
    const link = node("a", "source-link", label);
    const params = new URLSearchParams({ session: source.session_id });
    if (source.turn_index !== null && source.turn_index !== undefined) params.set("turn", source.turn_index);
    if (source.kind === "checkpoint") params.set("checkpoint", source.source_id);
    link.href = `/#${params}`;
    link.addEventListener("click", event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      attempt(() => openSession({
        ...source, kind: source.kind || "summary", turn_index: source.turn_index ?? null,
        query: source.matched_terms?.join(" ") || "",
      }))(event);
    });
    return link;
  };
  const linkSources = (sources, retrieval, cited) => {
    const group = section("MATCHING SESSIONS");
    group.classList.add("history-matches");
    if (Number.isSafeInteger(retrieval?.matchedSessions)) {
      group.append(node("p", "session-meta",
        `Showing ${sources.length} of ${format.format(retrieval.matchedSessions)} matching indexed sessions. ` +
        (retrieval.semanticFallback ? "Semantic suggestions only; no literal topic mentions matched." : "Topic mentions are not proof of an implementation or saved credentials.")));
    }
    for (const source of sources) {
      const row = node("div", "source-list");
      row.append(sourceLink(source, source.summary || source.session_id),
        node("p", "session-meta", `[${source.id}] / ${source.kind}${cited.has(source.id) ? " / Cited in answer" : " / Search match (not cited)"}${source.repository ? ` / ${source.repository}` : ""}${source.date ? ` / ${date(source.date)}` : ""}`),
        sourceLink(source, source.turn_index !== null && source.turn_index !== undefined
          ? `Open session at turn ${source.turn_index} ->` : source.kind === "checkpoint" ? "Open saved checkpoint ->" : "Open session ->"));
      if (source.excerpt) {
        const details = node("details");
        details.append(node("summary", "", "Read the cited excerpt"), node("p", "source-excerpt", source.excerpt));
        row.append(details);
      }
      group.append(row);
    }
    return group;
  };
  const percentage = value => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("The local decision service returned an invalid probability.");
    }
    return `${(value * 100).toFixed(1)}%`;
  };
  const evidenceCheck = evidence => {
    const panel = node("div", "claim-check");
    if (!evidence || evidence.state !== "checked") {
      panel.append(node("strong", "", "Evidence check: Unchecked"),
        node("p", "session-meta", evidence?.reason || "No decision model is configured."));
      return panel;
    }
    const labels = { supported: "Supported", contradicted: "Contradicted",
      insufficient: "Insufficient evidence", uncertain: "Uncertain" };
    panel.dataset.assessment = evidence.assessment;
    panel.append(node("strong", "", `Evidence check: ${labels[evidence.assessment] || "Uncertain"}`));
    const probabilities = evidence.probabilities;
    if (probabilities) panel.append(node("p", "session-meta",
      `Supported: ${percentage(probabilities.supported)} / Contradicted: ${percentage(probabilities.contradicted)} / Insufficient: ${percentage(probabilities.insufficient)}`));
    panel.append(node("p", "session-meta", "Local decision-model judgment about the cited excerpts, not proof of correctness."));
    return panel;
  };

  async function render() {
    if (built) { refreshReadiness().catch(error); return; }
    built = true;
    const panel = section("ASK YOUR HISTORY / LOCAL MODELS");
    panel.append(node("p", "session-meta",
      "Get cited explanations or source-backed decisions. The decision model judges retrieved evidence; probabilities are not verified facts."));
    const form = node("form", "power-form");
    const question = node("textarea");
    question.name = "question";
    question.rows = 5;
    question.required = true;
    const repository = input("repository");
    const mode = select("mode", [["answer", "Answer with evidence checks"], ["decision", "Decision / probability of yes"]], "answer");
    const modeHint = node("p", "session-meta", "Decision mode needs a yes/no question. The noul measures whether retrieved evidence establishes yes, not whether the proposition is universally true.");
    modeHint.hidden = true;
    mode.addEventListener("change", () => { modeHint.hidden = mode.value !== "decision"; });
    const submit = node("button", "", "Ask history");
    submit.type = "submit";
    submit.disabled = true;
    let indexReady = false;
    let asking = false;
    let activeRequest;
    const cancelRequest = node("button", "", "Cancel request");
    cancelRequest.type = "button";
    cancelRequest.hidden = true;
    cancelRequest.addEventListener("click", () => activeRequest?.abort());
    const setAsking = value => {
      asking = value;
      submit.disabled = value || !indexReady;
      submit.textContent = value ? "Searching history..." : "Ask history";
      cancelRequest.hidden = !value;
      question.readOnly = value;
      repository.readOnly = value;
      mode.disabled = value;
      form.setAttribute("aria-busy", String(value));
    };
    const readiness = node("p", "session-meta index-readiness", "Checking history index...");
    readiness.setAttribute("role", "status");
    const meter = node("progress", "index-progress");
    meter.setAttribute("aria-label", "History indexing progress");
    meter.hidden = true;
    let reflectSettingsIndex = () => {};
    const refreshIndex = async () => {
      const state = await api("/api/index");
      const processed = state.processed || 0;
      const target = state.target ?? state.total ?? 0;
      const count = `${format.format(processed)} of ${format.format(target)} source entries`;
      indexReady = state.state === "complete" && state.indexed > 0 && !state.running;
      submit.disabled = asking || !indexReady;
      meter.hidden = !state.running;
      meter.max = Math.max(1, target);
      meter.value = Math.min(processed, meter.max);
      readiness.textContent = state.running
        ? `${state.state === "cancelling" ? "Stopping indexing" : "Indexing history"}: ${count} (${target ? (processed / target * 100).toFixed(1) : "0.0"}%) / ${format.format(state.reused || 0)} reused chunks. Ask History becomes available when indexing finishes.`
        : indexReady
          ? `Index ready: ${format.format(state.indexed)} usable sources.${state.skippedChangedSources ? ` ${format.format(state.skippedChangedSources)} changed sources were excluded; refresh to retry them.` : ""}`
          : state.error
            ? `Index stopped after ${count}: ${state.error.message} Open configuration below and refresh to resume saved chunks.`
            : `Index ${state.state.replaceAll("_", " ")} / ${count}. Open configuration below and refresh; Ask History needs a completed, nonempty index.`;
      reflectSettingsIndex(state);
      clearTimeout(timer);
      if (state.running && !document.hidden && !$("workbench-page").hidden) timer = setTimeout(() => refreshIndex().catch(error), 2000);
    };
    refreshReadiness = refreshIndex;
    const requestActions = node("div", "tool-actions");
    requestActions.append(submit, cancelRequest);
    form.append(field("Question", question),
      field("Repository (optional exact name)", repository), field("Response mode", mode), modeHint, requestActions);
    const answer = node("div", "answer-content");
    form.addEventListener("submit", attempt(async event => {
      event.preventDefault();
      if (asking) return;
      const current = ++requestVersion;
      activeRequest = new AbortController();
      setAsking(true);
      const pending = node("p", "session-meta", "Retrieving history, then asking your local models. You can cancel this request.");
      pending.setAttribute("role", "status");
      answer.replaceChildren(pending);
      pending.scrollIntoView({ block: "nearest" });
      try {
        const responseMode = mode.value;
        const result = await write(responseMode === "decision" ? "/api/decision" : "/api/ask",
          { question: question.value, repository: repository.value },
          { signal: activeRequest.signal, timeoutMs: 180000, label: "Ask History" });
        if (current !== requestVersion) return;
        if (!result || !Array.isArray(result.citations) || !result.citations.length ||
            (responseMode === "answer" ? typeof result.answer_html !== "string" || !result.answer_html.trim() : !result.decision)) {
          throw new Error("The local server returned an incomplete history answer. No answer was accepted; retry or check the local server log.");
        }
        answer.replaceChildren();
        answer.append(linkSources(result.matches || result.citations, result.retrieval,
          new Set(result.citations.map(source => source.id))));
        if (responseMode === "decision") {
          const decision = result.decision;
          const labels = { yes: "Evidence favors yes", no: "Evidence favors no",
            insufficient: "Insufficient evidence", uncertain: "Uncertain" };
          answer.append(node("h3", "", labels[decision.assessment] || "Uncertain"),
            node("p", "decision-probability", `Model P(yes): ${percentage(decision.noul)}`),
            node("p", "session-meta", decision.notice || "Probability of yes based only on retrieved evidence. A low score is not proof of no."));
          if (decision.probabilities) answer.append(node("p", "session-meta",
            `Supports yes: ${percentage(decision.probabilities.yes)} / Supports no: ${percentage(decision.probabilities.no)} / Insufficient: ${percentage(decision.probabilities.insufficient)}`));
        } else {
          if (result.claims?.length) {
            for (const claim of result.claims) {
              const item = node("article", "evidence-claim");
              const references = node("p", "session-meta", "Cited sources: ");
              for (const id of claim.source_ids) {
                const source = result.citations.find(citation => citation.id === id);
                if (!source) throw new Error("The local answer references an unavailable source.");
                references.append(sourceLink(source, `[${id}]`), document.createTextNode(" "));
              }
              item.append(claim.text_html ? markdownBody(claim.text_html, "") : node("p", "claim-text", claim.text),
                references, evidenceCheck(claim.evidence));
              answer.append(item);
            }
          } else answer.append(markdownBody(result.answer_html, ""), evidenceCheck(result.evidence));
        }
        answer.append(node("p", "session-meta", result.notice));
      } catch (problem) { if (current === requestVersion) answer.replaceChildren(); throw problem; }
      finally { if (current === requestVersion) { activeRequest = null; setAsking(false); } }
    }));
    const configuration = node("details", "ai-configuration");
    configuration.id = "ai-configuration";
    configuration.append(node("summary", "", "Configure local models & history index"));
    const settingsPanel = node("div");
    let settingsLoaded = false;
    configuration.append(settingsPanel);
    configuration.addEventListener("toggle", () => {
      if (configuration.open && !settingsLoaded) {
        settingsLoaded = true;
        settings(settingsPanel).catch(problem => { settingsLoaded = false; error(problem); });
      } else if (configuration.open) refreshIndex().catch(error);
    });
    async function settings(container) {
      const config = await api("/api/settings");
      const settingsForm = node("form", "power-form");
      const provider = select("provider", [["ollama", "Ollama"], ["openai", "OpenAI-compatible local chat/embedding server"]], config.provider);
      const endpoint = input("endpoint", config.endpoint);
      const chat = input("chatModel", config.chatModel || "");
      const embedding = input("embeddingModel", config.embeddingModel || "");
      const decisionEndpoint = input("decisionEndpoint", config.decisionEndpoint || config.endpoint);
      const decision = input("decisionModel", config.decisionModel || "");
      const models = node("div", "model-list");
      const detect = button("Detect installed models", async () => {
        const [general, decisions] = await Promise.all([
          api("/api/models", new URLSearchParams({ provider: provider.value, endpoint: endpoint.value })),
          api("/api/models", new URLSearchParams({ provider: "ollama", endpoint: decisionEndpoint.value })),
        ]);
        models.replaceChildren();
        const display = (model, decisionOnly) => {
          const row = node("div", "model-choice");
          row.append(node("span", "", model.name), node("span", "session-meta", (model.capabilities || []).join(", ")));
          const role = (label, target, capability) => {
            const choose = button(label, () => { target.value = model.name; });
            const capabilities = model.capabilities || [];
            choose.disabled = capabilities.length > 0 && !capabilities.includes(capability);
            row.append(choose);
          };
          if (!decisionOnly) {
            role("Use for chat", chat, "completion");
            role("Use for embeddings", embedding, "embedding");
          } else role("Use for decisions", decision, "decision");
          models.append(row);
        };
        for (const model of general.models) display(model, false);
        for (const model of decisions.models.filter(item => item.capabilities?.includes("decision"))) display(model, true);
        if (!models.childElementCount) models.append(node("p", "session-meta", "No installed models were reported."));
      });
      const save = node("button", "", "Save local AI settings");
      save.type = "submit";
      settingsForm.append(field("Chat / embedding backend", provider), field("Chat / embedding endpoint", endpoint),
        field("Ollama decision endpoint", decisionEndpoint), detect, models,
        field("Chat model", chat), field("Embedding model", embedding), field("Decision model (optional)", decision), save);
      settingsForm.addEventListener("submit", attempt(async event => {
        event.preventDefault();
        save.disabled = true;
        try {
          await write("/api/settings", { provider: provider.value, endpoint: endpoint.value,
            chatModel: chat.value, embeddingModel: embedding.value,
            decisionEndpoint: decisionEndpoint.value, decisionModel: decision.value });
          status("Local model settings saved. Decision-model changes do not require re-indexing.");
          await refreshIndex();
        } finally { save.disabled = false; }
      }));
      const indexPanel = section("HISTORY INDEX");
      const scope = input("repository_scope");
      const progress = node("p", "session-meta");
      const start = button("Index / refresh history", async () => {
        start.disabled = true;
        try {
          await write("/api/index", { repository: scope.value });
          await refreshIndex();
        } catch (problem) { start.disabled = false; throw problem; }
      }, false);
      const cancel = button("Stop indexing", async () => {
        cancel.disabled = true;
        try {
          await write("/api/index", { cancel: true });
          await refreshIndex();
        } catch (problem) { cancel.disabled = false; throw problem; }
      }, false);
      reflectSettingsIndex = state => {
        progress.textContent = `${state.state.replaceAll("_", " ")} / ${format.format(state.processed || 0)} processed of ${format.format(state.target ?? state.total ?? 0)} source entries / ${format.format(state.indexed || 0)} usable / ${format.format(state.embedded || 0)} new chunks / ${format.format(state.reused || 0)} reused${state.notice ? ` / ${state.notice}` : ""}${state.error ? ` / ${state.error.message}` : ""}`;
        start.disabled = Boolean(state.running);
        cancel.disabled = !state.running || state.state === "cancelling";
      };
      const actions = node("div", "tool-actions");
      actions.append(start, cancel, button("Refresh index status", refreshIndex));
      indexPanel.append(field("Repository scope (blank for all history)", scope), actions, progress);
      container.replaceChildren(node("p", "session-meta",
        "Local endpoints only. No automatic downloads or indexing. Answer mode uses chat; decision mode uses the decision model without chat. Both retrieve from the history index."),
        settingsForm, indexPanel);
      await refreshIndex();
    }
    panel.append(readiness, meter, form, answer, configuration);
    $("tool-content").replaceChildren(panel);
    refreshIndex().catch(error);
  }

  async function show(configuration = false) {
    navigate("workbench");
    await render();
    if (configuration) $("ai-configuration").open = true;
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
  const fillCommands = () => {
    commands = [
      { label: "Search archive", run: () => { navigate("explorer"); $("query").focus(); } },
      { label: "Usage dashboard", run: () => navigate("dashboard") },
      { label: "Ask history", run: () => show() },
      { label: "Configure local models & history index", run: () => show(true) },
      ...getDocuments().map(doc => ({ label: `Switch tab: ${doc.title}`, run: () => navigate("explorer", doc.id) })),
    ].filter(command => command.label.toLowerCase().includes(query.value.toLowerCase()));
    cursor = Math.min(cursor, Math.max(0, commands.length - 1));
    list.replaceChildren(...commands.map((command, index) => {
      const item = button(command.label, () => { palette.close(); return command.run(); });
      item.dataset.selected = String(cursor === index);
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
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !$("workbench-page").hidden) refreshReadiness().catch(error);
  });
  return { show, render };
}
