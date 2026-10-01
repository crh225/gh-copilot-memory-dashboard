import { $, node, icon, date, api, format, empty, section } from "./ui.js";
import { loadDashboard } from "./dashboard.js";
import { createWorkbench } from "./workbench.js";

const labels = { summary: "SUMMARY", user: "YOUR PROMPT", assistant: "COPILOT", checkpoint: "CHECKPOINT" };
let searchOffset = 0;
let searchVersion = 0;
let searchController;
let currentSearch = new URLSearchParams();
const documents = new Map();
let activeDocument = "explorer";
let page = location.pathname === "/dashboard" ? "dashboard" : "explorer";
let explorerScroll = 0;
let dashboardScroll = 0;
let workbenchScroll = 0;
let documentNumber = 0;

function highlighted(text, query) {
  const fragment = document.createDocumentFragment();
  const words = [...new Set(query.split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) { fragment.append(document.createTextNode(text)); return fragment; }
  const escaped = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(escaped.join("|"), "gi");
  let start = 0;
  for (const match of text.matchAll(regex)) {
    fragment.append(document.createTextNode(text.slice(start, match.index)));
    fragment.append(node("mark", "", match[0]));
    start = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(text.slice(start)));
  return fragment;
}

async function loadOverview() {
  const data = await api("/api/overview");
  for (const [name, value] of Object.entries(data.counts)) $(`stat-${name}`).textContent = format.format(value);
  $("nav-count").textContent = format.format(data.counts.sessions);
  for (const id of ["repository", "dashboard-repository"]) {
    $(id).replaceChildren(node("option", "", "All repositories"));
    $(id).firstChild.value = "";
    for (const repo of data.repositories) {
      const option = node("option", "", repo);
      option.value = repo;
      $(id).append(option);
    }
  }
  $("connection").textContent = "LOCAL / READ-ONLY";
  $("last-activity").textContent = data.lastActivity ? `LAST ACTIVITY / ${date(data.lastActivity)}` : "ARCHIVE IS EMPTY";
}

async function runSearch({ reset = true } = {}) {
  const version = ++searchVersion;
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  if (reset) {
    searchOffset = 0;
    currentSearch = new URLSearchParams(new FormData($("search-form")));
  }
  const params = new URLSearchParams(currentSearch);
  params.set("group", "session");
  params.set("offset", searchOffset);
  $("error").hidden = true;
  $("clear-query").hidden = !$("query").value;
  $("results").setAttribute("aria-busy", "true");
  $("results").inert = true;
  for (const result of $("results").querySelectorAll("button")) result.disabled = true;
  $("result-count").textContent = "Searching local archive...";
  $("previous").disabled = true;
  $("next").disabled = true;
  try {
    const data = await api(params.get("retrieval") === "hybrid" ? "/api/hybrid-search" : "/api/search", params,
      { signal: controller.signal, label: "History search" });
    if (version !== searchVersion) return;
    $("results").replaceChildren();
    $("search-notice").textContent = data.retrieval?.notice || data.notice || "";
    $("search-notice").hidden = !$("search-notice").textContent;
    $("results-title").textContent = data.query ? "SEARCH RESULTS" : "RECENT CONTEXT";
    $("result-count").textContent = data.group === "session"
      ? `${format.format(data.total)} sessions / ${format.format(data.totalEntries)} matching entries`
      : `${format.format(data.total)} entries`;
    if (!data.results.length) {
      $("results").append(empty("Nothing here yet.", data.total ? "No entries on this page. Reset filters to start again." : "Try different words or filters. New Copilot CLI sessions appear when saved locally."));
    }
    for (const result of data.results) {
      const card = node("article", "result");
      const meta = node("div", "result-meta");
      const time = node("time", "", date(result.date));
      if (result.date) time.dateTime = result.date;
      meta.append(node("span", `badge ${result.kind}`, labels[result.kind]), node("span", "", result.repository || "Local workspace"), time);
      const excerpt = markdownBody(result.excerpt_html, data.query, { copy: false });
      excerpt.classList.add("excerpt");
      const title = node("h3", "result-title");
      const open = node("button", "result-open", result.summary || "Untitled session");
      open.type = "button";
      open.addEventListener("click", () => openSession(result));
      title.append(open);
      if (result.content_length > result.excerpt.length) {
        excerpt.append(node("p", "excerpt-note", "Excerpt only. Open the session for full context."));
      }
      const bottom = node("div", "result-bottom");
      const inspect = node("button", "inspect-session", "Inspect session ->");
      inspect.type = "button";
      inspect.addEventListener("click", () => openSession(result));
      bottom.append(node("span", "", result.branch ? `branch / ${result.branch}` : "local session"),
        node("span", "", result.match_count ? `${format.format(result.match_count)} matches in session` :
          result.turn_index !== null ? `turn ${result.turn_index}` : "saved context"),
        inspect);
      card.append(meta, title, excerpt, bottom);
      card.addEventListener("click", event => {
        if (event.target.closest("a, button, summary") || window.getSelection()?.isCollapsed === false ||
            $("results").getAttribute("aria-busy") === "true") return;
        openSession(result);
      });
      $("results").append(card);
    }
    $("pagination").hidden = data.total <= data.limit;
    $("page-info").textContent = `${data.total ? data.offset + 1 : 0}-${Math.min(data.offset + data.limit, data.total)} of ${format.format(data.total)}`;
    $("previous").disabled = data.offset === 0;
    $("next").disabled = data.offset + data.limit >= data.total;
    $("connection").textContent = "LOCAL / READ-ONLY";
  } catch (error) {
    if (version !== searchVersion) return;
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("error").scrollIntoView({ block: "nearest" });
    $("results").replaceChildren();
    $("pagination").hidden = true;
    $("result-count").textContent = "Archive unavailable";
    $("connection").textContent = "CONNECTION ERROR";
  } finally {
    if (version === searchVersion) {
      searchController = null;
      $("results").setAttribute("aria-busy", "false");
      $("results").inert = false;
    }
  }
}

function markdownBody(html, query, { copy = true } = {}) {
  const body = node("div", "markdown");
  // HTML is rendered and sanitized by the local API; raw history never enters innerHTML.
  body.innerHTML = html;
  if (query) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const text of textNodes) {
      if (!text.parentElement.closest("pre, code")) text.replaceWith(highlighted(text.textContent, query));
    }
  }
  for (const pre of body.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    const wrapper = node("div", "code-block");
    const tools = node("div", "code-tools");
    const language = code?.className.match(/language-([^\s]+)/)?.[1] || "text";
    tools.append(node("span", "", language));
    if (copy) {
      const button = node("button", "", "Copy");
      button.type = "button";
      button.setAttribute("aria-label", `Copy ${language} code`);
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(code?.textContent || pre.textContent);
          button.textContent = "Copied";
        } catch (error) {
          console.warn("Code copy failed:", error.name);
          button.textContent = "Copy unavailable";
        }
      });
      tools.append(button);
    }
    pre.replaceWith(wrapper);
    wrapper.append(tools, pre);
  }
  return body;
}

