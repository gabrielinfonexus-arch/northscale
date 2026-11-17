import { expect, test, type Page } from "@playwright/test";

/** Phase 7: Hive-Mind + AI Insights. Runs against the scripted model (AI_MOCK=1 on the dev server). */

async function requireMock(page: Page) {
  test.skip(!(await page.getByTestId("ai-mock").isVisible()), "requires AI_MOCK=1");
}

test("Hive-Mind: suggestion → tool calls (collapsed) → table + chart, saved history, delete", async ({ page }) => {
  await page.goto("/hive-mind?new=1");
  await page.getByRole("heading", { name: "Ask anything about your accounts" }).waitFor();
  await requireMock(page);
  await page.getByRole("button", { name: /Qual faixa etária/ }).click();

  const log = page.getByTestId("chat-log");
  await expect(log.getByTestId("ai-chart")).toBeVisible({ timeout: 60_000 });
  await expect(log.getByRole("table")).toContainText("totalRevenue");
  const calls = log.getByTestId("tool-call");
  await expect(calls).toHaveCount(2);
  await expect(calls.first()).toContainText("Listed clients and accounts");
  await expect(calls.first().locator("pre")).toBeHidden(); // collapsed
  await calls.nth(1).locator("summary").click();
  await expect(calls.nth(1).locator("pre")).toContainText('"period"');

  await page.waitForURL(/\/hive-mind\?c=/);
  const url = page.url();
  await page.reload();
  await expect(page.getByTestId("chat-log").getByTestId("user-turn")).toHaveText("Qual faixa etária está mais lucrativa na Meta?");
  await expect(page.getByTestId("chat-log").getByTestId("ai-chart")).toBeVisible();

  const item = page
    .getByTestId("conversation-list")
    .getByRole("link", { name: /Qual faixa etária/ })
    .first();
  await expect(item).toBeVisible();
  const id = new URL(url).searchParams.get("c")!;
  await item.hover();
  await page
    .getByTestId("conversation-list")
    .locator("li", { has: page.locator(`a[href="/hive-mind?c=${id}"]`) })
    .getByRole("button", { name: /Delete/ })
    .click();
  await page.waitForURL(/\/hive-mind$/);
  await expect(page.locator(`a[href="/hive-mind?c=${id}"]`)).toHaveCount(0);
});

test("Hive-Mind: scope limits the data the AI can read", async ({ page }) => {
  await page.goto("/hive-mind?new=1");
  await page.getByRole("heading", { name: "Ask anything about your accounts" }).waitFor();
  await requireMock(page);
  await page.getByLabel("Scope").selectOption({ label: "Casa Verde Home" });
  await page.getByLabel("Message").fill("Como estamos?");
  await page.getByLabel("Message").press("Enter");
  const log = page.getByTestId("chat-log");
  await expect(log.getByTestId("ai-chart")).toBeVisible({ timeout: 60_000 });
  await log.getByTestId("tool-call").first().locator("summary").click();
  const listed = log.getByTestId("tool-call").first().locator("pre");
  await expect(listed).toContainText("casa-verde");
  await expect(listed).not.toContainText("aurora-skincare");
  await expect(log).toContainText("Casa Verde Home");
});

test("AI Insights: generate, feedback, turn into Chart Note", async ({ page }) => {
  await page.goto("/ai-insights?client=aurora-skincare");
  await page.getByRole("heading", { name: "AI Insights" }).waitFor();
  await requireMock(page);
  await page.getByRole("button", { name: "Generate now" }).click();
  await expect(page.getByRole("status").filter({ hasText: /new insight/ })).toBeVisible({ timeout: 60_000 });
  await page.reload(); // interact with the settled list, not mid-refresh
  const card = page
    .getByTestId("insight-card")
    .filter({ hasText: /^.*MER/ })
    .first();
  await expect(card).toContainText("What changed");
  await card.getByRole("button", { name: "Useful", exact: true }).click();
  await expect(card.getByRole("button", { name: "Useful", exact: true })).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "Turn into Chart Note" }).click();
  await expect(card.getByRole("button", { name: "Saved as Chart Note" })).toBeDisabled();
  const title = (await card.locator("h3").textContent())!;
  await page.goto("/chart-notes?client=aurora-skincare");
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  // View data opens the Data page filtered on the insight period
  await page.goto("/ai-insights?client=aurora-skincare");
  await page.getByTestId("insight-card").first().getByRole("link", { name: "View data" }).click();
  await page.waitForURL(/\/data\?client=aurora-skincare&platform=\w+&tab=[\w-]+&from=\d{4}-\d{2}-\d{2}&to=/);
});
