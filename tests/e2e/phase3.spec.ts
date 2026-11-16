import { expect, test } from "@playwright/test";

/**
 * Phase 3: connectors & sync. Run against a dev server with META_MOCK=1 (simulated Graph API)
 * and the demo seed. A sandbox client is created with `npm run client:create -- "Mock Brand Sandbox" USD America/New_York --demo`.
 */

test("sync status lists every connection with actions", async ({ page }) => {
  await page.goto("/sync-status");
  const table = page.getByTestId("sync-status-table");
  await expect(table).toBeVisible();
  for (const name of ["Aurora – US Prospecting", "Casa Verde – Google Ads", "Aurora Skincare (Shopify)"])
    await expect(table.getByText(name, { exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: /Sync .* now/ }).first()).toBeVisible();
});

test("sync now on a demo connection records a job", async ({ page }) => {
  await page.goto("/sync-status");
  const row = page.getByTestId("conn-act_1029384756");
  await row.getByRole("button", { name: /Sync .* now/ }).click();
  await expect(row.getByTestId("conn-status")).toHaveText("OK", { timeout: 20_000 });
  await page.goto("/sync-overview");
  await expect(page.getByTestId("job-log").locator("tbody tr").first()).toContainText("Aurora – US Prospecting");
});

test("OAuth callback rejects a tampered state", async ({ page }) => {
  await page.goto("/api/connect/meta/callback?code=x&state=forged.state");
  await expect(page).toHaveURL(/sync-status\?error=invalid_state/);
  await expect(page.getByRole("alert").filter({ hasText: "expired or was tampered" })).toBeVisible();
});

test("connect start requires edit rights on the client", async ({ page }) => {
  await page.goto("/api/connect/meta/start?client=not-a-client");
  await expect(page.getByRole("alert").filter({ hasText: "permission" })).toBeVisible();
});

test("System User token → pick account → backfill → health shows account problem", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/sync-status?client=mock-brand-sandbox");
  test.skip(!(await page.getByText("Meta mock mode is on").isVisible()), "requires META_MOCK=1");
  await page.getByTestId("connect-meta").click();
  await page.getByLabel("System user token").fill("mock-system-user-token-0123456789");
  await page.getByTestId("submit-token").click();
  await page.waitForURL(/\/connect\/meta\?credential=/);
  await expect(page.getByText("Mock User (system user)")).toBeVisible();
  await expect(page.getByTestId("account-picker")).toContainText("Mock Marca – Brasil");
  // uncheck whatever is already linked, pick only the BRL account (status: Unsettled)
  const picker = page.getByTestId("account-picker");
  for (const name of ["Mock Brand – Prospecting", "Mock Brand – Retargeting"])
    await picker.getByRole("checkbox", { name, exact: true }).uncheck();
  await picker.getByRole("checkbox", { name: "Mock Marca – Brasil", exact: true }).check();
  await page.getByTestId("link-accounts").click();
  await page.waitForURL(/sync-status\?client=mock-brand-sandbox&connected=1/);
  const row = page.getByTestId("conn-act_900100400");
  await expect(row.getByTestId("conn-status")).toHaveText("Error", { timeout: 150_000 });
  await expect(row).toContainText("Unsettled");
  // the data still landed, converted from BRL to the client's reporting currency (USD)
  const connId = await row.getAttribute("data-conn-id");
  await page.goto(`/data?client=mock-brand-sandbox&platform=meta&accounts=${connId}`);
  await expect(page.getByTestId("totals-row")).toContainText("$");
  await expect(page.getByTestId("totals-row")).not.toContainText("R$");
});

test("sync overview shows charts, rate limits and the job log", async ({ page }) => {
  await page.goto("/sync-overview");
  await expect(page.getByTestId("jobs-per-day").locator(".recharts-bar-rectangle").first()).toBeVisible();
  await expect(page.getByTestId("rate-limits").getByRole("progressbar").first()).toBeVisible();
  await expect(page.getByTestId("job-log").locator("tbody tr")).not.toHaveCount(0);
});
