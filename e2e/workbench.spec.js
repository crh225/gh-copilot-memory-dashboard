import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/index", route => route.fulfill({ json: {
    state: "complete", indexed: 16, processed: 16, total: 16, target: 16, running: false,
  } }));
});

const config = { provider: "ollama", endpoint: "http://127.0.0.1:11434",
  decisionEndpoint: "http://127.0.0.1:11434", chatModel: "", embeddingModel: "", decisionModel: "" };
const citation = { id: "S1", session_id: "demo-cache", source_id: "1", kind: "assistant",
  turn_index: 0, summary: "Cache source", excerpt: "Invalidate cached reads after writes." };
const checkedAnswer = {
  answer: "Invalidate **after writes** [S1].",
  answer_html: "<p>Invalidate <strong>after writes</strong> [S1].</p>",
  claims: [{ text: "Invalidate **after writes**.", text_html: "<p>Invalidate <strong>after writes</strong>.</p><pre><code class=\"language-js\">cache.clear();</code></pre>",
    source_ids: ["S1"], evidence: { state: "checked", assessment: "supported",
      probabilities: { supported: 0.8, contradicted: 0.1, insufficient: 0.1 } } },
  { text: "There is no invalidation.", text_html: "<p>There is no invalidation.</p>",
    source_ids: ["S1"], evidence: { state: "checked", assessment: "contradicted",
      probabilities: { supported: 0.1, contradicted: 0.7, insufficient: 0.2 } } }],
  citations: [citation], notice: "Local AI synthesis. Check the original sources.",
};

test("api visibly searches, supports cancellation and preserves the question for retry", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/ask", route => {
    calls++;
    if (calls > 1) return route.fulfill({ json: checkedAnswer });
  });
  await page.goto("/workbench");
  await page.getByLabel("Question", { exact: true }).fill("api");
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.getByRole("button", { name: "Searching history..." })).toBeDisabled();
  await expect(page.locator(".answer-content")).toContainText("Retrieving history");
  await page.getByRole("button", { name: "Cancel request" }).click();
  await expect(page.locator("#workbench-error")).toHaveText("Ask History cancelled.");
  await expect(page.locator("#workbench-error")).toBeInViewport();
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue("api");
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.locator(".claim-check")).toHaveCount(2);
});

test("a history deadline displays an in-view error and allows a successful retry", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/ask", route => {
    calls++;
    if (calls > 1) return route.fulfill({ json: checkedAnswer });
  });
  await page.goto("/workbench");
  await page.clock.install();
  await page.getByLabel("Question", { exact: true }).fill("api");
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel request" })).toBeVisible();
  await page.clock.fastForward(180001);
  await expect(page.locator("#workbench-error")).toContainText("timed out after 180 seconds");
  await expect(page.locator("#workbench-error")).toBeInViewport();
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue("api");
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.locator(".claim-check")).toHaveCount(2);
});

