# NorthScale

Reporting and growth-intelligence platform: Google Ads, Meta Ads, Shopify and other revenue for many clients and many accounts per client, in **one database, one format**. Every screen and the AI read from the same tables.

> Status: **Phase 1 of 8** (base, layout, schema, metrics, demo data, Data page). See [Roadmap](#roadmap).

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

## Deploy (summary — expanded in phase 8)

- **Vercel**: import the repo, set the env vars from `.env.example`. `DATABASE_URL` must be available at **build** time too (the app shell is prerendered and reads the client list).
- **Supabase**: create a project, use the pooled connection string for `DATABASE_URL`, run `npm run db:migrate`.
- **Inngest** (phase 3): connect the Vercel project; schedules are defined in code.

## Platform credentials

Step-by-step guides are added with each connector: Meta (phase 3), Google Ads developer token + OAuth + MCC (phase 4), Shopify custom app / OAuth (phase 5).

## Roadmap

1. ✅ Base: layout, schema, `metrics.ts`, demo seed, Data page, colour rule
2. Dashboard, Chart Notes, Targets
3. Meta connector (+ Sync Status / Sync Overview)
4. Google Ads connector
5. Shopify connector, Other Revenue, P&L, blended metrics
6. Watchdog
7. Hive-Mind + AI Insights
8. Clients, Team Members, Client Viewers, Billing, Help, final README

## Notes on versions

- Next.js **16.4** (Cache Components + Partial Prefetching on), React 19.3, Tailwind 4.
- Prisma pinned to **7.10.1** (npm's `latest` tag currently points at an 8.0 release candidate).
- TanStack Table **v9** (`useTable` + explicit `tableFeatures`).
- shadcn/ui components are vendored in `src/components/ui` (Radix primitives); Inter is self-hosted via `@fontsource-variable/inter`.
