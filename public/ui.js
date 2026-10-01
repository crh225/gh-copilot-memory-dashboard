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

export async function api(path, params) {
  const response = await fetch(`${path}${params ? `?${params}` : ""}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
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
