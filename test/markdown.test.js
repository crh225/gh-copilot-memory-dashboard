import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderExcerpt } from "../lib/markdown.js";

test("renders fenced highlighted code, headings, inline code, lists and tables", () => {
  const html = renderMarkdown("## Decision\n\n- first\n- second\n\n`value`\n\n```javascript\nconst ttl = 60;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(html, /<h2>Decision<\/h2>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<code>value<\/code>/);
  assert.match(html, /<pre><code class="language-javascript">/);
  assert.match(html, /class="hljs-keyword"/);
  assert.match(html, /<table>/);
});

test("unknown languages and apostrophe fences retain literal code safely", () => {
  assert.match(renderMarkdown("```unrecognized\n<img onerror=alert(1)>\n```"), /&lt;img onerror=alert\(1\)&gt;/);
  assert.match(renderMarkdown("'''javascript\nconst value = 1;\n'''"), /language-javascript/);
});

test("raw HTML, script links, event handlers and remote images cannot execute or load", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)">\n\n[bad](javascript:alert(1))\n\n![tracker](https://example.com/tracker)\n\n[good](https://example.com)');
  assert.doesNotMatch(html, /<script|<img|href="javascript|<[^>]*\sonerror="/);
  assert.match(html, /not loaded for privacy/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("apostrophes inside standard Python fences are not rewritten", () => {
  const html = renderMarkdown("```python\ntext = '''\nhello\n'''\n```");
  assert.match(html, /&#x27;&#x27;&#x27;|'''/);
  assert.doesNotMatch(html, /```/);
});

test("search excerpts preserve a distant fenced block's language and safe highlighted code", () => {
  for (const marker of ["```", "'''", "~~~"]) {
    const source = `Earlier context.\n\n${marker}javascript\n${"const previous = 1;\n".repeat(60)}const needle = "<script>";\n${marker}`;
    const result = renderExcerpt(source, "needle");
    assert.ok(result.excerpt.length <= 650);
    assert.match(result.excerpt, /needle/);
    assert.match(result.excerpt_html, /<pre><code class="language-javascript">/);
    assert.match(result.excerpt_html, /hljs-keyword/);
    assert.doesNotMatch(result.excerpt_html, /<script>/);
  }
});

test("search snippets start at Markdown block boundaries rather than inside emphasis", () => {
  const result = renderExcerpt(`${"Previous unrelated paragraph.\n\n".repeat(20)}**Important decision with needle**\n\n- action`, "needle");
  assert.match(result.excerpt_html, /<strong>Important decision with needle<\/strong>/);
  assert.match(result.excerpt_html, /<ul>/);
});
