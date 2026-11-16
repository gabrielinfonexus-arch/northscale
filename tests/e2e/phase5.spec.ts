import { expect, test } from "@playwright/test";

/** Phase 5: Shopify, Other Revenue, P&L. Requires SHOPIFY_MOCK=1 on the dev server and the demo seed + sandbox client. */

test("Shopify: wrong app secret is rejected; client credentials → backfill → Shopify tabs", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/sync-status?client=mock-brand-sandbox");
  await page.getByTestId("sync-status-table").waitFor();
  test.skip(!(await page.getByText("Shopify mock mode is on").isVisible()), "requires SHOPIFY_MOCK=1");
  await page.getByTestId("connect-shopify").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Store domain").fill("mock-boutique");
  await dialog.getByRole("tab", { name: "App client ID + secret" }).click();
  await dialog.getByLabel("App client ID").fill("client-id-123");
  await dialog.getByLabel("App client secret").fill("wrong");
  await dialog.getByTestId("submit-shopify").click();
  await expect(dialog.getByText(/rejected the credentials/)).toBeVisible();
  await dialog.getByLabel("App client secret").fill("right-secret");
  await dialog.getByTestId("submit-shopify").click();
  await page.waitForURL(/\/connect\/shopify\?credential=/);
  const picker = page.getByTestId("account-picker");
  await expect(picker).toContainText("mock-boutique.myshopify.com");
  await picker.getByRole("checkbox", { name: "Mock Boutique", exact: true }).check();
  await page.getByTestId("link-accounts").click();
  await page.waitForURL(/connected=1/);
  const row = page.getByTestId("conn-mock-boutique.myshopify.com");
  await expect(row.getByTestId("conn-status")).toHaveText("OK", { timeout: 200_000 });
  const conn = await row.getAttribute("data-conn-id");
  await page.goto(`/data?client=mock-brand-sandbox&platform=shopify&tab=channels&accounts=${conn}`);
  for (const ch of ["Meta (paid social)", "Google (cpc)", "Email", "Organic search", "Direct"])
    await expect(page.getByTestId("data-table").getByText(ch, { exact: true })).toBeVisible();
  await page.goto(`/data?client=mock-brand-sandbox&platform=shopify&tab=products&accounts=${conn}`);
  await expect(page.getByTestId("data-table")).toContainText("Hoodie");
});

test("Shopify webhook rejects a bad signature", async ({ request }) => {
  const r = await request.post("/api/webhooks/shopify", {
    headers: { "x-shopify-shop-domain": "mock-store.myshopify.com", "x-shopify-topic": "orders/create", "x-shopify-hmac-sha256": "bad" },
    data: { admin_graphql_api_id: "gid://shopify/Order/1" },
  });
  expect(r.status()).toBe(401);
});

test("Other Revenue: manual entry, CSV import and webhook key", async ({ page }) => {
  await page.goto("/other-revenue?client=mock-brand-sandbox&preset=last_7");
  const source = `E2E-${Date.now()}`;
  await page.getByPlaceholder("Amazon, Mercado Livre, Stripe…").fill(source);
  await page.getByLabel("Revenue").fill("1234,50");
  await page.getByLabel("Orders").fill("3");
  await page.getByTestId("or-save").click();
  await expect(page.getByTestId("or-entries")).toContainText(source);
  await expect(page.getByTestId("or-entries")).toContainText("$1,234.50");

  // CSV with Portuguese headers and BR numbers
  const day = await page.locator('input[type="date"]').first().inputValue();
  const [y, m, d] = day.split("-");
  await page
    .getByLabel("CSV file")
    .setInputFiles({
      name: "receitas.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`Data;Fonte;Receita;Pedidos\n${d}/${m}/${y};${source}-csv;2.000,00;4\nxx;bad;1;1\n`),
    });
  await expect(page.getByTestId("csv-preview")).toContainText("1 valid rows, 1 with errors");
  await page.getByTestId("csv-import").click();
  await expect(page.getByTestId("or-entries")).toContainText(`${source}-csv`);

  // webhook key
  await page.getByTestId("rotate-key").click();
  const key = (await page.getByTestId("webhook-key").locator("code").first().textContent())!.trim();
  expect(key).toMatch(/^nsk_/);
  const ok = await page.request.post("/api/webhooks/other-revenue", {
    headers: { Authorization: `Bearer ${key}` },
    data: { date: day, source: `${source}-hook`, revenue: 99.9, orders: 1 },
  });
  expect(ok.status()).toBe(200);
  const bad = await page.request.post("/api/webhooks/other-revenue", {
    headers: { Authorization: "Bearer nsk_nope" },
    data: { date: day, source: "x", revenue: 1 },
  });
  expect(bad.status()).toBe(401);
  await page.reload();
  await expect(page.getByTestId("or-entries")).toContainText(`${source}-hook`);
  // clean up
  for (const s of [`${source}-hook`, `${source}-csv`, source]) {
    await page.getByRole("button", { name: new RegExp(`^Delete ${s} \\d`) }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^Delete ${s} \\d`) })).toHaveCount(0);
  }
  await page.reload();
  await expect(page.getByTestId("or-entries")).not.toContainText(source);
});

test("P&L renders, and the Dashboard contribution margin matches it", async ({ page }) => {
  await page.goto("/pnl");
  await expect(page.getByTestId("pnl-waterfall").locator(".recharts-bar-rectangle").first()).toBeVisible();
  for (const l of [
    "Gross sales",
    "Net sales",
    "Total revenue",
    "COGS",
    "Gross profit",
    "Shipping cost",
    "Payment fees",
    "Contribution margin",
    "Fixed costs",
    "Net profit",
  ])
    await expect(page.getByTestId("pnl-table").getByText(l, { exact: true })).toBeVisible();
  const cm = (await page
    .getByTestId("pnl-kpis")
    .locator("div", { hasText: /^Contribution margin/ })
    .locator("..")
    .locator(".num")
    .first()
    .textContent())!.trim();
  await page.goto("/dashboard");
  await expect(
    page
      .getByTestId("kpi-cards")
      .locator("div", { hasText: /^Contribution margin$/ })
      .locator("xpath=ancestor::div[2]"),
  ).toContainText(cm);
});

test("Costs: add a cost item and override a product cost (clears the missing-cost warning)", async ({ page }) => {
  await page.goto("/pnl");
  await expect(page.getByRole("alert").filter({ hasText: "without a unit cost" })).toBeVisible();
  await page.goto("/pnl?view=costs");
  const name = `E2E cost ${Date.now()}`;
  await page.getByLabel("Cost name").fill(name);
  await page.getByLabel("Cost type").selectOption("VARIABLE_PER_ORDER");
  await page.getByLabel("Cost amount").fill("0.5");
  await page.getByTestId("add-cost-item").click();
  await expect(page.getByTestId("cost-items")).toContainText(name);

  await page.getByLabel("Unit cost override for Eye Revive Cream").fill("9");
  await page.getByTestId("save-product-costs").click();
  await expect(page.getByRole("status")).toContainText("Saved 1 product cost");
  await page.goto("/pnl");
  await expect(page.getByTestId("pnl-table")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "without a unit cost" })).toHaveCount(0);

  // restore
  await page.goto("/pnl?view=costs");
  await page.getByLabel("Unit cost override for Eye Revive Cream").fill("");
  await page.getByTestId("save-product-costs").click();
  await expect(page.getByRole("status")).toContainText("Saved 1 product cost");
  await page.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(page.getByTestId("cost-items")).not.toContainText(name);
});
