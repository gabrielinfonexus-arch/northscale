import { expect, test, type Page } from "@playwright/test";

/** Phase 6: Watchdog. Requires the demo seed (npm run db:seed also runs the first Watchdog check). */

const C = "aurora-skincare";
const feed = (page: Page) => page.getByTestId("alert-feed");

async function runChecks(page: Page) {
  await page.getByRole("button", { name: "Run checks now" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Checked/ })).toBeVisible({ timeout: 30_000 });
}

test("feed: alerts with severity, account, View data link and sidebar badge", async ({ page }) => {
  await page.goto(`/watchdog?client=${C}`);
  await runChecks(page);
  const rows = feed(page).getByTestId("alert-row");
  await expect(rows.first()).toBeVisible();
  await expect(feed(page)).toContainText("Ad rejected: IMG | Before & after – rejected claim");
  await expect(feed(page)).toContainText(/Cut candidate:/);

  // all-clients scope shows client names; the sidebar badge counts open critical alerts across clients
  await page.getByTestId("scope-all").click();
  await expect(feed(page)).toContainText("Mock Brand Sandbox");
  const badge = page.getByTestId("nav-badge-watchdog");
  await expect(badge).toBeVisible();

  // View data opens Data filtered on the platform, tab and account
  await page.goto(`/watchdog?client=${C}`);
  const rejected = feed(page).getByRole("article", { name: "Ad rejected: IMG | Before & after – rejected claim" });
  await rejected.getByRole("link", { name: "View data" }).click();
  await page.waitForURL(/\/data\?client=aurora-skincare&platform=meta&tab=ads&preset=last_90&accounts=/);
  await expect(page.getByTestId("data-table")).toContainText("Before & after");
});

test("resolve, mute and reopen; resolved alerts stay resolved while the condition persists", async ({ page }) => {
  await page.goto(`/watchdog?client=${C}`);
  const title = "Ad rejected: IMG | Before & after – rejected claim";
  const row = () => feed(page).getByRole("article", { name: title });

  await row().getByRole("button", { name: "Resolve" }).click();
  await expect(row()).toHaveCount(0);
  await runChecks(page); // condition still true → acknowledged, not reopened
  await expect(row()).toHaveCount(0);
  await page.goto(`/watchdog?client=${C}&status=resolved`);
  await expect(row()).toContainText(/Resolved Nov|Resolved \w{3} \d/);
  await row().getByRole("button", { name: "Reopen" }).click();
  await expect(row()).toHaveCount(0);

  await page.goto(`/watchdog?client=${C}`);
  await row().getByRole("button", { name: "Mute" }).click();
  await page.getByRole("menuitem", { name: "Mute for 3 days" }).click();
  await expect(row()).toHaveCount(0);
  await page.goto(`/watchdog?client=${C}&status=muted`);
  await expect(row()).toContainText("Muted until");
  await row().getByRole("button", { name: "Reopen" }).click();
  await expect(row()).toHaveCount(0);
  await page.goto(`/watchdog?client=${C}`);
  await expect(row()).toBeVisible();
});

test("rules: disabling a rule clears its alerts automatically; thresholds are validated; reset restores", async ({ page }) => {
  await page.goto(`/watchdog?client=${C}&view=rules`);
  const card = page.getByTestId("rule-ad_to_cut");
  await card.getByRole("switch", { name: "Ad to cut enabled" }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("status")).toHaveText(/Saved/);

  await page.goto(`/watchdog?client=${C}`);
  await runChecks(page);
  await expect(feed(page)).not.toContainText("Cut candidate:");
  await page.goto(`/watchdog?client=${C}&status=resolved`);
  await expect(feed(page)).toContainText("Cleared automatically");

  // invalid threshold rejected by the server
  await page.goto(`/watchdog?client=${C}&view=rules`);
  const cpa = page.getByTestId("rule-cpa_above_target");
  await cpa.getByLabel("CPA above target: Look-back").fill("0");
  await cpa.getByRole("button", { name: "Save" }).click();
  await expect(cpa.getByRole("status")).toContainText("must be between");

  // reset → defaults, alerts come back on the next check
  await page.reload();
  await page.getByTestId("rule-ad_to_cut").getByRole("button", { name: "Reset to defaults" }).click();
  await expect(page.getByTestId("rule-ad_to_cut").getByRole("switch", { name: "Ad to cut enabled" })).toBeChecked();
  await page.goto(`/watchdog?client=${C}`);
  await runChecks(page);
  await expect(feed(page)).toContainText("Cut candidate:");
});

test("notifications: Slack URL validated, stored redacted; emails saved", async ({ page }) => {
  await page.goto("/watchdog?view=notifications");
  const box = page.getByTestId("notification-settings");
  await box.getByLabel("Slack webhook URL").fill("https://example.com/hook");
  await box.getByRole("button", { name: "Save" }).click();
  await expect(box.getByRole("status")).toContainText("hooks.slack.com");

  await box.getByLabel("Slack webhook URL").fill("https://hooks.slack.com/services/T000/B000/e2etestsecretXYZ9");
  await box.getByLabel("Alert emails").fill("ops@example.com, Owner@Example.com");
  await box.getByRole("button", { name: "Save" }).click();
  await expect(box.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(box.getByLabel("Slack webhook URL")).toHaveAttribute("placeholder", /Saved \(••••XYZ9\)/);
  await expect(box.getByLabel("Alert emails")).toHaveValue("ops@example.com, owner@example.com");
  expect(await page.content()).not.toContain("e2etestsecret");

  // clean up
  await box.getByLabel("Alert emails").fill("");
  await box.getByRole("button", { name: "Remove Slack webhook" }).click();
  await expect(box.getByRole("status")).toHaveText("Saved.");
});
