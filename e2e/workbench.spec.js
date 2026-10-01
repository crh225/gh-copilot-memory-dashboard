import { test, expect } from "@playwright/test";

test("pins, editable notebooks, context packs, graphs, investigations and command palette work without AI", async ({ page }, testInfo) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".result")).toHaveCount(4);
  const first = page.locator(".result").first();
  await first.getByRole("button", { name: "Pin source", exact: true }).click();
  await expect(page.locator("#workbench-status")).toContainText("Source pinned");
  await first.getByRole("button", { name: "Add to context pack", exact: true }).click();
  await page.getByRole("link", { name: "Workbench", exact: true }).click();
  await page.locator("#tool-navigation").getByRole("button", { name: "Context packs", exact: true }).click();
  await page.getByRole("button", { name: "Build context pack", exact: true }).click();
  await expect(page.getByLabel("Editable context pack")).not.toHaveValue("");
  const original = await page.getByLabel("Editable context pack").inputValue();
  expect(original).toMatch(/\[source\]\(\/#session=/);
  await page.getByLabel("Editable context pack").fill("# Edited pack\n\n**Keep citations**.");
  await page.getByRole("button", { name: "Preview edited pack", exact: true }).click();
  await expect(page.locator(".pack-preview h1")).toHaveText("Edited pack");
  await expect(page.locator(".pack-preview strong")).toHaveText("Keep citations");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Markdown", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("context-pack.md");
  await page.locator("#tool-navigation").getByRole("button", { name: "Decision notebook", exact: true }).click();
  await expect(page.locator(".notebook-record").first()).toBeVisible();
  await page.getByText("Write a decision", { exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(`A synthetic decision ${testInfo.project.name}`);
  await page.getByLabel("Decision / Markdown", { exact: true }).fill("**Invalidate** after commit.");
  await page.getByLabel("Rationale", { exact: true }).fill("Keep reads fresh.");
  await page.getByLabel("Tags (comma separated)").fill("cache, tested");
  await page.getByRole("button", { name: "Save decision", exact: true }).click();
  await expect(page.locator(".notebook-record").filter({ hasText: `A synthetic decision ${testInfo.project.name}` })).toContainText("Invalidate");
  await page.reload();
  await page.locator("#tool-navigation").getByRole("button", { name: "Decision notebook", exact: true }).click();
  await expect(page.locator(".notebook-record").filter({ hasText: `A synthetic decision ${testInfo.project.name}` })).toContainText("Keep reads fresh.");
  await page.locator("#tool-navigation").getByRole("button", { name: "Timeline & graph", exact: true }).click();
  await expect(page.locator(".timeline-entry")).toHaveCount(4);
  await page.locator(".graph-resource").first().locator("summary").click();
  await expect(page.locator(".graph-resource").first().locator(".source-link").first()).toBeVisible();
  await page.locator("#tool-navigation").getByRole("button", { name: "Usage investigations", exact: true }).click();
  await expect(page.locator(".investigation-list .notebook-record")).toHaveCount(4);
  await expect(page.locator(".investigation-list")).toContainText("gpt-5.4-mini");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.getByLabel("Find a command").fill("Search archive");
  await page.getByLabel("Find a command").press("Enter");
  await expect(page.locator("#query")).toBeFocused();
  await expect(page.locator("#explorer-page")).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("settings discover selectable local models, indexing reports progress and hybrid search displays coverage", async ({ page }) => {
  await page.route("**/api/settings", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.chatModel).toBe("local-chat");
      expect(body.embeddingModel).toBe("local-embed");
    }
    await route.fulfill({ json: { provider: "ollama", endpoint: "http://127.0.0.1:11434", chatModel: "", embeddingModel: "" } });
  });
  await page.route("**/api/models?*", route => route.fulfill({ json: { models: [{ name: "local-chat", capabilities: ["completion"] }, { name: "local-embed", capabilities: ["embedding"] }] } }));
  await page.route("**/api/index", route => route.fulfill({ json: { state: "complete", configured: true, processed: 104, total: 104, embedded: 104, reused: 0, scope: "all" } }));
  await page.goto("/workbench");
  await page.locator("#tool-navigation").getByRole("button", { name: "Local AI & index", exact: true }).click();
  await page.getByRole("button", { name: "Detect installed models", exact: true }).click();
  await page.locator(".model-choice").filter({ hasText: "local-chat" }).getByRole("button", { name: "Use for chat" }).click();
  await page.locator(".model-choice").filter({ hasText: "local-embed" }).getByRole("button", { name: "Use for embeddings" }).click();
  await page.getByRole("button", { name: "Save local AI settings", exact: true }).click();
  await expect(page.locator("#workbench-status")).toContainText("settings saved");
  await expect(page.locator("#tool-content")).toContainText('"processed": 104');
  await page.route("**/api/hybrid-search?*", async route => {
    const url = new URL(route.request().url());
    url.pathname = "/api/search";
    const response = await route.fetch({ url: url.toString() });
    const result = await response.json();
    await route.fulfill({ json: { ...result, retrieval: { notice: "Hybrid results / indexed scope: synthetic demo" } } });
  });
  await page.getByRole("link", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Search memory").fill("cache");
  await page.locator("#retrieval").selectOption("hybrid");
  await expect(page.locator("#search-notice")).toContainText("indexed scope");
  await expect(page.locator(".result").first()).toContainText("cache");
});

test("ask-history citations open source documents and checkpoint comparisons render two columns", async ({ page }) => {
  await page.route("**/api/ask", route => route.fulfill({ json: {
    answer: "Invalidate after writes [S1].", answer_html: "<p>Invalidate after writes [S1].</p>",
    citations: [{ id: "S1", session_id: "demo-cache", source_id: "1", kind: "assistant", turn_index: 0, summary: "Cache source" }],
    notice: "AI synthesis; verify sources.",
  } }));
  await page.goto("/workbench");
  await page.getByLabel("Question (up to 200 characters / 12 words)").fill("How should cache invalidation work?");
  await page.getByRole("button", { name: "Ask local model", exact: true }).click();
  await expect(page.locator(".answer-content")).toContainText("Invalidate after writes [S1]");
  await page.locator(".answer-content").getByRole("button", { name: "Cache source", exact: true }).click();
  await expect(page.locator('.session-page:not([hidden]) [data-turn="0"]')).toBeVisible();
  await page.getByRole("link", { name: "Workbench", exact: true }).click();
  await page.route("**/api/session?id=demo-cache", async route => {
    const response = await route.fetch();
    const result = await response.json();
    result.checkpoints.push({ ...result.checkpoints[0], id: 999, checkpoint_number: 2, title: "Updated checkpoint" });
    await route.fulfill({ json: result });
  });

  await page.route("**/api/checkpoint-compare", route => {
    expect(route.request().postDataJSON()).toEqual({ session_id: "demo-cache", from: "1", to: "999" });
    return route.fulfill({ json: { fields: [{ name: "work_done", changed: true, before_html: "<p>Before</p>", after_html: "<p><strong>After</strong></p>" }] } });
  });
  await page.locator("#tool-navigation").getByRole("button", { name: "Compare checkpoints", exact: true }).click();
  await page.getByLabel("Source session ID", { exact: true }).fill("demo-cache");
  await page.getByRole("button", { name: "Load checkpoints", exact: true }).click();
  await page.getByRole("button", { name: "Compare selected checkpoints", exact: true }).click();
  await expect(page.locator(".comparison-grid > div")).toHaveCount(2);
  await expect(page.locator(".comparison-grid strong")).toHaveText("After");
});

test("usage spikes and recorded model transitions explain their evidence without raw JSON", async ({ page }) => {
  await page.route("**/api/usage-insights*", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.spikes = [{ day: "2026-01-23", tokens: 4000, ratio: 4, usd: 0.04,
      baseline: { observedDays: 3, calendarDays: 7, meanTokens: 1000 },
      coverage: { tokenSamples: 4, events: 4 } }];
    data.modelChanges = [{ session_id: "demo-cache", turn_index: 0, from: "local-model-a",
      to: "local-model-b", agent_id: null, created_at: "2026-01-20 10:00:00" }];
    await route.fulfill({ json: data });
  });
  await page.goto("/workbench");
  await page.locator("#tool-navigation").getByRole("button", { name: "Usage investigations", exact: true }).click();
  await expect(page.locator(".usage-spike")).toContainText("4.0x baseline");
  await expect(page.locator(".usage-spike")).toContainText("3 observed days");
  await expect(page.locator(".model-transition")).toContainText("local-model-a -> local-model-b");
  await page.getByRole("button", { name: "Inspect model transition", exact: true }).click();
  await expect(page.locator('.session-page:not([hidden]) [data-turn="0"]')).toBeVisible();
});