for (const failure of ["network", "json", "incomplete"]) {
  test(`${failure} failures cannot leave a blank successful history answer`, async ({ page }) => {
    await page.route("**/api/ask", route => failure === "network" ? route.abort("failed") :
      failure === "json" ? route.fulfill({ contentType: "application/json", body: "<broken>" }) :
        route.fulfill({ json: { answer_html: "", citations: [citation] } }));
    await page.goto("/workbench");
    await page.getByLabel("Question", { exact: true }).fill("api");
    await page.getByRole("button", { name: "Ask history", exact: true }).click();
    await expect(page.locator("#workbench-error")).toContainText({
      network: "Could not reach the local dashboard", json: "unreadable JSON", incomplete: "incomplete history answer",
    }[failure]);
    await expect(page.locator("#workbench-error")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Ask history", exact: true })).toBeEnabled();
    await expect(page.locator(".answer-content")).toBeEmpty();
  });
}

test("Ask History replaces unused tools and palette entries without disturbing document navigation", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".result")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /Pin source|Add to context pack/ })).toHaveCount(0);
  await page.locator(".result").first().getByRole("button", { name: "Inspect session ->" }).click();
  await expect(page.locator(".session-resume code")).toContainText("gh copilot -- --resume=");
  await expect(page.getByRole("button", { name: "Compare checkpoints", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Ask History", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ask your history." })).toBeVisible();
  await expect(page.locator("#tool-navigation")).toHaveCount(0);
  await expect(page.locator("#ai-configuration")).not.toHaveAttribute("open");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("button", { name: /Context packs|Timeline|notebook|Compare|investigations/ })).toHaveCount(0);
  await page.getByLabel("Find a command").fill("Search archive");
  await page.getByLabel("Find a command").press("Enter");
  await expect(page.locator("#query")).toBeFocused();
  await expect(page.locator("#explorer-page")).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("inline configuration discovers role-safe decision models and saves independent endpoints", async ({ page }) => {
  let saved;
  let indexWrites = 0;
  await page.route("**/api/settings", async route => {
    if (route.request().method() === "POST") saved = route.request().postDataJSON();
    await route.fulfill({ json: config });
  });
  await page.route("**/api/models?*", route => route.fulfill({ json: { models: [
    { name: "local-chat", capabilities: ["completion"] },
    { name: "local-embed", capabilities: ["embedding"] },
    { name: "local-decisions", capabilities: ["decision"] },
  ] } }));
  await page.route("**/api/index", route => {
    if (route.request().method() === "POST") indexWrites++;
    return route.fulfill({ json: { state: "complete", indexed: 104, processed: 104, total: 104, embedded: 104, reused: 0 } });
  });
  await page.goto("/workbench");
  await page.getByText("Configure local models & history index", { exact: true }).click();
  await page.getByRole("button", { name: "Detect installed models", exact: true }).click();
  await page.locator(".model-choice").filter({ hasText: "local-chat" }).getByRole("button", { name: "Use for chat" }).click();
  await page.locator(".model-choice").filter({ hasText: "local-embed" }).getByRole("button", { name: "Use for embeddings" }).click();
  const decisions = page.locator(".model-choice").filter({ hasText: "local-decisions" });
  await expect(decisions.getByRole("button", { name: "Use for chat" })).toBeDisabled();
  await expect(decisions.getByRole("button", { name: "Use for embeddings" })).toBeDisabled();
  await decisions.getByRole("button", { name: "Use for decisions" }).click();
  await page.getByLabel("Ollama decision endpoint").fill("http://127.0.0.1:11435");
  await page.getByRole("button", { name: "Save local AI settings", exact: true }).click();
  await expect(page.locator("#workbench-status")).toContainText("settings saved");
  expect(saved).toMatchObject({ chatModel: "local-chat", embeddingModel: "local-embed",
    decisionModel: "local-decisions", decisionEndpoint: "http://127.0.0.1:11435" });
  await expect(page.locator("#ai-configuration")).toContainText("104 processed");
  expect(indexWrites).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("answers render Markdown and per-claim evidence, and survive inspecting their citations", async ({ page }) => {
  await page.route("**/api/ask", route => route.fulfill({ json: checkedAnswer }));
  await page.goto("/workbench");
  await page.getByLabel("Question", { exact: true }).fill("How should cache invalidation work?");
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.locator(".answer-content .markdown strong")).toHaveText("after writes");
  await expect(page.getByRole("button", { name: "Copy js code" })).toBeVisible();
  await expect(page.locator(".claim-check").first()).toContainText("Evidence check: Supported");
  await expect(page.locator(".claim-check").first()).toContainText("Supported: 80.0%");
  await expect(page.locator(".claim-check").last()).toContainText("Evidence check: Contradicted");
  await expect(page.locator(".answer-content")).toContainText("not proof of correctness");
  await page.getByText("Read the cited excerpt", { exact: true }).click();
  await expect(page.locator(".source-excerpt")).toHaveText(citation.excerpt);
  await page.locator(".answer-content").getByRole("button", { name: "Cache source", exact: true }).click();
  await expect(page.locator('.session-page:not([hidden]) [data-turn="0"]')).toBeVisible();
  await page.getByRole("link", { name: "Ask History", exact: true }).click();
  await expect(page.locator(".claim-check")).toHaveCount(2);
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue("How should cache invalidation work?");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("decision mode returns a noul with explicit insufficient evidence and never requests chat", async ({ page }) => {
  let chatCalls = 0;
  let body;
  await page.route("**/api/ask", route => { chatCalls++; return route.fulfill({ json: checkedAnswer }); });
  await page.route("**/api/decision", route => {
    body = route.request().postDataJSON();
    expect(route.request().headers()["x-copilot-memory"]).toBe("local");
    return route.fulfill({ json: { decision: { noul: 0.08, assessment: "insufficient",
      probabilities: { yes: 0.07, no: 0.13, insufficient: 0.8 } },
      citations: [citation], notice: "Only indexed, retrieved excerpts were evaluated." } });
  });
  await page.goto("/workbench");
  await page.getByLabel("Question", { exact: true }).fill("Was the cache policy implemented?");
  await page.getByLabel("Repository (optional exact name)").fill("example/widget-api");
  await page.getByLabel("Response mode").selectOption("decision");
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.locator(".answer-content")).toContainText("Model P(yes): 8.0%");
  await expect(page.locator(".answer-content")).toContainText("Insufficient evidence");
  await expect(page.locator(".answer-content")).toContainText("not proof of no");
  await expect(page.locator(".answer-content")).toContainText("Insufficient: 80.0%");
  expect(body).toEqual({ question: "Was the cache policy implemented?", repository: "example/widget-api" });
  expect(chatCalls).toBe(0);
});

test("decision failures stay explicit and can be retried without a success-shaped fallback", async ({ page }) => {
  let fail = true;
  await page.route("**/api/decision", route => route.fulfill(fail
    ? { status: 502, json: { error: "The configured decision model is unavailable.", code: "BACKEND_UNAVAILABLE" } }
    : { json: { decision: { noul: 0.9, assessment: "yes" }, citations: [citation], notice: "Model judgment." } }));
  await page.goto("/workbench");
  await page.getByLabel("Question", { exact: true }).fill("Are cached reads invalidated after writes?");
  await page.getByLabel("Response mode").selectOption("decision");
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.locator("#workbench-error")).toHaveText("The configured decision model is unavailable.");
  await expect(page.locator(".answer-content")).toBeEmpty();
  await expect(page.getByRole("button", { name: "Ask history", exact: true })).toBeEnabled();
  fail = false;
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.locator("#workbench-error")).toBeHidden();
  await expect(page.locator(".answer-content")).toContainText("Model P(yes): 90.0%");
});

