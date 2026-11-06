import { test, expect } from "@playwright/test";

test("session deletion requires confirmation, reports errors, and closes only the deleted document", async ({ page }) => {
  let deleted = false;
  let fail = true;
  let attempts = 0;
  await page.route("**/api/session?*", async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    attempts++;
    expect(route.request().headers()["x-copilot-memory"]).toBe("local");
    expect(route.request().postDataJSON()).toEqual({ confirm: true });
    expect(new URL(route.request().url()).searchParams.get("id")).toBe("demo-cache");
    if (fail) return route.fulfill({ status: 409, json: { error: "Close Copilot CLI and retry.", code: "SESSION_STORE_BUSY" } });
    deleted = true;
    await route.fulfill({ json: { deleted: true } });
  });
  await page.route("**/api/search?*", async route => {
    const response = await route.fetch();
    const data = await response.json();
    if (deleted) {
      data.results = data.results.filter(row => row.session_id !== "demo-cache");
      data.total = 3;
    }
    await route.fulfill({ json: data });
  });
  await page.route("**/api/overview", async route => {
    const response = await route.fetch();
    const data = await response.json();
    if (deleted) data.counts.sessions = 3;
    await route.fulfill({ json: data });
  });
  await page.goto("/#session=demo-layout");
  await expect(page.getByRole("heading", { name: "Making the archive feel like a notebook.", exact: true })).toBeVisible();
  await page.locator("#explorer-link").click();
  await page.getByRole("button", { name: "A cache that knows when to let go.", exact: true }).click();
  const remove = page.getByRole("button", { name: "Delete session", exact: true });
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("Permanently delete");
    expect(dialog.message()).toContain("Copilot CLI");
    expect(dialog.message()).toContain("NOT deleted");
    await dialog.dismiss();
  });
  await remove.click();
  expect(attempts).toBe(0);
  await expect(remove).toBeEnabled();
  page.once("dialog", dialog => dialog.accept());
  await remove.click();
  await expect(page.getByRole("alert")).toHaveText("Close Copilot CLI and retry.");
  await expect(remove).toBeEnabled();
  fail = false;
  page.once("dialog", dialog => dialog.accept());
  await remove.click();
  await expect(page.getByRole("tab", { name: "A cache that knows when to let go.", exact: true, includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Making the archive feel like a notebook.", exact: true, includeHidden: true })).toHaveCount(1);
  await expect(page.locator("#nav-count")).toHaveText("3");
  await expect(page.locator("#results").getByRole("button", { name: "A cache that knows when to let go.", exact: true })).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
