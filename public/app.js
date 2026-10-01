import { $, node, icon, date, api, format, empty, section } from "./ui.js";
import { loadDashboard } from "./dashboard.js";

const labels = { summary: "SUMMARY", user: "YOUR PROMPT", assistant: "COPILOT", checkpoint: "CHECKPOINT" };
let searchOffset = 0;
let searchVersion = 0;
let currentSearch = new URLSearchParams();
const documents = new Map();
let activeDocument = "explorer";
let page = location.pathname === "/dashboard" ? "dashboard" : "explorer";
let explorerScroll = 0;
let dashboardScroll = 0;
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
    const data = await api("/api/search", params);
    if (version !== searchVersion) return;
    $("results").replaceChildren();
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
    $("results").replaceChildren();
    $("pagination").hidden = true;
    $("result-count").textContent = "Archive unavailable";
    $("connection").textContent = "CONNECTION ERROR";
  } finally {
    if (version === searchVersion) {
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

function saveScroll() {
  if (page === "dashboard") dashboardScroll = window.scrollY;
  else if (activeDocument === "explorer") explorerScroll = window.scrollY;
  else if (documents.has(activeDocument)) documents.get(activeDocument).scroll = window.scrollY;
}

function updateTabs() {
  const tabs = $("workspace-tabs");
  tabs.replaceChildren();
  tabs.hidden = page === "dashboard" || documents.size === 0;
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
}

function navigate(nextPage, id = "explorer", { history = true } = {}) {
  saveScroll();
  page = nextPage;
  activeDocument = documents.has(id) ? id : "explorer";
  $("explorer-page").hidden = page !== "explorer" || activeDocument !== "explorer";
  $("dashboard-page").hidden = page !== "dashboard";
  for (const [key, doc] of documents) doc.panel.hidden = page !== "explorer" || key !== activeDocument;
  for (const [key, link] of [["explorer", $("explorer-link")], ["dashboard", $("dashboard-link")]]) {
    if (page === key) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("workspace-label").textContent = page === "dashboard" ? "USAGE DASHBOARD" :
    activeDocument === "explorer" ? "MEMORY EXPLORER" : "SESSION WORKSPACE";
  updateTabs();
  $("explorer-page").setAttribute("role", documents.size ? "tabpanel" : "region");
  $("explorer-page").setAttribute("aria-labelledby", documents.size ? "explorer-page-tab" : "explorer-title");
  const url = page === "dashboard" ? "/dashboard" : activeDocument === "explorer" ? "/" :
    `/#session=${encodeURIComponent(activeDocument)}`;
  if (history && `${location.pathname}${location.hash}` !== url) window.history.pushState(null, "", url);
  window.scrollTo(0, page === "dashboard" ? dashboardScroll :
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
      query: currentSearch.get("q") || "", version: 0, scroll: 0, params: null });
  }
  const doc = documents.get(id);
  const previousResult = doc.result;
  const previousQuery = doc.query;
  doc.result = result;
  doc.query = currentSearch.get("q") || "";
  const params = new URLSearchParams({ id: result.session_id });
  if (result.turn_index !== null && result.turn_index !== undefined) params.set("turn", result.turn_index);
  navigate("explorer", id);
  if (!doc.params || previousResult.source_id !== result.source_id || previousResult.kind !== result.kind || previousQuery !== doc.query) {
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
    content.append(heading, title, node("div", "session-meta",
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
      const metadata = section("FILES & REFERENCES");
      for (const file of data.files) metadata.append(node("div", "session-meta", `${file.tool_name || "file"} / ${file.file_path}`));
      for (const ref of data.refs) metadata.append(node("div", "session-meta", `${ref.ref_type} / ${ref.ref_value}`));
      if (data.metadataTruncated) metadata.append(node("p", "session-meta", "Showing the first 1,000 files and references."));
      content.append(metadata);
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
for (const id of ["repository", "kind", "from", "to"]) $(id).addEventListener("change", () => runSearch());
$("reset-filters").addEventListener("click", () => { $("search-form").reset(); runSearch(); });
$("previous").addEventListener("click", () => { searchOffset = Math.max(0, searchOffset - 20); runSearch({ reset: false }); });
$("next").addEventListener("click", () => { searchOffset += 20; runSearch({ reset: false }); });
for (const [id, target] of [["explorer-link", "explorer"], ["dashboard-link", "dashboard"]]) {
  $(id).addEventListener("click", event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(target);
  });
}
document.querySelector(".brand").addEventListener("click", event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate("explorer");
});
$("workspace-tabs").addEventListener("keydown", event => {
  const tabs = [...$("workspace-tabs").querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(event.target);
  if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
    (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
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
  const id = new URLSearchParams(location.hash.slice(1)).get("session");
  if (location.pathname === "/dashboard") navigate("dashboard", "explorer", { history: false });
  else if (id && !documents.has(id)) openSession({ session_id: id, turn_index: null, kind: "summary" });
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
initialize();
