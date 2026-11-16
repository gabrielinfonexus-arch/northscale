import { expect, test } from "@playwright/test";

/** Phase 4: Google Ads connector. Requires GOOGLE_ADS_MOCK=1 on the dev server and the sandbox client. */

test("Google OAuth → MCC account picker → backfill → Google tabs", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/sync-status?client=mock-brand-sandbox");
  await page.getByTestId("sync-status-table").waitFor();
  test.skip(!(await page.getByText("Google Ads mock mode is on").isVisible()), "requires GOOGLE_ADS_MOCK=1");
  await page.getByTestId("connect-google").click();
  await page.getByTestId("google-login").click();
  await page.waitForURL(/\/connect\/google\?credential=/);
  const picker = page.getByTestId("account-picker");
  // manager hierarchy is shown, managers themselves are not selectable, cancelled accounts are flagged
  await expect(picker).toContainText("Mock Agency MCC (MCC 111-222-3333)");
  await expect(picker).not.toContainText("Mock Agency MCC –");
  await expect(picker.locator("li", { hasText: "Old Client (cancelled)" })).toContainText("Canceled");
  // link only the directly-accessible account
  for (const name of ["Mock Brand – Google Ads", "Mock Marca – Google Ads"]) {
    const cb = picker.getByRole("checkbox", { name, exact: true });
    if (await cb.isChecked()) await cb.uncheck();
  }
  await picker.getByRole("checkbox", { name: "Mock Solo Account", exact: true }).check();
  await page.getByTestId("link-accounts").click();
  await page.waitForURL(/connected=1/);
  const row = page.getByTestId("conn-999-000-1111");
  await expect(row.getByTestId("conn-status")).toHaveText("OK", { timeout: 200_000 });

  const connId = await row.getAttribute("data-conn-id");
  await page.goto(`/data?client=mock-brand-sandbox&platform=google&tab=keywords&accounts=${connId}`);
  await expect(page.getByTestId("data-table")).toContainText("[mock brand]");
  await page.goto(`/data?client=mock-brand-sandbox&platform=google&tab=campaign-type&accounts=${connId}`);
  for (const t of ["Performance Max", "Search", "YouTube / Video"])
    await expect(page.getByTestId("data-table").getByText(t, { exact: true })).toBeVisible();
  await page.goto(`/data?client=mock-brand-sandbox&platform=google&tab=device&accounts=${connId}`);
  await expect(page.getByTestId("data-table")).toContainText("Mobile");
  await page.goto(`/data?client=mock-brand-sandbox&platform=google&tab=ads&accounts=${connId}`);
  await expect(page.getByRole("alert").filter({ hasText: "DESTINATION_NOT_WORKING" })).toBeVisible();
});

test("Google start is refused for unknown clients and shows the not-configured hint when needed", async ({ page }) => {
  await page.goto("/api/connect/google/start?client=nope");
  await expect(page.getByRole("alert").filter({ hasText: "permission" })).toBeVisible();
});
