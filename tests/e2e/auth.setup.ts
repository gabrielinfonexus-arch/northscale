import { expect, test as setup } from "@playwright/test";

const STATE = "tests/e2e/.auth/owner.json";

setup("sign in as the owner", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_OWNER_EMAIL ?? "owner@northscale.local");
  await page.getByLabel("Password").fill(process.env.E2E_OWNER_PASSWORD ?? "northscale-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId("current-user")).toContainText("Owner");
  await page.context().storageState({ path: STATE });
});
