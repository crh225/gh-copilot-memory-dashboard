import { test, expect } from "@playwright/test";

test("files and references are collapsed, grouped, readable, and retain exact paths without HTML execution", async ({ page }) => {
  const artifact = "/home/demo/.copilot/session-state/synthetic-session/files/scratch-worktree/environments/prod/main.tf";
  await page.route("**/api/session?*", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.session.cwd = "/workspace/project";
    data.files = [
      { tool_name: "apply_patch", file_path: "/workspace/project/apis/app/definition.yaml" },
      { tool_name: "apply_patch", file_path: artifact },
      { tool_name: "create", file_path: "C:\\Users\\demo\\projects\\second\\src\\validate.py" },
      { tool_name: "edit", file_path: "/workspace/project/<script>alert(1)</script>.md" },
      { tool_name: "apply_patch", file_path: `/workspace/project/${"long-path-".repeat(40)}/readme.md` },
    ];
    data.refs = [{ ref_type: "commit", ref_value: "abcdef0123456789abcdef0123456789abcdef0123" },
      { ref_type: "pr", ref_value: "216" }, { ref_type: "issue", ref_value: "<script>alert(1)</script>" }];
    data.metadataTruncated = true;
    await route.fulfill({ json: data });
  });
  await page.goto("/#session=demo-cache");
  const metadata = page.locator(".session-metadata");
  await expect(metadata.locator(":scope > summary")).toContainText("5 files / 3 references");
  await expect(metadata).not.toHaveAttribute("open");
  await expect(page.locator(".file-full-path").first()).toBeHidden();
  await metadata.locator(":scope > summary").click();
  await expect(metadata.locator(".metadata-group")).toHaveCount(4);
  for (const label of ["Workspace files / 3", "Session artifacts / 1", "Other locations / 1", "References / 3"]) {
    await metadata.getByText(label, { exact: true }).click();
  }
  const entry = metadata.locator(".metadata-file").filter({ has: page.locator(".file-label strong", { hasText: "main.tf" }) });
  await expect(entry.locator(".file-directory")).toHaveText("scratch-worktree/environments/prod");
  await expect(entry.locator(".file-full-path")).toBeHidden();
  await entry.locator("summary").click();
  await expect(entry.locator(".file-full-path")).toHaveText(artifact);
  await expect(metadata.locator(".file-directory").filter({ hasText: "~/projects/second/src" })).toBeVisible();
  await expect(metadata).toContainText("Showing the first 1,000 files and references.");
  await expect(metadata.locator("script, img")).toHaveCount(0);
  await expect(metadata.locator(".reference-item")).toHaveCount(3);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});
