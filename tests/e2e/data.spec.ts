import { expect, test, type Page } from "@playwright/test";

/** Smoke tests over the demo dataset (run `npm run db:seed` first). */

async function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
}

test("Data page replicates the reference layout", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/data");
  await expect(page.getByRole("heading", { name: "Data" })).toBeVisible();
  for (const t of ["All Platforms", "Google", "Meta", "Shopify", "Other Revenue"])
    await expect(page.getByRole("link", { name: t, exact: true })).toBeVisible();
  for (const t of ["Core", "Ad Creatives", "Lead Gen", "Age", "Gender", "Placements", "Countries", "Audience Types", "Landing Destination"])
    await expect(page.getByRole("navigation", { name: "Breakdowns" }).getByRole("link", { name: t, exact: true })).toBeVisible();
  for (const t of ["Day", "Week", "Month", "Year"]) await expect(page.getByRole("radio", { name: t })).toBeVisible();
  const table = page.getByTestId("data-table");
  for (const h of ["Date", "Spend", "Ad Revenue", "Clicks", "Impr.", "Conv.", "ATC", "IC", "Results", "Results Val."])
    await expect(table.locator("thead th", { hasText: new RegExp(`^${h.replace(".", "\\.")}$`, "i") }).first()).toBeVisible();
  await expect(table.getByText(/\(\d+ records\)/).first()).toBeVisible();
  await expect(page.getByTestId("totals-row")).toContainText("$");
  expect(errors).toEqual([]);
});

test("rows expand into campaign records", async ({ page }) => {
  await page.goto("/data?platform=meta");
  const table = page.getByTestId("data-table");
  const before = await table.locator("tbody tr").count();
  await table.getByRole("button", { name: "Expand" }).first().click();
  await expect.poll(() => table.locator("tbody tr").count()).toBeGreaterThan(before);
});

test("granularity and colour toggles live in the URL", async ({ page }) => {
  await page.goto("/data?platform=meta");
  await page.getByRole("radio", { name: "Week" }).click();
  await expect(page).toHaveURL(/gran=week/);
  await expect(
    page
      .getByTestId("data-table")
      .getByText(/^Week of /)
      .first(),
  ).toBeVisible();
  await page.getByTestId("toggle-color-compare").click();
  await expect(page).toHaveURL(/cvc=1/);
  await expect(page.locator("td.bg-good-bg, td.bg-bad-bg").first()).toBeVisible();
});

test("date presets and comparison", async ({ page }) => {
  await page.goto("/data?platform=meta");
  await page.getByTestId("date-range").click();
  await page.getByRole("button", { name: "Last 7 days" }).click();
  await page.getByRole("button", { name: "Same period last year" }).click();
  await page.getByTestId("date-apply").click();
  await expect(page).toHaveURL(/preset=last_7/);
  await expect(page).toHaveURL(/cmp=yoy/);
  await expect(page.getByTestId("data-table").locator("tbody tr")).toHaveCount(7);
});

test("switching client re-renders in its currency (BRL)", async ({ page }) => {
  await page.goto("/data?platform=meta");
  await page.getByTestId("client-switcher").click();
  await page.getByRole("option", { name: /Casa Verde/ }).click();
  await expect(page).toHaveURL(/client=casa-verde/);
  await expect(page.getByTestId("totals-row")).toContainText("R$");
});

test("Google shows — for metrics the account does not track", async ({ page }) => {
  await page.goto("/data?client=casa-verde&platform=google");
  const cell = page.getByTestId("totals-row").locator("td[title*='conversion action']").first();
  await expect(cell).toHaveText("—");
});

test("every Data sub-tab renders", async ({ page }) => {
  const errors = await collectErrors(page);
  const tabs: Record<string, string[]> = {
    meta: [
      "creatives",
      "lead-gen",
      "age",
      "gender",
      "placements",
      "countries",
      "audience",
      "landing",
      "hour",
      "day-of-week",
      "campaigns",
      "adsets",
      "ads",
    ],
    google: [
      "campaigns",
      "adsets",
      "keywords",
      "search-terms",
      "age",
      "gender",
      "device",
      "countries",
      "hour",
      "day-of-week",
      "campaign-type",
    ],
    shopify: ["core", "products", "new-vs-returning", "discount-codes", "channels", "refunds"],
    other: ["core", "sources"],
    all: ["core", "day-of-week"],
  };
  for (const client of ["aurora-skincare", "casa-verde"])
    for (const [platform, list] of Object.entries(tabs))
      for (const tab of list) {
        await page.goto(`/data?client=${client}&platform=${platform}&tab=${tab}`);
        await expect(page.getByRole("heading", { name: "Data" }), `${client}/${platform}/${tab}`).toBeVisible();
        await expect(
          page
            .getByTestId(tab === "creatives" ? "creatives-grid" : "data-table")
            .or(page.getByRole("note"))
            .first(),
        ).toBeVisible();
      }
  expect(errors).toEqual([]);
});

test("audience types warns when New share is low", async ({ page }) => {
  await page.goto("/data?client=casa-verde&platform=meta&tab=audience");
  await expect(page.getByRole("alert")).toContainText("New audiences");
});

test("placeholder pages and mobile drawer", async ({ page }) => {
  await page.goto("/watchdog");
  await expect(page.getByText(/arrives in phase \d/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/data");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Targets" }).click();
  await expect(page).toHaveURL(/\/targets/);
});