function message(label, html, query) {
  const container = node("div", "message");
  container.append(node("div", "message-label", label), markdownBody(html, query));
  return container;
}

function sessionMetadata(data) {
  const metadata = node("details", "session-metadata");
  metadata.append(node("summary", "", `FILES & REFERENCES / ${format.format(data.files.length)} files / ${format.format(data.refs.length)} references`));
  const groups = new Map();
  const cwd = (data.session.cwd || "").replaceAll("\\", "/").replace(/\/+$/, "");
  for (const file of data.files) {
    const path = (file.file_path || "").replaceAll("\\", "/");
    const artifact = path.match(/\/\.copilot\/session-state\/[^/]+\/(?:files\/)?(.+)$/);
    const inWorkspace = cwd && path.startsWith(`${cwd}/`);
    const relative = !path.startsWith("/") && !/^[A-Za-z]:\//.test(path);
    const group = artifact ? "Session artifacts" : inWorkspace || relative ? "Workspace files" : "Other locations";
    let compact = artifact ? artifact[1] : inWorkspace ? path.slice(cwd.length + 1) :
      path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/, "~");
    const parts = compact.split("/");
    if (parts.length > 6) compact = `.../${parts.slice(-6).join("/")}`;
    const slash = compact.lastIndexOf("/");
    const entry = node("details", "metadata-file");
    const summary = node("summary");
    const label = node("span", "file-label");
    label.append(node("strong", "", compact.slice(slash + 1) || path),
      node("span", "file-directory", slash >= 0 ? compact.slice(0, slash) : "Recorded relative path"));
    summary.append(label, node("span", "file-action", file.tool_name || "file"));
    entry.append(summary, node("code", "file-full-path", file.file_path || "No path recorded"));
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }
  for (const [name, entries] of groups) {
    const group = node("details", "metadata-group");
    group.append(node("summary", "", `${name} / ${format.format(entries.length)}`), ...entries);
    metadata.append(group);
  }
  if (data.refs.length) {
    const refs = node("details", "metadata-group");
    refs.append(node("summary", "", `References / ${format.format(data.refs.length)}`));
    const list = node("div", "reference-list");
    for (const ref of data.refs) {
      const item = node("div", "reference-item");
      item.append(node("span", "file-action", ref.ref_type), node("code", "", ref.ref_value));
      list.append(item);
    }
    refs.append(list);
    metadata.append(refs);
  }
  if (data.metadataTruncated) metadata.append(node("p", "session-meta", "Showing the first 1,000 files and references."));
  return metadata;
}

