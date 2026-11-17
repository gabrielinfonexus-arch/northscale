import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { computeMetric, compareValues, getMetric, METRIC_MAP, type Totals } from "@/lib/metrics";
import { formatMetricValue } from "@/lib/format";
import { comparisonRange, isIsoDate, presetRange, todayInTz, type DateRange, type Granularity, type Preset } from "@/lib/periods";
import type { DataPlatform } from "@/lib/data-tabs";
import type { ClientSummary } from "../clients";
import type { DataRow, DataTableModel } from "../data/types";
import { getDataTable } from "../data/data-page";
import { getPnl } from "../pnl";
import { getMonthPacing } from "../targets";
import { getNotes } from "../notes";
import { runReadonlySql, SAFE_VIEWS } from "./sql-sandbox";

/**
 * Hive-Mind / AI Insights tools. All read-only, all limited to `ctx.clients` (the clients the user may see,
 * narrowed by the conversation scope). They reuse the same queries and metric definitions as the screens,
 * so the AI and the UI always agree. Nothing here can write to an ad platform.
 */
export interface ToolContext {
  clients: ClientSummary[];
  /** optional account restriction from the conversation scope */
  connectionIds?: string[] | null;
  thresholdPct?: number;
}

// ───────────────────────── shared params ─────────────────────────

const clientRef = z.string().optional().describe("Client slug, id or name. Optional when only one client is in scope.");
const accounts = z.array(z.string()).optional().describe("Connection ids or account names to restrict to. Omit for all accounts.");
const period = {
  preset: z
    .enum(["today", "yesterday", "last_7", "last_14", "last_30", "last_90", "this_month", "last_month", "this_year"])
    .optional()
    .describe("Relative period in the client's timezone. Default last_30. Ignored when from/to are given."),
  from: z.string().optional().describe("Start date YYYY-MM-DD (inclusive)"),
  to: z.string().optional().describe("End date YYYY-MM-DD (inclusive)"),
};
const compare = z
  .enum(["previous", "yoy", "none"])
  .optional()
  .describe("Comparison period: previous (same length, just before; default), yoy (same dates last year) or none");
const platform = z
  .enum(["all", "meta", "google", "shopify", "other"])
  .optional()
  .describe("all = blended (ads + Shopify + other revenue). Default all.");
const metrics = z
  .array(z.string())
  .optional()
  .describe(
    "Metric keys from the metric list in the system prompt (e.g. spend, roas, cpa, mer, totalRevenue). Omit for the default columns.",
  );

