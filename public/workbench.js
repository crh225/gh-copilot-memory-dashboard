import { $, node, api, section, format } from "./ui.js";

async function write(path, body) {
  const response = await fetch(path, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Copilot-Memory": "local",
  }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Local request failed (${response.status}).`);
  return data;
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
  const status = text => { $("workbench-status").textContent = text; $("workbench-status").hidden = false; };
  const error = problem => {
    console.warn("Ask History failed:", problem.name);
    $("workbench-error").textContent = problem.message;
    $("workbench-error").hidden = false;
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
  const linkSources = sources => {
    const group = section("ORIGINAL SOURCES");
    for (const source of sources) {
      const row = node("div", "source-list");
      const link = button(source.summary || source.session_id, () => openSession({
        ...source, kind: source.kind || "summary", turn_index: source.turn_index ?? null,
      }));
      link.classList.add("source-link");
      row.append(node("span", "session-meta", `[${source.id}] / ${source.kind} / `), link);
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
    if (built) return;
    built = true;
    const panel = section("ASK YOUR HISTORY / LOCAL MODELS");
    panel.append(node("p", "session-meta",
      "Get cited explanations or source-backed decisions. The decision model judges retrieved evidence; probabilities are not verified facts."));
    const form = node("form", "power-form");
    const question = node("textarea");
    question.name = "question";
    question.rows = 3;
    question.required = true;
    question.maxLength = 200;
    const repository = input("repository");
    const mode = select("mode", [["answer", "Answer with evidence checks"], ["decision", "Decision / probability of yes"]], "answer");
    const modeHint = node("p", "session-meta", "Decision mode needs a yes/no question. The noul measures whether retrieved evidence establishes yes, not whether the proposition is universally true.");
    modeHint.hidden = true;
    mode.addEventListener("change", () => { modeHint.hidden = mode.value !== "decision"; });
    const submit = node("button", "", "Ask history");
    submit.type = "submit";
    form.append(field("Question (up to 200 characters / 12 words)", question),
      field("Repository (optional exact name)", repository), field("Response mode", mode), modeHint, submit);
    const answer = node("div", "answer-content");
    form.addEventListener("submit", attempt(async event => {
      event.preventDefault();
      const current = ++requestVersion;
      submit.disabled = true;
      answer.replaceChildren(node("p", "session-meta", "Retrieving history and evaluating the evidence locally..."));
      try {
        const responseMode = mode.value;
        const result = await write(responseMode === "decision" ? "/api/decision" : "/api/ask",
          { question: question.value, repository: repository.value });
        if (current !== requestVersion) return;
        answer.replaceChildren();
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
              item.append(claim.text_html ? markdownBody(claim.text_html, "") : node("p", "claim-text", claim.text),
                node("p", "session-meta", `Cited sources: ${claim.source_ids.map(id => `[${id}]`).join(" ")}`),
                evidenceCheck(claim.evidence));
              answer.append(item);
            }
          } else answer.append(markdownBody(result.answer_html, ""), evidenceCheck(result.evidence));
        }
        answer.append(node("p", "session-meta", result.notice), linkSources(result.citations || []));
      } catch (problem) { if (current === requestVersion) answer.replaceChildren(); throw problem; }
      finally { if (current === requestVersion) submit.disabled = false; }
    }));
    const configuration = node("details", "ai-configuration");
    configuration.id = "ai-configuration";
    configuration.append(node("summary", "", "Configure local models & history index"));
    const settingsPanel = node("div");
    let settingsLoaded = false;
    configuration.append(settingsPanel);
    configuration.addEventListener("toggle", () => {
      clearTimeout(timer);
      if (configuration.open && !settingsLoaded) {
        settingsLoaded = true;
        settings(settingsPanel, configuration).catch(problem => { settingsLoaded = false; error(problem); });
      } else if (configuration.open) refreshIndex().catch(error);
    });
    let refreshIndex = async () => {};
    async function settings(container, disclosure) {
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
      refreshIndex = async () => {
        const state = await api("/api/index");
        progress.textContent = `${state.state.replaceAll("_", " ")} / ${format.format(state.processed || 0)} processed / ${format.format(state.total || 0)} source entries / ${format.format(state.embedded || 0)} new chunks / ${format.format(state.reused || 0)} reused${state.error ? ` / ${state.error.message}` : ""}`;
        start.disabled = Boolean(state.running);
        cancel.disabled = !state.running || state.state === "cancelling";
        clearTimeout(timer);
        if (state.running && disclosure.open && !document.hidden) timer = setTimeout(() => refreshIndex().catch(error), 2000);
      };
      const actions = node("div", "tool-actions");
      actions.append(start, cancel, button("Refresh index status", refreshIndex));
      indexPanel.append(field("Repository scope (blank for all history)", scope), actions, progress);
      container.replaceChildren(node("p", "session-meta",
        "Local endpoints only. No automatic downloads or indexing. Answer mode uses chat; decision mode uses the decision model without chat. Both retrieve from the history index."),
        settingsForm, indexPanel);
      await refreshIndex();
    }
    panel.append(form, answer, configuration);
    $("tool-content").replaceChildren(panel);
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
  return { show, render };
}
