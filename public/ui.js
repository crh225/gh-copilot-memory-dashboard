export const $ = id => document.getElementById(id);
export const format = new Intl.NumberFormat();
export const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

export function date(value) {
  if (!value) return "Undated";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export async function requestJson(path, { body, signal, timeoutMs = 60000, label = "Local request" } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(path, { cache: "no-store", signal: controller.signal,
      ...(body === undefined ? {} : { method: "POST", headers: {
        "Content-Type": "application/json", "X-Copilot-Memory": "local",
      }, body: JSON.stringify(body) }),
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`The local server returned unreadable JSON (HTTP ${response.status}). Retry or check the local server log.`); }
    if (!response.ok) {
      const error = new Error(typeof data?.error === "string" ? data.error : `Local request failed (HTTP ${response.status}).`);
      error.code = data?.code;
      throw error;
    }
    return data;
  } catch (error) {
    if (signal?.aborted) throw new DOMException(`${label} cancelled.`, "AbortError");
    if (timedOut) throw new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds. The local server or model did not finish; retry or check your local model server.`);
    if (error instanceof TypeError) throw new Error("Could not reach the local dashboard. Check that it is running, then retry.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function api(path, params, options) {
  return requestJson(`${path}${params ? `?${params}` : ""}`, options);
}

export function empty(title, description) {
  const container = node("div", "empty");
  container.append(node("strong", "", title), node("span", "", description));
  return container;
}

export function section(title) {
  const container = node("section", "session-section");
  container.append(node("h3", "", title));
  return container;
}