test("answers without a decision model explicitly show unchecked evidence", async ({ page }) => {
  await page.route("**/api/ask", route => route.fulfill({ json: {
    answer_html: "<p>A cited <strong>answer</strong> [S1].</p>",
    evidence: { state: "unchecked", reason: "Select a decision model to assess cited claims." },
    citations: [citation], notice: "Citations identify records, not verified truth.",
  } }));
  await page.goto("/workbench");
  await page.getByLabel("Question", { exact: true }).fill("What was decided?");
  await page.getByRole("button", { name: "Ask history", exact: true }).click();
  await expect(page.locator(".answer-content strong").first()).toHaveText("answer");
  await expect(page.locator(".claim-check")).toContainText("Evidence check: Unchecked");
  await expect(page.locator(".claim-check")).toContainText("Select a decision model");
});

test("index controls remain inline, require explicit action, and respect running and cancellation states", async ({ page }) => {
  let state = { state: "not_indexed", processed: 0, total: 0, running: false };
  await page.route("**/api/settings", route => route.fulfill({ json: config }));
  await page.route("**/api/index", route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (body.cancel) state = { state: "cancelled", processed: 4, total: 16, running: false };
      else {
        expect(body.repository).toBe("example/widget-api");
        state = { state: "running", processed: 4, total: 16, running: true };
      }
    }
    return route.fulfill({ json: state });
  });
  await page.goto("/workbench");
  await page.getByText("Configure local models & history index", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop indexing", exact: true })).toBeDisabled();
  await page.getByLabel("Repository scope (blank for all history)").fill("example/widget-api");
  await page.getByRole("button", { name: "Index / refresh history", exact: true }).click();
  await expect(page.getByRole("button", { name: "Index / refresh history", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop indexing", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Stop indexing", exact: true }).click();
  await expect(page.locator("#ai-configuration")).toContainText("cancelled / 4 processed");
  await expect(page.getByRole("button", { name: "Index / refresh history", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop indexing", exact: true })).toBeDisabled();
});

test("Ask History shows total indexing progress while configuration is closed and unlocks after completion", async ({ page }) => {
  let state = { state: "running", running: true, processed: 15, indexed: 15,
    target: 15000, total: 15000, embedded: 15, reused: 1 };
  await page.route("**/api/index", route => route.fulfill({ json: state }));
  await page.goto("/workbench");
  await expect(page.locator(".index-readiness")).toContainText("15 of 15,000 source entries (0.1%)");
  await expect(page.locator(".index-readiness")).toContainText("1 reused chunks");
  await expect(page.getByRole("button", { name: "Ask history", exact: true })).toBeDisabled();
  await expect(page.getByRole("progressbar", { name: "History indexing progress" })).toBeVisible();
  await expect(page.locator("#ai-configuration")).not.toHaveAttribute("open");
  state = { state: "complete", running: false, processed: 15000, indexed: 14999,
    target: 15000, total: 15000, skippedChangedSources: 1 };
  await expect(page.locator(".index-readiness")).toContainText("Index ready: 14,999 usable sources");
  await expect(page.locator(".index-readiness")).toContainText("1 changed sources were excluded");
  await expect(page.getByRole("button", { name: "Ask history", exact: true })).toBeEnabled();
  await expect(page.getByRole("progressbar", { name: "History indexing progress" })).toBeHidden();
});

test("both response modes submit full multi-paragraph questions without word or character caps", async ({ page }) => {
  const received = [];
  await page.route("**/api/ask", route => {
    received.push(route.request().postDataJSON().question);
    return route.fulfill({ json: checkedAnswer });
  });
  await page.route("**/api/decision", route => {
    received.push(route.request().postDataJSON().question);
    return route.fulfill({ json: { decision: { noul: 0.8, assessment: "yes" },
      citations: [citation], notice: "Model judgment." } });
  });
  await page.goto("/workbench");
  const question = "Please explain what my history records about cache invalidation after successful writes, the reasoning behind that policy, and its failure boundaries.\n\nCompare the original request with the recorded response and distinguish what was proposed from what was actually implemented.";
  const input = page.getByLabel("Question", { exact: true });
  await expect(input).not.toHaveAttribute("maxlength");
  await input.fill(question);
  for (const mode of ["answer", "decision"]) {
    await page.getByLabel("Response mode").selectOption(mode);
    await page.getByRole("button", { name: "Ask history", exact: true }).click();
    await expect(page.locator(".answer-content")).toContainText(mode === "answer" ? "after writes" : "Model P(yes): 80.0%");
  }
  expect(received).toEqual([question, question]);
});