const S = {
  list_clients_and_accounts: z.object({}),
  get_metrics: z.object({
    client: clientRef,
    accounts,
    platform,
    ...period,
    granularity: z.enum(["day", "week", "month", "year"]).optional().describe("Used with level=period. Default day."),
    level: z
      .enum(["total", "period", "campaign", "adset", "ad", "keyword", "search_term"])
      .optional()
      .describe("total = one row for the whole period (default); period = one row per day/week/month; or per entity (meta/google only)"),
    metrics,
    compare,
    limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 31)"),
  }),
  compare_periods: z.object({
    client: clientRef,
    accounts,
    platform,
    period_a: z.object({ from: z.string(), to: z.string() }).describe("The period of interest"),
    period_b: z.object({ from: z.string(), to: z.string() }).describe("The baseline it is compared with"),
    metrics,
  }),
  get_breakdown: z.object({
    client: clientRef,
    accounts,
    platform: z.enum(["meta", "google"]).describe("Ad platform"),
    breakdown: z.enum(["age", "gender", "placement", "country", "hour", "day_of_week", "audience_type", "device"]),
    ...period,
    metrics,
    compare,
  }),
  get_top_entities: z.object({
    client: clientRef,
    accounts,
    platform: z.enum(["meta", "google", "shopify"]).describe("shopify only with level=product"),
    level: z.enum(["campaign", "adset", "ad", "creative", "keyword", "search_term", "product"]),
    sort_by: z.string().optional().describe("Metric key to sort by (default spend; revenue for products)"),
    ascending: z.boolean().optional().describe("true = lowest first (e.g. worst ROAS)"),
    limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
    min_spend: z.number().optional().describe("Skip rows with less spend than this (reporting currency)"),
    ...period,
    metrics,
    compare,
  }),
  get_shopify_summary: z.object({ client: clientRef, accounts, ...period, compare }),
  get_pnl: z.object({
    client: clientRef,
    ...period,
    granularity: z.enum(["day", "week", "month", "year"]).optional().describe("Rows per bucket; omit for totals only"),
    compare,
  }),
  get_targets_and_pacing: z.object({
    client: clientRef,
    month: z.string().optional().describe("Any date in the month (YYYY-MM-DD). Default: current month."),
  }),
  get_alerts: z.object({
    client: clientRef,
    status: z.enum(["open", "muted", "resolved", "all"]).optional().describe("Default open"),
    severity: z.enum(["CRITICAL", "WARNING", "INFO"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  get_chart_notes: z.object({ client: clientRef, ...period }),
  run_readonly_sql: z.object({
    query: z
      .string()
      .describe(
        "ONE SELECT (or WITH … SELECT) over the ai_* views listed in the system prompt. No comments, no ';'. Max 200 rows returned.",
      ),
  }),
};

type ToolName = keyof typeof S;

const DESCRIPTIONS: Record<ToolName, string> = {
  list_clients_and_accounts:
    "List the clients and ad/store accounts in scope, with reporting currency, timezone, today's date and connection status. Call this first when you don't know the client slugs or account ids.",
  get_metrics:
    "Metrics for a client (blended or one platform) over a period, with comparison and green/red/grey tone per metric. level=total for the headline numbers, period for a time series, or an entity level (campaign/adset/ad/keyword/search_term) for Meta/Google.",
  compare_periods:
    "Compare two explicit date ranges (e.g. this month vs last month, Black Friday week vs the week before) for a client and platform.",
  get_breakdown:
    "Ad performance split by age, gender, placement, country, hour of day, day of week, audience type (new / engaged / existing customers, Meta) or device (Google).",
  get_top_entities:
    "Top or bottom campaigns / ad sets / ads / creatives / keywords / search terms (Meta, Google) or products (Shopify), sorted by any metric. Creatives include the Winner/Watch/Cut verdict used by the Watchdog.",
  get_shopify_summary:
    "Shopify summary: orders, net sales, AOV, new vs returning customers, top products, discount codes, refunds and revenue by UTM channel.",
  get_pnl:
    "Profit & loss: gross sales → net sales → COGS → shipping, fees, variable costs → ad spend per platform → contribution margin → fixed costs → net profit.",
  get_targets_and_pacing:
    "Monthly targets for a client (whole client, Meta, Google) with month-to-date actuals, projection to month-end and pacing status.",
  get_alerts: "Watchdog alerts (CPA/ROAS vs target, pacing, stopped spend, rejected ads, tracking, ads to cut, winners, sync problems).",
  get_chart_notes:
    "Chart Notes: dated annotations (offer launches, new creatives, budget changes, promotions, tracking issues, site changes, seasonality). Use them to explain changes.",
  run_readonly_sql:
    "Last resort when no other tool answers the question: one read-only SQL SELECT over safe ai_* views, already limited to the clients in scope. Prefer the other tools (they apply FX, attribution and metric definitions consistently).",
};

/** Tool definitions for the Messages API (JSON Schema from the zod schemas). */
export function toolDefinitions(opts: { stream: boolean }): Anthropic.Tool[] {
  return (Object.keys(S) as ToolName[]).map((name) => {
    const schema = z.toJSONSchema(S[name], { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name,
      description: DESCRIPTIONS[name],
      input_schema: schema as Anthropic.Tool.InputSchema,
      ...(opts.stream ? { eager_input_streaming: true } : {}),
    };
  });
}

export const TOOL_NAMES = Object.keys(S) as ToolName[];

// ───────────────────────── helpers ─────────────────────────

export class ToolError extends Error {}

function resolveClient(ctx: ToolContext, ref?: string): ClientSummary {
  if (!ctx.clients.length) throw new ToolError("No clients in scope.");
  if (!ref) {
    if (ctx.clients.length === 1) return ctx.clients[0];
    throw new ToolError(`Several clients in scope; pass "client" (one of: ${ctx.clients.map((c) => c.slug).join(", ")}).`);
  }
  const r = ref.trim().toLowerCase();
  const c =
    ctx.clients.find((x) => x.slug === r || x.id === ref || x.name.toLowerCase() === r) ??
    ctx.clients.find((x) => x.name.toLowerCase().includes(r));
  if (!c) throw new ToolError(`Client "${ref}" is not in scope (available: ${ctx.clients.map((x) => x.slug).join(", ")}).`);
  return c;
}

function resolveAccounts(ctx: ToolContext, c: ClientSummary, refs?: string[]): string[] | null {
  const scoped = ctx.connectionIds?.length ? c.connections.filter((x) => ctx.connectionIds!.includes(x.id)) : null;
  if (!refs?.length) return scoped && scoped.length ? scoped.map((x) => x.id) : null;
  const pool = scoped ?? c.connections;
  const ids = refs.map((ref) => {
    const r = ref.toLowerCase();
    const m =
      pool.find((x) => x.id === ref || x.externalId === ref || x.name.toLowerCase() === r) ??
      pool.find((x) => x.name.toLowerCase().includes(r));
    if (!m) throw new ToolError(`Account "${ref}" not found for ${c.name}. Accounts: ${pool.map((x) => `${x.name} (${x.id})`).join("; ")}`);
    return m.id;
  });
  return [...new Set(ids)];
}

function resolvePeriod(c: ClientSummary, p: { preset?: string; from?: string; to?: string }): DateRange {
  if (p.from || p.to) {
    if (!isIsoDate(p.from) || !isIsoDate(p.to) || p.from > p.to) throw new ToolError("from/to must be YYYY-MM-DD with from ≤ to.");
    return { from: p.from, to: p.to };
  }
  return presetRange((p.preset ?? "last_30") as Exclude<Preset, "custom">, todayInTz(c.timezone));
}

function checkRange(r: { from: string; to: string }): DateRange {
  if (!isIsoDate(r.from) || !isIsoDate(r.to) || r.from > r.to) throw new ToolError("Dates must be YYYY-MM-DD with from ≤ to.");
  return r;
}

const conns = (c: ClientSummary) => Object.fromEntries(c.connections.map((x) => [x.id, { name: x.name, platform: x.platform }]));

async function table(
  ctx: ToolContext,
  c: ClientSummary,
  o: {
    platform: DataPlatform;
    tab: string;
    range: DateRange;
    compareRange: DateRange | null;
    gran?: Granularity;
    accounts: string[] | null;
  },
): Promise<DataTableModel> {
  return getDataTable({
    clientId: c.id,
    currency: c.currency,
    newAudienceMinPct: c.newAudienceMinPct,
    conn: o.accounts,
    connections: conns(c),
    range: o.range,
    compareRange: o.compareRange,
    gran: o.gran ?? "day",
    platform: o.platform,
    tab: o.tab,
    campaign: null,
  });
}

/** Metric columns available in a table, in display order. */
function tableMetrics(t: DataTableModel): string[] {
  return [...new Set(t.columns.filter((x) => x.kind === "metric" && x.metric && METRIC_MAP[x.metric]).map((x) => x.metric!))];
}

function pickMetrics(t: DataTableModel, requested?: string[]): { keys: string[]; ignored: string[] } {
  const available = tableMetrics(t);
  if (!requested?.length) {
    const vis = t.defaultVisible.filter((k) => available.includes(k));
    return { keys: (vis.length ? vis : available).slice(0, 12), ignored: [] };
  }
  const keys = requested.filter((k) => available.includes(k) || (METRIC_MAP[k] && t.total && computeMetric(k, t.total) !== null));
  return { keys: keys.length ? keys : available.slice(0, 12), ignored: requested.filter((k) => !keys.includes(k)) };
}

const fmt = (key: string, v: number | null, currency: string) => formatMetricValue(v, getMetric(key).format, currency);

function valuesOf(keys: string[], totals: Totals, compare: Totals | null | undefined, currency: string, thresholdPct?: number) {
  const values: Record<string, string> = {};
  const change: Record<string, string> = {};
  for (const k of keys) {
    const m = getMetric(k);
    const cur = computeMetric(k, totals);
    values[k] = fmt(k, cur, currency);
    if (compare) {
      const prev = computeMetric(k, compare);
      const cmp = compareValues(m.direction, cur, prev, thresholdPct);
      change[k] =
        cmp.deltaPct === null
          ? `vs ${fmt(k, prev, currency)}`
          : `${cmp.deltaPct >= 0 ? "+" : ""}${cmp.deltaPct.toFixed(1)}% vs ${fmt(k, prev, currency)} (${cmp.tone === "good" ? "better" : cmp.tone === "bad" ? "worse" : m.direction === "neutral" ? "neutral metric" : "about flat"})`;
    }
  }
  return compare ? { values, change } : { values };
}

function compactRow(r: DataRow, keys: string[], currency: string, thresholdPct?: number) {
  return {
    label: r.label,
    ...(r.sub ? { sub: r.sub } : {}),
    ...(r.badge ? { verdict: r.badge } : {}),
    ...(r.text
      ? Object.fromEntries(Object.entries(r.text).flatMap(([k, v]) => (v ? [[k, v.length > 140 ? v.slice(0, 140) + "…" : v]] : [])))
      : {}),
    ...valuesOf(keys, r.totals, r.compare, currency, thresholdPct),
  };
}

function header(c: ClientSummary, range: DateRange, cmp: DateRange | null, t?: DataTableModel, keys?: string[]) {
  const na = Object.fromEntries(Object.entries(t?.unavailable ?? {}).filter(([k]) => !keys || keys.includes(k)));
  return {
    client: c.name,
    currency: c.currency,
    period: `${range.from} → ${range.to}`,
    ...(cmp ? { compared_with: `${cmp.from} → ${cmp.to}` } : {}),
    ...(Object.keys(na).length ? { not_available: na } : {}),
    ...(t?.notices?.length ? { notices: t.notices.map((n) => n.text) } : {}),
  };
}

const PLATFORM_LABEL: Record<string, string> = {
  all: "All platforms (blended)",
  meta: "Meta",
  google: "Google",
  shopify: "Shopify",
  other: "Other revenue",
};

// ───────────────────────── tools ─────────────────────────

type Handler<K extends ToolName> = (ctx: ToolContext, input: z.infer<(typeof S)[K]>) => Promise<unknown>;

const ENTITY_TAB: Record<string, string> = {
  campaign: "campaigns",
  adset: "adsets",
  ad: "ads",
  creative: "creatives",
  keyword: "keywords",
  search_term: "search-terms",
};
const BREAKDOWN_TAB: Record<string, string> = {
  age: "age",
  gender: "gender",
  placement: "placements",
  country: "countries",
  hour: "hour",
  day_of_week: "day-of-week",
  audience_type: "audience",
  device: "device",
};

const handlers: { [K in ToolName]: Handler<K> } = {
  async list_clients_and_accounts(ctx) {
    return ctx.clients.map((c) => ({
      client: c.slug,
      name: c.name,
      currency: c.currency,
      timezone: c.timezone,
      today: todayInTz(c.timezone),
      accounts: c.connections
        .filter((x) => !ctx.connectionIds?.length || ctx.connectionIds.includes(x.id))
        .map((x) => ({ id: x.id, platform: x.platform, name: x.name, currency: x.currency, status: x.status })),
    }));
  },

  async get_metrics(ctx, i) {
    const c = resolveClient(ctx, i.client);
    const plat = (i.platform ?? "all") as DataPlatform;
    const range = resolvePeriod(c, i);
    const cmp = comparisonRange(range, i.compare ?? "previous");
    const level = i.level ?? "total";
    const accts = resolveAccounts(ctx, c, i.accounts);
    if (level !== "total" && level !== "period" && plat !== "meta" && plat !== "google")
      throw new ToolError(`level=${level} needs platform meta or google.`);
    const tab = level === "total" || level === "period" ? "core" : ENTITY_TAB[level];
    const t = await table(ctx, c, { platform: plat, tab, range, compareRange: cmp, gran: i.granularity ?? "day", accounts: accts });
    const { keys, ignored } = pickMetrics(t, i.metrics);
    const out: Record<string, unknown> = {
      ...header(c, range, cmp, t, keys),
      platform: PLATFORM_LABEL[plat],
      total: valuesOf(keys, t.total, t.totalCompare, c.currency, ctx.thresholdPct),
    };
    if (ignored.length) out.metrics_not_available_here = ignored;
    if (level !== "total") {
      const rows = [...t.rows];
      if (level !== "period") rows.sort((a, b) => (b.totals.spend ?? 0) - (a.totals.spend ?? 0));
      const limit = i.limit ?? 31;
      out.rows = rows.slice(0, limit).map((r) => compactRow(r, keys, c.currency, ctx.thresholdPct));
      if (rows.length > limit) out.more_rows = rows.length - limit;
    }
    return out;
  },

  async compare_periods(ctx, i) {
    const c = resolveClient(ctx, i.client);
    const plat = (i.platform ?? "all") as DataPlatform;
    const a = checkRange(i.period_a);
    const b = checkRange(i.period_b);
    const t = await table(ctx, c, {
      platform: plat,
      tab: "core",
      range: a,
      compareRange: b,
      accounts: resolveAccounts(ctx, c, i.accounts),
    });
    const { keys } = pickMetrics(t, i.metrics);
    return {
      ...header(c, a, b, t, keys),
      platform: PLATFORM_LABEL[plat],
      ...valuesOf(keys, t.total, t.totalCompare ?? {}, c.currency, ctx.thresholdPct),
    };
  },

  async get_breakdown(ctx, i) {
    const c = resolveClient(ctx, i.client);
    const range = resolvePeriod(c, i);
    const cmp = comparisonRange(range, i.compare ?? "none");
    const t = await table(ctx, c, {
      platform: i.platform,
      tab: BREAKDOWN_TAB[i.breakdown],
      range,
      compareRange: cmp,
      accounts: resolveAccounts(ctx, c, i.accounts),
    });
    const { keys } = pickMetrics(t, i.metrics?.length ? i.metrics : ["spend", "purchaseValue", "roas", "cpa", "purchases", "ctr", "cpm"]);
    const totalSpend = t.total.spend ?? 0;
    return {
      ...header(c, range, cmp, t, keys),
      platform: PLATFORM_LABEL[i.platform],
      breakdown: i.breakdown,
      rows: t.rows.map((r) => ({
        ...compactRow(r, keys, c.currency, ctx.thresholdPct),
        share_of_spend: totalSpend ? `${(((r.totals.spend ?? 0) / totalSpend) * 100).toFixed(1)}%` : "—",
      })),
      total: valuesOf(keys, t.total, t.totalCompare, c.currency, ctx.thresholdPct),
    };
  },

  async get_top_entities(ctx, i) {
    const c = resolveClient(ctx, i.client);
    const range = resolvePeriod(c, i);
    const cmp = comparisonRange(range, i.compare ?? "none");
    if (i.level === "product" && i.platform !== "shopify") throw new ToolError("level=product needs platform shopify.");
    if (i.platform === "shopify" && i.level !== "product") throw new ToolError("For Shopify only level=product is available.");
    const tab = i.level === "product" ? "products" : ENTITY_TAB[i.level];
    const t = await table(ctx, c, { platform: i.platform, tab, range, compareRange: cmp, accounts: resolveAccounts(ctx, c, i.accounts) });
    const sortKey =
      i.sort_by && METRIC_MAP[i.sort_by]
        ? i.sort_by
        : i.level === "product"
          ? tableMetrics(t).includes("netSales")
            ? "netSales"
            : tableMetrics(t)[0]
          : "spend";
    const { keys } = pickMetrics(t, i.metrics?.length ? [...new Set([sortKey, ...i.metrics])] : undefined);
    if (!keys.includes(sortKey)) keys.unshift(sortKey);
    const dir = i.ascending ? 1 : -1;
    const rows = t.rows
      .filter((r) => i.min_spend === undefined || (r.totals.spend ?? 0) >= i.min_spend)
      .map((r) => ({ r, v: computeMetric(sortKey, r.totals) }))
      .filter((x) => x.v !== null)
      .sort((a, b) => dir * ((a.v as number) - (b.v as number)));
    const limit = i.limit ?? 10;
    return {
      ...header(c, range, cmp, t, keys),
      platform: PLATFORM_LABEL[i.platform],
      level: i.level,
      sorted_by: `${sortKey} ${i.ascending ? "ascending" : "descending"}`,
      rows: rows.slice(0, limit).map((x) => compactRow(x.r, keys, c.currency, ctx.thresholdPct)),
      total_rows: rows.length,
      total: valuesOf(keys, t.total, t.totalCompare, c.currency, ctx.thresholdPct),
    };
  },

  async get_shopify_summary(ctx, i) {
    const c = resolveClient(ctx, i.client);
    const range = resolvePeriod(c, i);
    const cmp = comparisonRange(range, i.compare ?? "previous");
    const accts = resolveAccounts(ctx, c, i.accounts);
    const [core, nvr, products, codes, channels] = await Promise.all(
      ["core", "new-vs-returning", "products", "discount-codes", "channels"].map((tab) =>
        table(ctx, c, {
          platform: "shopify",
          tab,
          range,
          compareRange: tab === "core" || tab === "new-vs-returning" ? cmp : null,
          accounts: accts,
          gran: "month",
        }),
      ),
    );
    const top = (t: DataTableModel, n: number) => {
      const { keys } = pickMetrics(t);
      return t.rows.slice(0, n).map((r) => compactRow(r, keys.slice(0, 6), c.currency));
    };
    const coreKeys = pickMetrics(core).keys;
    const nvrKeys = pickMetrics(nvr).keys;
    return {
      ...header(c, range, cmp, core, coreKeys),
      totals: valuesOf(coreKeys, core.total, core.totalCompare, c.currency, ctx.thresholdPct),
      new_vs_returning: valuesOf(nvrKeys, nvr.total, nvr.totalCompare, c.currency, ctx.thresholdPct),
      top_products: top(products, 10),
      discount_codes: top(codes, 10),
      revenue_by_channel: top(channels, 10),
    };
  },

  async get_pnl(ctx, i) {
    const c = resolveClient(ctx, i.client);
    const range = resolvePeriod(c, i);
    const cmp = comparisonRange(range, i.compare ?? "previous");
    const p = await getPnl({ clientId: c.id, currency: c.currency, range, compareRange: cmp, gran: i.granularity ?? "month" });
    const money = (v: number) => formatMetricValue(v, "currency", c.currency);
    const lines = (l: typeof p.total) => ({
      gross_sales: money(l.grossSales),
      discounts: money(l.discounts),
      refunds: money(l.refunds),
      net_sales: money(l.netSales),
      other_revenue: money(l.otherRevenue),
      total_revenue: money(l.totalRevenue),
      cogs: money(l.cogs),
      gross_profit: money(l.grossProfit),
      shipping_cost: money(l.shippingCost),
      payment_fees: money(l.paymentFees),
      variable_costs: money(l.variableCosts),
      contribution_before_ads: money(l.contributionBeforeAds),
      ad_spend: Object.fromEntries(Object.entries(l.adSpend).map(([k, v]) => [k, money(v)])),
      ad_spend_total: money(l.adSpendTotal),
      contribution_margin: money(l.contributionMargin),
      contribution_margin_pct: l.totalRevenue ? `${((l.contributionMargin / l.totalRevenue) * 100).toFixed(1)}%` : "—",
      fixed_costs: money(l.fixedCosts),
      net_profit: money(l.netProfit),
      net_profit_pct: l.totalRevenue ? `${((l.netProfit / l.totalRevenue) * 100).toFixed(1)}%` : "—",
      orders: l.orders,
    });
    return {
      ...header(c, range, cmp),
      total: lines(p.total),
      ...(p.totalCompare ? { compare_total: lines(p.totalCompare) } : {}),
      ...(i.granularity ? { periods: p.periods.map((x) => ({ period: x.label, ...lines(x.lines) })) } : {}),
      ...(p.missingCogsOrders
        ? { note: `${p.missingCogsOrders} orders have products without a cost; COGS uses the default margin for them.` }
        : {}),
    };
  },

  async get_targets_and_pacing(ctx, i) {
    const c = resolveClient(ctx, i.client);
    const today = todayInTz(c.timezone);
    const m = await getMonthPacing(c.id, i.month && isIsoDate(i.month) ? i.month : today, today);
    return {
      client: c.name,
      currency: c.currency,
      month: m.month.slice(0, 7),
      actuals_through: m.through,
      days: `${m.daysElapsed} of ${m.daysInMonth}`,
      targets: m.groups
        .filter((g) => g.items.length)
        .map((g) => ({
          scope: g.scope === "CLIENT" ? "Whole client (blended)" : g.scope,
          items: g.items.map((x) => ({
            metric: x.label,
            target: fmt(x.metric, x.target, c.currency),
            actual_so_far: fmt(x.metric, x.actual, c.currency),
            projected_month_end: fmt(x.metric, x.projection, c.currency),
            projection_vs_target: x.gapPct === null ? "—" : `${x.gapPct >= 0 ? "+" : ""}${x.gapPct.toFixed(1)}%`,
            status: x.status,
          })),
        })),
      ...(m.groups.every((g) => !g.items.length) ? { note: "No targets set for this month (Targets page)." } : {}),
    };
  },

  async get_alerts(ctx, i) {
    const ids = i.client ? [resolveClient(ctx, i.client).id] : ctx.clients.map((c) => c.id);
    const status = i.status ?? "open";
    const rows = await prisma.alert.findMany({
      where: {
        clientId: { in: ids },
        ...(status === "all" ? {} : { status: status.toUpperCase() as "OPEN" | "MUTED" | "RESOLVED" }),
        ...(i.severity ? { severity: i.severity } : {}),
      },
      orderBy: [{ severity: "asc" }, { lastSeenAt: "desc" }],
      take: i.limit ?? 30,
      include: { client: { select: { name: true } } },
    });
    return rows.map((a) => ({
      client: a.client.name,
      severity: a.severity,
      status: a.status,
      rule: a.ruleKey,
      title: a.title,
      message: a.message,
      since: a.createdAt.toISOString().slice(0, 10),
      data_link: a.dataLink,
      ...(a.data ? { numbers: a.data } : {}),
    }));
  },

  async get_chart_notes(ctx, i) {
    const c = resolveClient(ctx, i.client);
    const range = i.preset || i.from ? resolvePeriod(c, i) : presetRange("last_90", todayInTz(c.timezone));
    const notes = await getNotes(c.id, range);
    return {
      client: c.name,
      period: `${range.from} → ${range.to}`,
      notes: notes.map((n) => ({ date: n.date, category: n.category, title: n.title, description: n.description })),
    };
  },

  async run_readonly_sql(ctx, i) {
    const r = await runReadonlySql(
      ctx.clients.map((c) => c.id),
      i.query,
    );
    return { ...r, row_count: r.rows.length, ...(r.truncated ? { note: "Only the first 200 rows are shown; aggregate in SQL." } : {}) };
  },
};

/** Run one tool call. Returns JSON text for the tool_result, or throws ToolError for an is_error result. */
export async function executeTool(ctx: ToolContext, name: string, input: unknown): Promise<string> {
  if (!(name in S)) throw new ToolError(`Unknown tool ${name}`);
  const parsed = S[name as ToolName].safeParse(input ?? {});
  if (!parsed.success)
    throw new ToolError(`Invalid input: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
  try {
    const out = await (handlers[name as ToolName] as Handler<ToolName>)(ctx, parsed.data as never);
    const text = JSON.stringify(out);
    return text.length > 60_000 ? text.slice(0, 60_000) + '…"(truncated: narrow the period, filters or limit)"' : text;
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError((e as Error).message || "Tool failed");
  }
}

/** For the system prompt. */
export const SQL_VIEW_DOCS = SAFE_VIEWS.map((v) => `- ${v.name}: ${v.description}`).join("\n");
