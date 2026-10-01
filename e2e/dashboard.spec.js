import { test, expect } from "@playwright/test";

test("result hover backgrounds leave room around content without shifting or overflowing", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search memory").fill("Implementation notes");
  await page.getByRole("button", { name: /^Search/ }).click();
  const card = page.locator(".result").first();
  await expect(card.locator(".excerpt code.language-javascript")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Switch to dark mode" }).click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await card.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      const bounds = await card.boundingBox();
      const title = await card.locator(".result-title").boundingBox();
      const bottom = await card.locator(".result-bottom").boundingBox();
      expect(title.x - bounds.x).toBeGreaterThanOrEqual(12);
      expect(bounds.x + bounds.width - bottom.x - bottom.width).toBeGreaterThanOrEqual(12);
      await card.hover();
      await expect(card).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(23, 27, 36)");
      expect(await card.boundingBox()).toEqual(bounds);
      expect(await card.locator(".result-title").boundingBox()).toEqual(title);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

test("paper-and-ink archive searches, filters, inspects context, and stays local", async ({ page }, testInfo) => {
  const outside = [];
  const errors = [];
  page.on("request", request => {
    if (new URL(request.url()).hostname !== "127.0.0.1") outside.push(request.url());
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#stat-sessions")).toHaveText("4");
  await expect(page.locator("#connection")).toHaveText("LOCAL / READ-ONLY");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 245, 240)");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".masthead")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("archive.png") });
  await page.getByLabel("Search memory").fill("cache invalidation");
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.locator("#kind").selectOption("user");
  await expect(page.locator("#result-count")).toHaveText("1 sessions / 1 matching entries");
  await expect(page.locator(".result mark").first()).toHaveText("cache");
  await page.locator(".result").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".session-page:not([hidden]) .session-title")).toHaveText("A cache that knows when to let go.");
  await expect(page.locator(".message").first()).toContainText("cache invalidation");
  await page.getByRole("button", { name: "Next turns" }).click();
  await expect(page.locator('[data-turn="11"]')).toBeVisible();
  await page.getByRole("button", { name: "Close A cache that knows when to let go." }).click();
  await expect(page.locator(".session-page")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.locator("#result-count")).toHaveText("4 sessions / 104 matching entries");
  await expect(page.locator(".result")).toHaveCount(4);
  await expect(page.locator("#pagination")).not.toBeVisible();
  await page.locator("#repository").selectOption("example/local-tools");
  await expect(page.locator("#result-count")).toHaveText("1 sessions / 26 matching entries");
  await expect(page.locator("#page-info")).toHaveText("1-1 of 1");
  await page.getByLabel("Search memory").fill("there-is-no-such-entry");
  await page.getByRole("button", { name: /^Search/ }).click();
  await expect(page.locator(".empty")).toContainText("Nothing here yet.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test("theme toggle persists, dashboard is a top-level route, and session tabs preserve independent pages", async ({ page, context }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.locator("#stat-sessions")).toHaveText("4");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(17, 20, 27)");
  await expect(page.locator(".sun-icon")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('[data-metric="inputTokens"] strong')).toHaveText("48,000");
  await expect(page.locator(".billing-note")).toContainText("Estimated usage value / $0.0355");
  await expect(page.locator(".billing-note")).toContainText("16 priced / 48 recorded events");
  await expect(page.getByLabel("USAGE BY MODEL", { exact: true })).toContainText("gpt-5.4-mini");
  await page.screenshot({ path: testInfo.outputPath("dashboard-dark.png") });
  await expect(page.locator("#explorer-page")).not.toBeVisible();
  await page.locator("#dashboard-repository").selectOption("example/local-tools");
  await expect(page.locator('[data-metric="inputTokens"] strong')).toHaveText("12,000");
  await page.reload();
  await expect(page.locator("#dashboard-title")).toBeVisible();
  await expect(page.locator('[data-metric="inputTokens"] strong')).toHaveText("48,000");
  await page.getByRole("link", { name: "Explorer", exact: true }).click();
  await page.getByLabel("Search memory").fill("cache invalidation");
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.locator("#kind").selectOption("user");
  await expect(page.locator("#result-count")).toHaveText("1 sessions / 1 matching entries");
  await page.locator(".result").click();
  await expect(page.locator(".code-block code.language-javascript")).toBeVisible();
  await expect(page.locator(".code-block .hljs-keyword").first()).toHaveText("const");
  await expect(page.locator(".markdown h2")).toContainText("Implementation notes");
  const selectedTab = page.locator('.document-tab[data-active="true"]');
  await expect(selectedTab).toHaveCSS("background-color", "rgb(23, 27, 36)");
  await expect(selectedTab).toHaveCSS("box-shadow", "rgb(242, 149, 209) 0px -3px 0px 0px inset");
  await expect(selectedTab.locator(".tab-close")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(selectedTab.locator(".tab-select")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.getByRole("button", { name: "Copy javascript code" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('const ttl = 60;');
  await page.screenshot({ path: testInfo.outputPath("session-dark.png") });
  await page.getByRole("button", { name: "Next turns" }).click();
  await expect(page.locator('[data-turn="11"]')).toBeVisible();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await page.getByLabel("Search memory").fill("responsive archive");
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.locator("#kind").selectOption("user");
  await expect(page.locator("#result-count")).toHaveText("1 sessions / 1 matching entries");
  await page.locator(".result").click();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.getByRole("tab", { name: "A cache that knows when to let go." }).click();
  await expect(page.locator('.session-page:not([hidden]) [data-turn="11"]')).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.goBack();
  await expect(page.locator('.session-page:not([hidden]) [data-turn="11"]')).toBeVisible();
  await page.getByRole("button", { name: "Close Making the archive feel like a notebook." }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 245, 240)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("direct session links work and dashboard explains missing usage instead of displaying zero spending", async ({ page }) => {
  await page.goto("/#session=demo-cache");
  await expect(page.locator(".session-title")).toHaveText("A cache that knows when to let go.");
  await expect(page.getByRole("tab", { name: "A cache that knows when to let go." })).toBeVisible();
  await page.route("**/api/dashboard?*", route => route.fulfill({
    json: {
      available: false, reason: "This CLI database has no assistant usage records table.",
      activity: [{ day: "2026-01-20", sessions: 1 }], filters: { repository: "", from: "", to: "" },
      dollarCost: null, costNote: "Dollar spending is not recorded in this database.", notes: [],
    },
  }));
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.locator("#dashboard-content")).toContainText("Usage analytics unavailable.");
  await expect(page.locator(".billing-note")).toContainText("Estimated usage value / Unavailable");
  await expect(page.locator(".trend-chart")).toBeVisible();
  await expect(page.locator(".metric-card")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("dashboard headers sort actual numbers and estimated dollars with unavailable values last", async ({ page }) => {
  await page.route("**/api/dashboard?*", async route => {
    const response = await route.fetch();
    const data = await response.json();
    const sample = data.models[0];
    data.models = [
      { ...sample, name: "large", requests: 10, metrics: { ...sample.metrics, inputTokens: { ...sample.metrics.inputTokens, total: 1000 } }, estimate: { ...sample.estimate, usd: 1.25 } },
      { ...sample, name: "small", requests: 2, metrics: { ...sample.metrics, inputTokens: { ...sample.metrics.inputTokens, total: 20 } }, estimate: { ...sample.estimate, usd: 0.02 } },
      { ...sample, name: "unavailable", requests: 100, metrics: { ...sample.metrics, inputTokens: { ...sample.metrics.inputTokens, total: null } }, estimate: { ...sample.estimate, usd: null } },
    ];
    await route.fulfill({ json: data });
  });
  await page.goto("/dashboard");
  const models = page.getByLabel("USAGE BY MODEL", { exact: true });
  await expect(models.locator("tbody tr")).toHaveCount(3);
  await models.getByRole("button", { name: "Sort by Events", exact: true }).click();
  await expect(models.locator("tbody tr").first()).toContainText("small");
  await models.getByRole("button", { name: "Sort by Events", exact: true }).click();
  await expect(models.locator("tbody tr").first()).toContainText("unavailable");
  await expect(models.locator('th[aria-sort="descending"]')).toContainText("Events");
  await models.getByRole("button", { name: "Sort by Input", exact: true }).click();
  await expect(models.locator("tbody tr").first()).toContainText("small");
  await expect(models.locator("tbody tr").last()).toContainText("unavailable");
  await models.getByRole("button", { name: "Sort by Input", exact: true }).click();
  await expect(models.locator("tbody tr").first()).toContainText("large");
  await expect(models.locator("tbody tr").last()).toContainText("unavailable");
  await models.getByRole("button", { name: "Sort by Est. USD", exact: true }).click();
  await expect(models.locator("tbody tr").first()).toContainText("small");
  await models.getByRole("button", { name: "Sort by Est. USD", exact: true }).click();
  await expect(models.locator("tbody tr").first()).toContainText("large");
  await expect(models.locator("tbody tr").last()).toContainText("unavailable");
});

test("untrusted conversation text is displayed literally, not executed", async ({ page }) => {
  await page.route("**/api/search?*", route => route.fulfill({
    json: {
      query: "", total: 1, offset: 0, limit: 20,
      results: [{
        kind: "user", source_id: "1", session_id: "demo-cache", turn_index: 0,
        date: "2026-01-20 10:00:00", summary: "<img src=x onerror=alert(1)>",
        excerpt: "<script>window.compromised=true</script>", content_length: 42,
        excerpt_html: "<p>&lt;script&gt;window.compromised=true&lt;/script&gt;</p>",
        repository: "example/widget-api", branch: "main",
      }],
    },
  }));
  await page.goto("/");
  await expect(page.locator(".result h3")).toHaveText("<img src=x onerror=alert(1)>");
  await expect(page.locator(".excerpt")).toContainText("<script>");
  await expect(page.locator(".result img, .result script")).toHaveCount(0);
  expect(await page.evaluate(() => window.compromised)).toBeUndefined();
});

test("Explorer renders Markdown previews with safe independent inspection controls", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search memory").fill("Implementation notes");
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.locator("#kind").selectOption("assistant");
  await expect(page.locator("#result-count")).toHaveText("4 sessions / 4 matching entries");
  const first = page.locator(".result").first();
  await expect(first.locator(".excerpt h2")).toHaveText("Implementation notes");
  await expect(first.locator(".excerpt ul")).toBeVisible();
  await expect(first.locator(".excerpt code.language-javascript")).toBeVisible();
  await expect(first.locator(".excerpt .hljs-keyword").first()).toHaveText("const");
  await expect(first.locator(".excerpt button")).toHaveCount(0);
  await expect(first.locator("button button, button a")).toHaveCount(0);
  await first.getByRole("button", { name: "Inspect session ->", exact: true }).click();
  await expect(page.locator(".session-page:not([hidden])")).toBeVisible();
});

test("cost and activity charts precede breakdown tables and include axes and moving averages", async ({ page }) => {
  await page.goto("/dashboard");
  const charts = page.locator(".trend-chart");
  await expect(charts).toHaveCount(3);
  await expect(charts.first()).toHaveClass(/cost-trend/);
  await expect(charts.first().locator(".chart-unit")).toHaveText("USD (estimated)");
  await expect(charts.first().locator(".chart-y-label")).toHaveCount(5);
  await expect(charts.first().locator(".chart-y-label").first()).toHaveText("$0.00");
  const lastLabel = await charts.first().locator(".chart-y-label").last().textContent();
  expect(Number(lastLabel.replace(/[^0-9.]/g, ""))).toBeGreaterThan(0);
  for (const chart of await charts.all()) {
    expect(await chart.locator(".chart-trendline").getAttribute("d")).toMatch(/^M[\d., ]+L/);
    await expect(chart.locator(".chart-bar")).toHaveCount(30);
  }
  expect(await page.evaluate(() => Boolean(document.querySelector(".chart-grid")
    .compareDocumentPosition(document.querySelector('[aria-label="USAGE BY MODEL"]')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
});

test("select arrows, search clearing and tab close icons stay aligned across widths", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#stat-sessions")).toHaveText("4");
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of ["repository", "kind"]) {
      const control = await page.locator(`#${id}`).boundingBox();
      const arrow = await page.locator(`#${id}`).locator("..").locator(".icon").boundingBox();
      expect(Math.abs((control.y + control.height / 2) - (arrow.y + arrow.height / 2))).toBeLessThan(1);
      expect(arrow.x + arrow.width).toBeLessThan(control.x + control.width);
    }
    await page.getByLabel("Search memory").fill("cache");
    const input = await page.getByLabel("Search memory").boundingBox();
    const clear = await page.getByRole("button", { name: "Clear search", exact: true }).boundingBox();
    expect(clear.x).toBeGreaterThanOrEqual(input.x + input.width);
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(page.getByLabel("Search memory")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Clear search", exact: true })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.goto("/#session=demo-cache");
  await expect(page.locator(".session-title")).toHaveText("A cache that knows when to let go.");
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const tab = page.locator('.document-tab[data-active="true"]');
    const bounds = await tab.boundingBox();
    const close = await tab.locator(".tab-close").boundingBox();
    const glyph = await tab.locator(".tab-close .icon").boundingBox();
    expect(close.width).toBe(36);
    expect(close.x + close.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(Math.abs((close.y + close.height / 2) - (glyph.y + glyph.height / 2))).toBeLessThan(1);
    expect(Math.abs((close.x + close.width / 2) - (glyph.x + glyph.width / 2))).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("pricing trend averages available calendar values and breaks at unpriced days", async ({ page }) => {
  await page.route("**/api/dashboard?*", async route => {
    const response = await route.fetch();
    const data = await response.json();
    const sample = data.daily[0];
    data.activity = [];
    data.daily = Array.from({ length: 10 }, (_, index) => ({
      ...sample, name: `2026-01-${String(index + 1).padStart(2, "0")}`,
      estimate: { ...sample.estimate, usd: index === 4 ? null : index + 1 },
    }));
    await route.fulfill({ json: data });
  });
  await page.goto("/dashboard");
  const path = page.locator(".cost-trend .chart-trendline");
  await expect(path).toHaveAttribute("d", /M/);
  const coordinates = await path.getAttribute("d");
  expect(coordinates.match(/M/g)).toHaveLength(2);
  const lastY = Number(coordinates.trim().split(",").at(-1));
  expect(lastY).toBeCloseTo(195 - ((4 + 6 + 7 + 8 + 9 + 10) / 6 / 10) * 170, 2);
});
