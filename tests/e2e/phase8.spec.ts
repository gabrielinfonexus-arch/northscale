import { expect, test, type Browser, type Page } from "@playwright/test";

/** Phase 8: login, roles, Clients, Team Members, Client Viewers, public links, Billing, Help. Runs as the Owner (auth.setup.ts). */

const stamp = Date.now().toString(36);
const PASSWORD = "correct-horse-battery";

/** A fresh, signed-out browser. */
async function anonymous(browser: Browser) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return { ctx, page: await ctx.newPage() };
}

async function acceptInvite(page: Page, url: string, name: string) {
  await page.goto(url);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Repeat password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/(dashboard|data|targets|forbidden)/);
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

test("signed out: pages redirect to login, APIs answer 401, wrong password is refused", async ({ browser }) => {
  const { ctx, page } = await anonymous(browser);
  await page.goto("/pnl?client=aurora-skincare");
  await expect(page).toHaveURL(/\/login\?next=%2Fpnl%3Fclient%3Daurora-skincare/);
  const api = await page.request.post("/api/ai/chat", { data: { message: "hi" } });
  expect(api.status()).toBe(401);
  await page.getByLabel("Email").fill("owner@northscale.local");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Wrong email or password." })).toBeVisible();
  await page.getByLabel("Password").fill(process.env.E2E_OWNER_PASSWORD ?? "northscale-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/pnl\?client=aurora-skincare/); // back where they wanted to go
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await page.goto("/data");
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test("Clients: create with onboarding, edit, archive and restore", async ({ page }) => {
  const name = `E2E Brand ${stamp}`;
  await page.goto("/clients/new");
  await page.getByLabel("Client name").fill(name);
  await page.getByLabel("Currency").fill("EUR");
  await page.getByLabel("Timezone").selectOption("Europe/Lisbon");
  await page.getByLabel("Default gross margin").fill("55");
  await page.getByRole("button", { name: "Create client" }).click();
  await page.waitForURL(/\/clients\/e2e-brand-[a-z0-9]+\?onboarding=1/);
  await expect(page.getByTestId("onboarding")).toContainText("Connect ad accounts");
  await expect(page.getByText("Other revenue (manual / CSV / webhook)")).toBeVisible();
  // the previous route (new-client form) stays mounted but hidden: act on the visible form only
  await page.getByLabel("Payment fees").filter({ visible: true }).fill("3.5");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();

  const slug = new URL(page.url()).pathname.split("/").pop()!;
  await page.goto("/clients");
  const row = page.getByTestId(`client-${slug}`);
  await expect(row).toContainText("EUR · Europe/Lisbon");
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Archive" }).click();
  await expect(row.getByRole("button", { name: "Restore" })).toBeVisible();
  await page.goto(`/dashboard?client=${slug}`); // archived clients disappear from the app
  await expect(page.getByRole("combobox").first()).not.toContainText(name);
  await page.goto("/clients");
  await page.getByTestId(`client-${slug}`).getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId(`client-${slug}`).getByRole("button", { name: "Archive" })).toBeVisible();
});

test("Team: an Analyst only sees assigned clients and no admin pages", async ({ page, browser }) => {
  const email = `analyst-${stamp}@example.com`;
  await page.goto("/team");
  await page.getByLabel("Invite email").fill(email);
  await page.getByLabel("Invite role").selectOption("ANALYST");
  await page.getByLabel("Clients for the new analyst").getByLabel("Casa Verde Home").check();
  await page.getByRole("button", { name: "Create invitation" }).click();
  const url = await page.getByTestId("link-box").getByLabel("Link").inputValue();
  expect(url).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
  await expect(page.getByTestId(`invite-${email}`)).toBeVisible();

  const { ctx, page: a } = await anonymous(browser);
  await acceptInvite(a, url, "Ana Analyst");
  await expect(a.getByTestId("current-user")).toContainText("Analyst");
  for (const hidden of ["Clients", "Team Members", "Billing", "Client Viewers"])
    await expect(nav(a).getByRole("link", { name: hidden })).toHaveCount(0);
  await expect(nav(a).getByRole("link", { name: "Hive-Mind" })).toBeVisible();
  await a.goto("/data?client=aurora-skincare"); // not assigned → falls back to an assigned client
  await expect(a.getByRole("button", { name: /Casa Verde Home/ }).first()).toBeVisible();
  await a.goto("/team");
  await expect(a).toHaveURL(/\/forbidden/);
  await a.goto("/clients");
  await expect(a).toHaveURL(/\/forbidden/);
  // the invite is single-use
  await a.goto(url);
  await expect(a.getByText("Invitation not valid")).toBeVisible();
  await ctx.close();

  // admin: reset link for the analyst → new password works
  await page.reload();
  const member = page.getByTestId(`member-${email}`);
  await member.getByRole("button", { name: "Reset link" }).click();
  const reset = await member.getByTestId("link-box").getByLabel("Link").inputValue();
  const { ctx: c2, page: r } = await anonymous(browser);
  await r.goto(reset);
  await r.getByLabel("New password").fill("another-strong-pass");
  await r.getByLabel("Repeat password").fill("another-strong-pass");
  await r.getByRole("button", { name: "Save and sign in" }).click();
  await r.waitForURL(/\/dashboard/);
  await c2.close();

  // disable → can't sign in
  await page.reload();
  await page.getByTestId(`member-${email}`).getByRole("button", { name: "Disable" }).click();
  await expect(page.getByTestId(`member-${email}`)).toContainText("disabled");
  const { ctx: c3, page: d } = await anonymous(browser);
  await d.goto("/login");
  await d.getByLabel("Email").fill(email);
  await d.getByLabel("Password").fill("another-strong-pass");
  await d.getByRole("button", { name: "Sign in" }).click();
  await expect(d.getByRole("alert").filter({ hasText: "Wrong email or password." })).toBeVisible();
  await c3.close();
});

test("Client Viewer: only their client and chosen pages; no costs, no AI", async ({ page, browser }) => {
  const email = `viewer-${stamp}@example.com`;
  await page.goto("/client-viewers?client=aurora-skincare");
  await page.getByLabel("Viewer email").fill(email);
  const pages = page.getByLabel("Pages for the new viewer");
  await pages.getByLabel("Targets").uncheck();
  await pages.getByLabel("P&L").check();
  await page.getByRole("button", { name: "Invite viewer" }).click();
  const url = await page.getByTestId("link-box").first().getByLabel("Link").inputValue();

  const { ctx, page: v } = await anonymous(browser);
  await acceptInvite(v, url, "Vera Viewer");
  await expect(v.getByTestId("current-user")).toContainText("Client viewer");
  await expect(nav(v).getByRole("link")).toHaveText(["Dashboard", "Data", "P&L", "Help"]);
  await v.goto("/pnl?view=costs&client=aurora-skincare");
  await expect(v.getByRole("link", { name: "Costs" })).toHaveCount(0); // internal costs hidden
  await expect(v.getByRole("heading", { name: "P&L" })).toBeVisible();
  for (const p of ["/targets", "/hive-mind", "/watchdog", "/sync-status", "/clients"]) {
    await v.goto(p);
    await expect(v).toHaveURL(/\/forbidden/);
  }
  await v.goto("/data?client=casa-verde"); // another client → back to their own
  await expect(v.getByRole("button", { name: /Aurora Skincare/ }).first()).toBeVisible();
  expect((await v.request.post("/api/ai/chat", { data: { message: "hi" } })).status()).toBe(403);
  await ctx.close();

  // owner sees the viewer and can change pages
  await page.reload();
  const row = page.getByTestId(`viewer-${email}`);
  await row.getByLabel("Targets").check();
  await row.getByRole("button", { name: "Save pages" }).click();
  await expect(row.getByRole("status")).toHaveText("Saved.");
});

test("Public link: read-only, chosen pages only, revocable", async ({ page, browser }) => {
  await page.goto("/client-viewers?client=aurora-skincare");
  const picker = page.getByLabel("Pages on the public link");
  await expect(picker.getByLabel("Hive-Mind")).toHaveCount(0);
  await picker.getByLabel("Dashboard").uncheck();
  await picker.getByLabel("Data").uncheck();
  await page.getByLabel("Link label").fill(`E2E ${stamp}`);
  await page.getByLabel("Expires in").selectOption("7");
  await page.getByRole("button", { name: "Create link" }).click();
  const url = await page.getByTestId("link-box").last().getByLabel("Link").inputValue();
  expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{40,}$/);

  const { ctx, page: s } = await anonymous(browser);
  await s.goto(url);
  await s.waitForURL(/\/targets\?client=aurora-skincare/);
  await expect(s.getByTestId("current-user")).toContainText("Read-only link");
  await expect(nav(s).getByRole("link")).toHaveText(["Targets"]);
  await s.goto("/dashboard");
  await expect(s).toHaveURL(/\/forbidden/);

  await page.reload();
  await page
    .getByTestId("share-link")
    .filter({ hasText: `E2E ${stamp}` })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.getByTestId("share-link").filter({ hasText: `E2E ${stamp}` })).toHaveCount(0);
  await s.goto("/targets");
  await expect(s).toHaveURL(/\/login/); // session ended with the link
  const again = await s.request.get(url, { maxRedirects: 0 });
  expect(again.status()).toBe(410);
  await ctx.close();
});

test("Billing and Help", async ({ page }) => {
  await page.goto("/billing");
  await expect(page.getByText("AI cost this month")).toBeVisible();
  await expect(page.getByTestId("ai-usage-months")).toBeVisible();
  await page.goto("/help");
  await expect(page.getByTestId("glossary-Blended")).toContainText("MER");
  await page.getByText("Can NorthScale change my campaigns?").click();
  await expect(page.getByText(/Every integration is read-only/)).toBeVisible();
});
