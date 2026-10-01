import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import sanitizeHtml from "sanitize-html";

const markdown = new MarkdownIt({
  html: false,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    return "";
  },
});
markdown.renderer.rules.image = (tokens, index) =>
  `<span class="image-placeholder">[Image: ${markdown.utils.escapeHtml(tokens[index].content || "attachment")} - not loaded for privacy]</span>`;
const renderLink = markdown.renderer.rules.link_open ||
  ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderLink(tokens, index, options, env, self);
};

function normalizeFences(content) {
  // Some saved prompts use apostrophes rather than standard backtick fences.
  let fence = null;
  return content.split("\n").map(line => {
    const match = line.match(/^([ \t]{0,3})(`{3,}|~{3,}|'{3,})(.*)$/);
    if (!match) return line;
    const marker = match[2][0];
    if (!fence) {
      fence = { marker, length: match[2].length };
      return marker === "'" ? `${match[1]}${"`".repeat(match[2].length)}${match[3]}` : line;
    }
    if (marker !== fence.marker || match[2].length < fence.length || match[3].trim()) return line;
    fence = null;
    return marker === "'" ? `${match[1]}${"`".repeat(match[2].length)}` : line;
  }).join("\n");
}

function sanitize(html) {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
      "strong", "em", "s", "blockquote", "ul", "ol", "li", "pre", "code", "span",
      "a", "table", "thead", "tbody", "tr", "th", "td"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      code: ["class"],
      span: ["class"],
      ol: ["start"],
    },
    allowedClasses: { code: ["language-*"], span: ["hljs-*", "image-placeholder"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  });
}

export function renderMarkdown(content) {
  return sanitize(markdown.render(normalizeFences(content)));
}

export function renderExcerpt(content, term, length = 650) {
  const normalized = normalizeFences(content);
  const position = Math.max(0, normalized.toLowerCase().indexOf(term.toLowerCase()));
  const line = normalized.slice(0, position).split("\n").length - 1;
  const tokens = markdown.parse(normalized, {});
  const code = tokens.find(token => ["fence", "code_block"].includes(token.type) &&
    token.map[0] <= line && token.map[1] > line);
  if (code) {
    const match = Math.max(0, code.content.toLowerCase().indexOf(term.toLowerCase()));
    code.content = code.content.slice(Math.max(0, match - 160), Math.max(0, match - 160) + length);
    return { excerpt: code.content, excerpt_html: sanitize(markdown.renderer.render([code], markdown.options, {})) };
  }
  const block = tokens.find(token => token.level === 0 && token.map &&
    token.map[0] <= line && token.map[1] > line);
  const start = block ? normalized.split("\n").slice(0, block.map[0]).join("\n").length +
    (block.map[0] ? 1 : 0) : 0;
  let offset = start;
  if (position - start >= length - term.length) {
    const nearby = Math.max(start, position - 160);
    const newline = normalized.lastIndexOf("\n", nearby);
    offset = newline >= start ? newline + 1 : nearby;
  }
  const excerpt = normalized.slice(offset, offset + length);
  return { excerpt, excerpt_html: renderMarkdown(excerpt) };
}
