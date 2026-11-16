import { expect, test, type Page } from "@playwright/test";

async function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
}

test("dashboard renders every widget with comparisons", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const kpis = page.getByTestId("kpi-cards");
  for (const k of ["Total revenue", "Spend", "MER", "aMER", "nCAC", "Orders", "AOV", "ROAS", "Contribution margin", "New customers"])
    await expect(kpis.getByText(k, { exact: true })).toBeVisible();
  for (const w of [
    "trend",
    "pacing",
    "spend-platform",
    "revenue-channel",
    "platform-vs-shopify",
    "funnel",
    "top-campaigns",
    "top-creatives",
    "top-products",
  ])
    await expect(page.getByTestId(`widget-${w}`)).toBeVisible();
  await expect(page.getByTestId("trend-chart").locator(".recharts-line").first()).toBeVisible();
  await expect(page.getByTestId("pacing").getByRole("progressbar").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("dashboard works for the BRL client and in week granularity", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/dashboard?client=casa-verde&gran=week");
  await expect(page.getByTestId("kpi-cards")).toContainText("R$");
  expect(errors).toEqual([]);
});

test("clicking the trend chart creates a chart note, visible on Chart Notes", async ({ page }) => {
  const title = `E2E note ${Date.now()}`;
  await page.goto("/dashboard");
  const svg = page.getByTestId("trend-chart").locator(".recharts-surface").first();
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New chart note")).toBeVisible();
  await dialog.getByPlaceholder("e.g. Launched summer sale").fill(title);
  await dialog.getByRole("combobox").selectOption("PROMOTION");
  await dialog.getByTestId("note-save").click();
  await expect(dialog).toBeHidden();

  await page.goto("/chart-notes");
  const row = page.getByTestId("notes-list").locator("article", { hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Promotion");
  // clean up
  await row.getByRole("button", { name: `Edit ${title}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("notes-list").locator("article", { hasText: title })).toHaveCount(0);
});

test("chart notes filter by category", async ({ page }) => {
  await page.goto("/chart-notes?client=casa-verde");
  const list = page.getByTestId("notes-list");
  const all = await list.locator("article").count();
  await page.getByRole("button", { name: "Tracking issue" }).click();
  await expect(list.locator("article")).toHaveCount(1);
  await expect(list).toContainText("Pixel");
  expect(all).toBeGreaterThan(1);
});

test("targets: edit, save and persist; breakeven fills the form", async ({ page }) => {
  await page.goto("/targets");
  await expect(page.getByTestId("target-month")).toBeVisible();
  const cpa = page.getByLabel("Meta Meta CPA");
  const original = await cpa.inputValue();
  await cpa.fill("41.5");
  await page.getByTestId("save-targets").click();
  await expect(page.getByRole("status")).toHaveText("Targets saved.");
  await page.reload();
  await expect(page.getByLabel("Meta Meta CPA")).toHaveValue("41.5");
  // breakeven → apply
  await page.getByLabel("AOV").fill("100");
  await page.getByLabel("Gross margin %").fill("50");
  await page.getByLabel("Fixed costs / month").fill("0");
  await page.getByLabel("Profit multiplier").fill("1.1");
  await expect(page.getByTestId("breakeven")).toContainText("2.00x");
  await page.getByTestId("apply-breakeven").click();
  await expect(page.getByLabel("Meta Meta ROAS")).toHaveValue("2.2");
  // restore
  await page.reload();
  await page.getByLabel("Meta Meta CPA").fill(original);
  await page.getByTestId("save-targets").click();
  await expect(page.getByRole("status")).toHaveText("Targets saved.");
});

test("targets month navigation and history", async ({ page }) => {
  await page.goto("/targets");
  const label = await page.getByTestId("target-month").textContent();
  await page.getByRole("link", { name: "Previous month" }).click();
  await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
  await expect(page.getByTestId("target-month")).not.toHaveText(label!);
  await expect(page.getByTestId("targets-history").locator("tbody tr").first()).toBeVisible();
});

test("dashboard layout edit mode", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByTestId("edit-layout").click();
  await expect(page.getByRole("button", { name: "Reset layout" })).toBeVisible();
  await expect(page.locator(".drag-handle").first()).toBeVisible();
  await page.getByTestId("edit-layout").click();
  await expect(page.getByRole("button", { name: "Reset layout" })).toBeHidden();
});