function saveScroll() {
  if (page === "dashboard") dashboardScroll = window.scrollY;
  else if (page === "workbench") workbenchScroll = window.scrollY;
  else if (activeDocument === "explorer") explorerScroll = window.scrollY;
  else if (documents.has(activeDocument)) documents.get(activeDocument).scroll = window.scrollY;
}

function updateTabs() {
  const tabs = $("workspace-tabs");
  tabs.replaceChildren();
  tabs.hidden = page === "dashboard" || documents.size === 0;
  $("document-navigation").hidden = page !== "explorer" || documents.size === 0;
  $("document-workspace").dataset.documents = String(page === "explorer" && documents.size > 0);
  const add = (id, label, panelId) => {
    const wrapper = node("div", "document-tab");
    wrapper.setAttribute("role", "presentation");
    wrapper.dataset.active = String(activeDocument === id);
    const button = node("button", "tab-select", label);
    button.type = "button";
    button.id = `${panelId}-tab`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", panelId);
    button.setAttribute("aria-selected", String(activeDocument === id));
    button.tabIndex = activeDocument === id ? 0 : -1;
    button.title = label;
    button.addEventListener("click", () => navigate("explorer", id));
    wrapper.append(button);
    if (id !== "explorer") {
      const close = node("button", "tab-close");
      close.type = "button";
      close.setAttribute("aria-label", `Close ${label}`);
      close.append(icon("close"));
      close.addEventListener("click", () => closeDocument(id));
      wrapper.append(close);
    }
    tabs.append(wrapper);
  };
  add("explorer", "Explorer", "explorer-page");
  for (const [id, doc] of documents) add(id, doc.title, doc.panel.id);
  const picker = $("document-picker");
  picker.replaceChildren(...[["explorer", "Explorer"], ...[...documents].map(([id, doc]) => [id, doc.title])].map(([id, title]) => {
    const option = node("option", "", title);
    option.value = id;
    return option;
  }));
  picker.value = activeDocument;
  $("mobile-document-close").hidden = !documents.has(activeDocument);
  $("mobile-document-close").setAttribute("aria-label", `Close ${documents.get(activeDocument)?.title || "current document"}`);
}

