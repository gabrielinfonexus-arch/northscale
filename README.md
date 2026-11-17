# NorthScale

Reporting and growth-intelligence platform: Google Ads, Meta Ads, Shopify and other revenue for many clients and many accounts per client, in **one database, one format**. Every screen and the AI read from the same tables.

> Status: **Phase 5 of 8** (base + Data page, Dashboard, Chart Notes, Targets, Meta / Google Ads / Shopify connectors, Other Revenue, P&L, Sync Status / Overview). See [Roadmap](#roadmap).

## Quick start (local)

Requirements: Node 22+, PostgreSQL 15+ (local or Supabase).

```bash
cp .env.example .env            # set DATABASE_URL and ENCRYPTION_KEY (openssl rand -hex 32)
npm install                     # also runs `prisma generate`
npm run db:migrate              # tables + reporting views
npm run db:seed                 # 2 demo clients, 180 days of Meta + Google + Shopify (+ other revenue)
npm run dev                     # http://localhost:3000
```

| Script                                  | What it does                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `start`       | Next.js                                                                                |
| `npm test`                              | Unit tests (Vitest): metrics, colour rule, periods, filters, crypto, creative verdicts |
| `npm run e2e`                           | Playwright smoke tests over the demo data (starts `dev` if not running)                |
| `npm run lint` / `typecheck` / `format` | ESLint, `tsc --noEmit`, Prettier                                                       |
| `npm run db:migrate` / `db:migrate:dev` | Apply migrations (prod) / create new ones (dev)                                        |
| `npm run db:seed`                       | (Re)generate demo data. Only touches `isDemo` clients.                                 |
| `./scripts/dev-up.sh`                   | Start local Postgres (if stopped) and the dev server — handy after a container restart |
| `npm run db:refresh-views`              | Refresh the materialized reporting views                                               |

## Architecture

```
Platform APIs ──► connectors (phase 3+) ──► normalized fact tables ──► reporting views ──► UI pages + AI tools
                                              (one row per date × account × entity × breakdown)
```

- **Tenancy**: `organizations → clients → connections` (one connection = one Meta ad account / Google Ads customer / Shopify store / other-revenue source). A client can have several of each.
- **Facts** (all in the account's original currency, converted at read time):
  - `ad_insights_daily` — date × connection × level (account/campaign/ad set/ad/keyword/search term) × entity × attribution window
  - `ad_insights_breakdown` — same key + breakdown type/value (age, gender, placement, country, hour, device, audience type)
  - `shopify_orders`, `shopify_order_lines`, `shopify_refunds` (refunds on the refund date), `other_revenue`
  - dimensions: `ad_entities`, `creatives`; planning: `targets`, `chart_notes`, `cost_items`, `product_costs`
- **Currency**: each client has a reporting currency; `fx_rates` stores daily rates and `fx_factor()` (SQL) converts using the latest rate on/before each day.
- **Reporting views**: `mv_ad_daily`, `mv_shopify_daily`, `mv_other_revenue_daily` (materialized, refreshed after each sync), `v_client_daily` (blended: MER, aMER, nCAC inputs) and weekly/monthly/yearly rollups.
- **Metrics**: `src/lib/metrics.ts` is the single definition of every metric — formula, format, direction (higher/lower is better/neutral), description. Tables, tooltips, colours, the Help glossary and the AI prompt all use it.
- **Colour rule**: green when better, red when worse, grey when |Δ| < threshold (default ±2%, `org_settings.comparisonThresholdPct`) or the metric is neutral. `compareValues()` in `metrics.ts`, unit-tested.
- **Global filters in the URL**: `client`, `accounts`, `preset|from|to`, `gran`, `cmp|cfrom|cto` (+ page params like `platform`, `tab`, `cvc`, `cvt`). Any view is a shareable link.
- **Caching**: Next.js 16 Cache Components. Data functions use `"use cache"` + `cacheTag("client:<id>")`; sync jobs will call `revalidateTag` when they finish.
- **Security**: platform tokens are encrypted with AES-256-GCM (`src/lib/crypto.ts`, key in `ENCRYPTION_KEY`); client-facing types never include token columns; NorthScale is **read-only** towards ad platforms.
- **Permissions**: every query goes through `getCurrentUser()` / `accessibleClientIds()` (`src/server/auth.ts`). Phase 1 resolves to the seeded Owner; phase 8 plugs in Supabase Auth behind the same functions.

### Job queue choice: Inngest

Chosen for phase 3 because it is the simplest to run with this stack: no Redis or worker server to host, functions live inside the Next.js app as a route handler (works on Vercel), and it gives retries with backoff, cron schedules, per-connection concurrency limits and throttling (useful for Meta/Google rate limits) out of the box. Local dev uses the Inngest dev server (`npx inngest-cli dev`). BullMQ would need a separate always-on worker + Redis; Trigger.dev is comparable but adds a second deploy target.

## Pages so far

- **Data** — the reference layout: platform tabs, breakdown sub-tabs, expandable rows, totals, colour vs comparison / vs target, column chooser (saved per user), CSV.
- **Dashboard** — KPI cards (choose & reorder, comparison + sparkline), trend chart with dashed comparison and clickable Chart Note markers (click the chart to add a note), spend by platform, revenue by channel (Shopify UTM attribution), platform-reported vs Shopify revenue, funnel with rates and costs, top 5 campaigns / creatives / products, month pacing. Drag & resize widgets with “Edit layout” (saved per user).
  - Two metrics on the trend chart share one axis when they have the same unit; otherwise they render as two stacked, synced panels (no dual-axis charts — they are easy to misread).
- **Chart Notes** — per-client annotations with categories/colours; shown on every time chart and available to the AI (phase 7).
- **Hive-Mind** — full-screen chat with the data (saved history, scope: all clients or one, Standard / Deep analysis model). See [Hive-Mind & AI Insights](#hive-mind--ai-insights).
- **AI Insights** — daily / weekly cards per client: what changed, likely cause, recommended action, with feedback and “Turn into Chart Note”.
- **Watchdog** — alert feed (severity, date, account, View data, Resolve, Mute), per-client rules, Slack / email notifications. See [Watchdog](#watchdog).
- **Targets** — monthly targets per client and per platform, pacing (progress, projection to month-end, status), breakeven calculator (AOV, margin, fixed costs, profit multiplier → breakeven and target ROAS/MER/CPA, can pull AOV and margin from Shopify), 12-month target vs actual history.
  - Breakeven with fixed costs: BE ROAS = (S + F) / (m·S), BE CPA = AOV·m·S / (S + F). The multiplier raises the ROAS target and lowers the CPA target.

## Deploy (summary — expanded in phase 8)

### Online preview with a password (Vercel + Supabase)

Until login (phase 8) the whole site sits behind one password (`src/proxy.ts`, HTTP Basic auth; webhooks keep their own signature/key checks). Without `SITE_PASSWORD` a production deploy refuses to serve.

1. **Supabase** → new project → _Connect_ → copy the **Session pooler** connection string (port 5432; works from Vercel, which has no IPv6).
2. **Vercel** → _Add New → Project_ → import this GitHub repo. Environment variables: `DATABASE_URL` (step 1), `ENCRYPTION_KEY` (`openssl rand -hex 32`), `SITE_PASSWORD`, `APP_URL` (the Vercel URL, after the first deploy).
3. Deploy. `npm run vercel-build` applies the migrations and, on an empty database, creates the demo clients (`SEED_DEMO_ON_DEPLOY=0` to skip), then builds. Every push to `main` redeploys.

Mock connectors are refused in production; connecting real accounts needs the Meta / Google / Shopify app credentials below.

- **Vercel**: import the repo, set the env vars from `.env.example`. `DATABASE_URL` must be available at **build** time too (the app shell is prerendered and reads the client list).
- **Supabase**: create a project, use the pooled connection string for `DATABASE_URL`, run `npm run db:migrate`.
- **Inngest** (phase 3): connect the Vercel project; schedules are defined in code.

## Connectors & sync

All connectors implement one interface (`src/server/connectors/types.ts`): `inspectToken`, `listAccounts`, `syncRange`, `syncBreakdowns`, `syncCreatives`, `healthCheck`, plus optional `oauth`. Register a new platform in `src/server/connectors/registry.ts`; the engine, queue and screens need no changes. Connectors are **read-only** (the Meta client refuses any POST except starting an insights report).

**Sync schedule** (`src/server/sync/engine.ts`, `src/server/queue/inngest.ts`)

| Job           | When                      | Range                                             |
| ------------- | ------------------------- | ------------------------------------------------- |
| Backfill      | when an account is linked | 13 months, 31-day chunks, newest first            |
| Hourly        | every hour (`:07` UTC)    | today (+ yesterday before 6am account time)       |
| Daily re-sync | `08:23` UTC               | last 7 complete days + creatives + account health |
| Re-sync range | “Re-sync” on Sync Status  | any range                                         |

Each job replaces its date range (idempotent), refreshes the reporting views and invalidates the client's cache tag. Meta rate limits: usage headers (`x-business-use-case-usage`, `x-ad-account-usage`, `x-app-usage`) slow the client down above 75% and throttling errors wait `estimated_time_to_regain_access`; Inngest adds per-connection concurrency (1) and per-platform throttling.

**Running jobs**

- Production: create an Inngest account, connect the Vercel project (or set `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`). Functions are served at `/api/inngest`.
- Local: either nothing (jobs run in-process after the request, no retries/schedules) or `INNGEST_DEV=1` with `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest`.
- Mock mode: `META_MOCK=1` serves a simulated Graph API (3 ad accounts, 13 months) so the whole flow works without a Meta app. Create a sandbox client with `npm run client:create -- "Mock Brand Sandbox" USD America/New_York --demo`.

### Meta — credentials step by step

1. **Create the app**: [developers.facebook.com](https://developers.facebook.com) → My Apps → Create app → type **Business**. Copy the **App ID** and **App secret** (App settings → Basic) into `META_APP_ID` / `META_APP_SECRET`.
2. **Add Marketing API** to the app (Add product → Marketing API).
3. **Add Facebook Login for Business** → Configurations → Create configuration: login variation _General_, token type **User access token**, permissions `ads_read`, `business_management`, `leads_retrieval`, `pages_show_list`. Copy the **Configuration ID** into `META_LOGIN_CONFIG_ID`.
4. **Valid OAuth redirect URI** (Facebook Login for Business → Settings): `https://YOUR_DOMAIN/api/connect/meta/callback` (and `http://localhost:3000/api/connect/meta/callback` for dev).
5. **Access level**: ads_read works in Development mode for ad accounts you admin. To read accounts of other businesses, request **Advanced access** for `ads_read` (App Review) and complete Business Verification.
6. **Connect**: Sync Status → _Connect Meta_ → _Continue with Facebook_ → choose the ad accounts for the client.

**Alternative — System User token (recommended for agencies, does not expire):** Business Settings → Users → **System users** → Add (Admin) → _Add assets_ → give it the ad accounts (view performance) → **Generate new token** for your app with `ads_read` (+ `business_management`). Paste it in Sync Status → Connect Meta → _Use this token_.

User tokens from OAuth last ~60 days; Sync Status warns 7 days before expiry and _Reconnect_ renews them.

**Audience segments** (Audience Types tab) need the ad account's audience segments configured in Ads Manager → Advertising settings → Audience segments (engaged audience and existing customers). If they aren't, the breakdown is skipped and the tab explains how to set it up.

### Google Ads — credentials step by step

NorthScale calls the Google Ads API over REST (`googleads.googleapis.com/v26/…/googleAds:searchStream`) with GAQL. What is synced:

- Daily metrics per account, campaign, ad group, ad, keyword and search term: cost, impressions, clicks, conversions (“Conv.” = primary conversions), conversion value, all conversions, view-through conversions, search impression share.
- Conversions by action category (purchase, add to cart, begin checkout, leads) feed ATC / IC / Leads. Accounts without such actions show “—”.
- Breakdowns: hour, device, age (`age_range_view`), gender (`gender_view`), country (`geographic_view`, location of presence). Day of week and campaign type (Search, PMax, Shopping, Demand Gen, YouTube…) come from the daily data and campaign settings. Google doesn't report age/gender for Performance Max.
- Ad approval status (disapproved / limited) and account status for the Watchdog.

Setup:

1. **Developer token**: sign in to your **manager account (MCC)** → Admin → **API Center** → apply. A new token has _Test_ access (test accounts only); apply for **Basic access** (15,000 operations/day) to read real accounts. Put it in `GOOGLE_ADS_DEVELOPER_TOKEN`.
2. **OAuth client**: [console.cloud.google.com](https://console.cloud.google.com) → create a project → _APIs & Services_ → enable **Google Ads API** → _OAuth consent screen_ (External, add scope `.../auth/adwords`; publish it or add your users as testers) → _Credentials_ → **Create OAuth client ID** → _Web application_ → authorised redirect URI `https://YOUR_DOMAIN/api/connect/google/callback` (and `http://localhost:3000/api/connect/google/callback`). Copy the ID/secret to `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET`.
3. **Connect**: Sync Status → _Connect Google Ads_ → _Continue with Google_ with a Google user that has access to the MCC (or directly to the accounts). The picker lists every non-manager account under each MCC; the MCC is saved per account and sent as `login-customer-id`.
4. The refresh token doesn't expire unless revoked (or the consent screen is left in _Testing_, where Google expires it after 7 days — publish the app). If it's revoked, the account shows _Token expired_ and _Reconnect_ fixes it.

### Shopify — connecting a store

What is synced (Admin GraphQL API `2026-10`): every order with gross sales (line items × price), discounts, shipping, taxes, total, financial status, discount codes, products/variants/quantities, refunds (booked on the **refund date**), customer, **new vs returning** (Shopify's customer order index; falls back to the store history), **COGS** (inventory unit cost → manual override → default margin), **payment fees** (from transactions, or the configured %), and the customer journey (first/last visit landing page, referrer, UTMs) for NorthScale's own **first-click / last-click attribution** (Meta, Google, Email, Organic, Direct, Other — `src/server/connectors/shopify/attribution.ts`).

Real time: webhooks `orders/create`, `orders/updated`, `refunds/create` (HMAC-verified at `/api/webhooks/shopify`) re-read the order; hourly and daily syncs reconcile (`updated_at` catches late refunds and edits).

Three ways to connect (Sync Status → _Connect Shopify_), because Shopify changed custom apps on 2026-01-01:

1. **Existing custom app token (`shpat_…`)** — legacy custom apps created in the store admin before 2026 keep working. Scopes: `read_orders`, `read_all_orders` (older than 60 days), `read_products`, `read_inventory` (unit costs), `read_customers`. Set `SHOPIFY_WEBHOOK_SECRET` to the app's API secret key to verify its webhooks.
2. **Dev Dashboard app on your own store (client ID + secret)** — create an app at [dev.shopify.com](https://dev.shopify.com) in the _same organization_ as the store, add the scopes above, install it on the store, then paste the client ID and secret. NorthScale requests a fresh token (client-credentials, ~24 h) on every sync, so nothing expires.
3. **OAuth** (an app distributed to stores you don't own) — set `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`, add `https://YOUR_DOMAIN/api/connect/shopify/callback` as an allowed redirect URL, then _Install via OAuth_ with the store domain. The callback checks the signed state and Shopify's HMAC.

Webhooks are registered automatically when `APP_URL` is a public `https://` URL.

COGS caveat: Shopify only keeps the **current** unit cost, so historic COGS uses today's cost. Fix past periods with overrides in **P&L → Costs**.

### Other Revenue

Revenue that isn't in Shopify (Amazon, Mercado Livre, Stripe, Hotmart, TikTok Shop, wholesale…) — page **Other Revenue** (also linked from Data → Other Revenue):

- **Manual**: date, source, revenue, orders. Same date + source replaces the value.
- **CSV**: `date, source, revenue[, orders][, currency]` — Portuguese headers, `;` separators and `1.234,56` numbers work.
- **Webhook**: generate a per-client key (only its hash is stored), then `POST /api/webhooks/other-revenue` with `Authorization: Bearer nsk_…` and `{ "date", "source", "revenue", "orders"?, "currency"? }` (or an array). Idempotent per date + source.

### P&L

Per client, by day / week / month / year, with comparison and a waterfall:

`Gross sales − discounts − refunds = Net sales` → `+ Other revenue = Total revenue` → `− COGS = Gross profit` → `− shipping cost − payment fees − variable costs = Contribution before ads` → `− ad spend per platform = Contribution margin` → `− fixed costs = Net profit`.

**P&L → Costs**: shipping cost per order and/or % of net sales, payment fee %, default margin for products without cost, other costs (fixed per month — spread per day —, per order, or % of net sales, with optional start/end dates) and **COGS per product** overrides (recomputes stored COGS so every screen agrees, and survives re-syncs). The same cost model (`src/lib/pnl.ts`) feeds the Dashboard and Data “Contribution margin”, “Net profit” and margin % metrics.

### Watchdog

Automatic, **read-only** monitoring (it never pauses or edits anything in an ad account). Checks run at the end of every sync (success or failure), once a day for every client (Inngest `daily-watchdog`, covers webhook-only data), and on demand (“Run checks now”, or `npm run watchdog [-- <client-slug>]`).

Rules (`src/lib/watchdog/rules.ts`, pure and unit-tested; every threshold editable per client in **Watchdog → Rules**, targets come from **Targets**):

| Rule                                       | Default                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| CPA above target                           | Platform CPA over the last 3 days > target +20% (critical at 1.5×), min spend 100                                             |
| ROAS / MER below target or dropping        | Below the monthly target, or −20% vs the previous 7-day average (platforms + blended MER)                                     |
| Spend pacing                               | Projected month-end spend outside budget ±10% (from day 3)                                                                    |
| Account stopped spending / account problem | Yesterday < 10% of a normal (≥ 50/day) spend; or the platform reports the account as disabled / unsettled                     |
| Rejected ad                                | Disapproved / limited ads (Meta review feedback, Google policy summary)                                                       |
| High frequency in prospecting              | Meta prospecting campaigns with 7-day frequency > 2.5                                                                         |
| Tracking looks broken                      | Platform purchases collapse while Shopify orders hold (or the opposite), or the platform-vs-Shopify gap moves far from normal |
| Funnel diagnosis                           | CPA up: CPC / cost per add-to-cart also up → traffic got expensive (warning); stable → conversion issue, hold (info)          |
| Ad to cut                                  | CPA ≥ 2× target after spending ≥ 2× target CPA (14 days)                                                                      |
| Winning ad                                 | ≥ 5% of spend over 14 days and above target ROAS (info)                                                                       |
| Sync failed / token expired                | Sync errors, revoked tokens, data older than 24 h, token expiring within 7 days (demo connections ignored)                    |

**Alert lifecycle** — de-duplicated by fingerprint (one alert per condition, numbers refreshed on each check). Alerts whose condition clears are resolved automatically (“Cleared automatically”). **Resolve** acknowledges an alert: it stays resolved while the condition persists and reopens only if it gets worse, or clears and comes back. **Mute for 1/3/7/14 days** silences it; it reopens afterwards if still true. Each alert has a **View data** link that opens Data on the right platform, tab, period and account. The sidebar shows the number of open critical alerts.

**Notifications** (Watchdog → Notifications, owners/admins): Slack incoming webhook (stored encrypted, shown redacted) and/or email via [Resend](https://resend.com) (`RESEND_API_KEY`, `ALERT_EMAIL_FROM`). Sent once when an alert opens, reopens or escalates, at or above the minimum severity; each rule can turn email/Slack off. “Send test” checks the setup. `APP_URL` makes the links in notifications absolute.

### Hive-Mind & AI Insights

Anthropic API with tool use (`@anthropic-ai/sdk`), called only from the server. `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) answers everyday questions and writes insights; `ANTHROPIC_MODEL_HEAVY` (default `claude-opus-5-5`) is used when a conversation is switched to **Deep analysis**. Server-side refusal fallback is on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): if a safety classifier declines, the API retries on a fallback model in the same call.

**Read-only tools** (`src/server/ai/tools.ts`) — `list_clients_and_accounts`, `get_metrics`, `compare_periods`, `get_breakdown` (age, gender, placement, country, hour, day of week, audience type, device), `get_top_entities` (campaigns, ad sets, ads, creatives with Winner/Watch/Cut, keywords, search terms, products), `get_shopify_summary`, `get_pnl`, `get_targets_and_pacing`, `get_alerts`, `get_chart_notes`, and `run_readonly_sql` as a last resort. They reuse the Data page / P&L / Targets queries and `metrics.ts`, so the AI and the screens always agree, and return “—” with the reason when a platform doesn't provide a metric.

**Permissions** — every tool only sees the clients the signed-in user may see (`accessibleClientIds`), narrowed by the conversation scope. `run_readonly_sql` runs one `SELECT` per call in a transaction that is always rolled back: it creates temporary `ai_*` views already filtered to those clients, switches to the no-login role `northscale_ai_ro` (no table privileges), sets `READ ONLY` and a 5 s timeout, returns at most 200 rows. Nothing can write anywhere, and nothing ever reaches the ad platforms.

**Chat** — streamed (Server-Sent Events from `POST /api/ai/chat`), history saved per user (`ai_conversations` / `ai_messages`, raw content blocks replayed unchanged), tool calls shown collapsed, Markdown tables and inline charts (the model emits a ` ```chart ` JSON block, drawn with Recharts), clickable example questions.

**AI Insights** — Inngest `daily-ai-insights` (every morning: last 7 days vs the 7 before) and `weekly-ai-insights` (Mondays: last full week vs the one before) fan out one job per client; “Generate now” runs on demand. A data pack built with the same tools (≈10k tokens per client) goes to the model, which returns 3–6 cards as structured output (priority, what changed, likely cause, action, supporting metrics, Data link). Cards have “Useful / Not useful” and “Turn into Chart Note”.

**Cost** — every call's tokens (incl. cache reads/writes) and USD cost are stored in `ai_usage` per client and feature (for Billing in phase 8). The system prompt is cached (prompt caching). Rough order: an insight run ≈ US$0.05 per client on Sonnet 5.5; a chat question ≈ US$0.02–0.10 depending on how many tools it calls.

**Local without an API key** — `AI_MOCK=1` swaps the API for a scripted model that calls real tools and draws a real table + chart (used by the e2e tests; refused in production).

## Roadmap

1. ✅ Base: layout, schema, `metrics.ts`, demo seed, Data page, colour rule
2. ✅ Dashboard, Chart Notes, Targets
3. ✅ Meta connector (+ Sync Status / Sync Overview)
4. ✅ Google Ads connector
5. ✅ Shopify connector, Other Revenue, P&L, blended metrics
6. ✅ Watchdog (alerts, rules per client, Slack / email)
7. ✅ Hive-Mind + AI Insights
8. Go-live: **login (Supabase Auth) with roles Owner / Admin / Analyst / Client Viewer enforced on every page, server action and AI tool**, Clients page (create clients + onboarding + connect accounts), Team Members, Client Viewers (incl. expiring public links), Billing, Help, final tests, and a **deploy checklist (Vercel + Supabase + Inngest + Meta/Google/Shopify apps)**. Until this phase the app has no login — run it locally only, never on a public URL.

## Notes on versions

- Next.js **16.4** (Cache Components + Partial Prefetching on), React 19.3, Tailwind 4.
- Prisma pinned to **7.10.1** (npm's `latest` tag currently points at an 8.0 release candidate).
- TanStack Table **v9** (`useTable` + explicit `tableFeatures`).
- shadcn/ui components are vendored in `src/components/ui` (Radix primitives); Inter is self-hosted via `@fontsource-variable/inter`.