function navigate(nextPage, id = "explorer", { history = true } = {}) {
  saveScroll();
  page = nextPage;
  activeDocument = documents.has(id) ? id : "explorer";
  $("explorer-page").hidden = page !== "explorer" || activeDocument !== "explorer";
  $("dashboard-page").hidden = page !== "dashboard";
  $("workbench-page").hidden = page !== "workbench";
  for (const [key, doc] of documents) doc.panel.hidden = page !== "explorer" || key !== activeDocument;
  for (const [key, link] of [["explorer", $("explorer-link")], ["dashboard", $("dashboard-link")], ["workbench", $("workbench-link")]]) {
    if (page === key) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("workspace-label").textContent = page === "workbench" ? "ASK HISTORY" : page === "dashboard" ? "USAGE DASHBOARD" :
    activeDocument === "explorer" ? "MEMORY EXPLORER" : "SESSION WORKSPACE";
  updateTabs();
  $("explorer-page").setAttribute("role", documents.size ? "tabpanel" : "region");
  $("explorer-page").setAttribute("aria-labelledby", documents.size ? "explorer-page-tab" : "explorer-title");
  const url = page === "workbench" ? "/workbench" : page === "dashboard" ? "/dashboard" : activeDocument === "explorer" ? "/" :
    `/#session=${encodeURIComponent(activeDocument)}`;
  if (history && `${location.pathname}${location.hash}` !== url) window.history.pushState(null, "", url);
  window.scrollTo(0, page === "workbench" ? workbenchScroll : page === "dashboard" ? dashboardScroll :
    activeDocument === "explorer" ? explorerScroll : documents.get(activeDocument).scroll);
  if (page === "dashboard") loadDashboard();
}

function closeDocument(id) {
  const doc = documents.get(id);
  if (!doc) return;
  if (id === activeDocument) navigate("explorer");
  doc.version++;
  doc.panel.remove();
  documents.delete(id);
  updateTabs();
  $("explorer-page").setAttribute("role", documents.size ? "tabpanel" : "region");
  $("explorer-page").setAttribute("aria-labelledby", documents.size ? "explorer-page-tab" : "explorer-title");
  $("workspace-tabs").querySelector('[aria-selected="true"]')?.focus();
  if (!documents.size) $("explorer-link").focus();
}

async function openSession(result) {
  const id = result.session_id;
  if (!documents.has(id)) {
    const panel = node("section", "session-page");
    panel.id = `document-${++documentNumber}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `${panel.id}-tab`);
    panel.hidden = true;
    $("session-pages").append(panel);
    documents.set(id, { panel, title: result.summary || "Untitled session", result,
      query: result.query ?? currentSearch.get("q") ?? "", version: 0, scroll: 0, params: null });
  }
  const doc = documents.get(id);
  const previousResult = doc.result;
  const previousQuery = doc.query;
  doc.result = result;
  doc.query = result.query ?? currentSearch.get("q") ?? "";
  const params = new URLSearchParams({ id: result.session_id });
  if (result.turn_index !== null && result.turn_index !== undefined) params.set("turn", result.turn_index);
  navigate("explorer", id);
  if (!doc.params || previousResult.source_id !== result.source_id || previousResult.kind !== result.kind ||
      previousResult.turn_index !== result.turn_index || previousQuery !== doc.query) {
    doc.panel.replaceChildren(node("h2", "session-title", "Loading session..."));
    await loadSession(doc, params, true);
  }
}

async function loadSession(doc, params, jump = false) {
  const version = ++doc.version;
  try {
    const data = await api("/api/session", params);
    if (version !== doc.version || !documents.has(data.session.id)) return;
    doc.params = params;
    doc.title = data.session.summary || "Untitled session";
    updateTabs();
    const query = doc.query;
    const content = doc.panel;
    content.replaceChildren();
    const heading = node("div", "session-heading");
    const title = node("h2", "session-title", doc.title);
    const refresh = node("button", "", "Refresh session");
    refresh.type = "button";
    refresh.addEventListener("click", () => loadSession(doc, doc.params));
    heading.append(node("div", "eyebrow", "SESSION / DOCUMENT WORKSPACE"), refresh);
    const resume = node("div", "session-resume");
    if (/^[A-Za-z0-9_.-]{1,200}$/.test(data.session.id)) {
      const command = `gh copilot -- --resume=${data.session.id}`;
      const copy = node("button", "", "Copy resume command");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(command);
          copy.textContent = "Copied";
        } catch (problem) {
          console.warn("Resume command copy failed:", problem.name);
          copy.textContent = "Copy unavailable";
          $("workbench-status").textContent = "Clipboard access failed. Select and copy the visible resume command manually.";
          $("workbench-status").hidden = false;
        }
      });
      resume.append(node("code", "", command), copy);
    } else {
      resume.append(node("p", "session-meta", "This session ID contains shell-special characters. Use /resume inside Copilot CLI and paste the ID directly; the terminal shortcut is unavailable."));
    }
    content.append(heading, title, resume, node("p", "session-meta",
      "Run on the host machine with GitHub CLI/Copilot installed. Resuming requires the original session state, not just a history snapshot."),
      node("div", "session-meta",
      `${data.session.repository || "Local workspace"}${data.session.branch ? ` / ${data.session.branch}` : ""}\n${data.session.cwd || ""}\n${date(data.session.created_at)}\nSession: ${data.session.id}`));
    if (data.checkpoints.length) {
      const checkpoints = section("SAVED CHECKPOINTS");
      for (const checkpoint of data.checkpoints) {
        const details = node("details", "checkpoint");
        details.dataset.checkpoint = checkpoint.id;
        details.open = doc.result.kind === "checkpoint" && String(checkpoint.id) === doc.result.source_id;
        details.append(node("summary", "", checkpoint.title || `Checkpoint ${checkpoint.checkpoint_number}`));
        for (const key of ["overview", "history", "work_done", "technical_details", "important_files", "next_steps"]) {
          if (!checkpoint[key]) continue;
          details.append(node("h4", "", key.replaceAll("_", " ")), markdownBody(checkpoint.html[key], query));
        }
        checkpoints.append(details);
      }
      content.append(checkpoints);
    }
    const conversation = section(`CONVERSATION / ${format.format(data.totalTurns)} TURNS`);
    if (!data.turns.length) conversation.append(node("p", "session-meta", "No conversation turns saved."));
    for (const turn of data.turns) {
      const wrapper = node("div");
      wrapper.dataset.turn = turn.turn_index;
      wrapper.append(node("p", "session-meta", `TURN ${turn.turn_index} / ${date(turn.timestamp)}`));
      if (turn.user_message) wrapper.append(message("YOU", turn.user_html, query));
      if (turn.assistant_response) wrapper.append(message("COPILOT", turn.assistant_html, query));
      conversation.append(wrapper);
    }
    if (data.totalTurns > data.limit) {
      const pager = node("div", "pagination");
      for (const [label, offset] of [["Previous turns", data.offset - data.limit], ["Next turns", data.offset + data.limit]]) {
        const button = node("button", "", label);
        button.type = "button";
        button.disabled = offset < 0 || offset >= data.totalTurns;
        button.addEventListener("click", () => loadSession(doc, new URLSearchParams({ id: data.session.id, offset })));
        pager.append(button);
      }
      conversation.append(pager);
    }
    content.append(conversation);
    if (data.files.length || data.refs.length) {
      content.append(sessionMetadata(data));
    }
    const selected = doc.result.kind === "checkpoint"
      ? [...content.querySelectorAll("[data-checkpoint]")].find(item => item.dataset.checkpoint === doc.result.source_id)
      : [...content.querySelectorAll("[data-turn]")].find(item => item.dataset.turn === String(doc.result.turn_index));
    if (page === "explorer" && activeDocument === data.session.id) {
      if (jump && selected) selected.scrollIntoView({ block: "start" });
      else window.scrollTo(0, content.offsetTop);
    }
  } catch (error) {
    if (version !== doc.version) return;
    const retry = node("button", "", "Retry session");
    retry.addEventListener("click", () => loadSession(doc, params, jump));
    doc.panel.replaceChildren(node("h2", "session-title", "Session unavailable"), node("div", "error", error.message), retry);
  }
}

$("search-form").addEventListener("submit", event => { event.preventDefault(); runSearch(); });
$("query").addEventListener("input", () => { $("clear-query").hidden = !$("query").value; });
$("clear-query").addEventListener("click", () => {
  $("query").value = "";
  $("query").focus();
  runSearch();
});
for (const id of ["repository", "kind", "from", "to", "retrieval"]) $(id).addEventListener("change", () => runSearch());
$("reset-filters").addEventListener("click", () => { $("search-form").reset(); runSearch(); });
$("previous").addEventListener("click", () => { searchOffset = Math.max(0, searchOffset - 20); runSearch({ reset: false }); });
$("next").addEventListener("click", () => { searchOffset += 20; runSearch({ reset: false }); });
for (const [id, target] of [["explorer-link", "explorer"], ["dashboard-link", "dashboard"], ["workbench-link", "workbench"]]) {
  $(id).addEventListener("click", event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(target);
    if (target === "workbench") workbench.render();
  });
  $("document-picker").addEventListener("change", () => navigate("explorer", $("document-picker").value));
  $("mobile-document-close").addEventListener("click", () => closeDocument(activeDocument));
}
document.querySelector(".brand").addEventListener("click", event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate("explorer");
});
$("workspace-tabs").addEventListener("keydown", event => {
  const tabs = [...$("workspace-tabs").querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(event.target);
  if (index < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
    (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click();
  $("workspace-tabs").querySelector('[aria-selected="true"]').focus();
});
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    navigate("explorer");
    $("query").focus();
  }
});

function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get("session");
  if (location.pathname === "/workbench") { navigate("workbench", "explorer", { history: false }); workbench.render(); }
  else if (location.pathname === "/dashboard") navigate("dashboard", "explorer", { history: false });
  else if (id && (!documents.has(id) || params.has("turn") || params.has("checkpoint"))) openSession({
    session_id: id, turn_index: params.get("turn"), kind: params.has("checkpoint") ? "checkpoint" : "summary",
    source_id: params.get("checkpoint") || undefined,
  });
  else navigate("explorer", id || "explorer", { history: false });
}
window.addEventListener("popstate", route);

for (const select of document.querySelectorAll(".filters select")) {
  const wrapper = node("span", "select-control");
  select.replaceWith(wrapper);
  wrapper.append(select, icon("chevron-down"));
}

async function initialize() {
  route();
  try {
    await loadOverview();
    await runSearch();
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("result-count").textContent = "Archive unavailable";
    $("connection").textContent = "CONNECTION ERROR";
    $("results").setAttribute("aria-busy", "false");
  }
}
const workbench = createWorkbench({ navigate, openSession, markdownBody,
  getDocuments: () => [...documents].map(([id, doc]) => ({ id, title: doc.title })) });
initialize();
