import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";
import { computeMetric, type Totals } from "@/lib/metrics";
import { pace, type PaceResult, ADDITIVE_TARGETS } from "@/lib/pacing";
import { addDays, addMonths, endOfMonth, startOfMonth } from "@/lib/periods";

export type TargetScope = "CLIENT" | "META" | "GOOGLE";

/** Target fields per scope and the metric key each maps to. */
export const TARGET_FIELDS: Record<TargetScope, { field: TargetField; metric: string; label: string }[]> = {
  CLIENT: [
    { field: "spend", metric: "spend", label: "Ad spend" },
    { field: "revenue", metric: "totalRevenue", label: "Total revenue" },
    { field: "mer", metric: "mer", label: "MER" },
    { field: "ncac", metric: "ncac", label: "nCAC" },
    { field: "orders", metric: "orders", label: "Orders" },
    { field: "newCustomers", metric: "newCustomers", label: "New customers" },
  ],
  META: [
    { field: "spend", metric: "spend", label: "Meta spend" },
    { field: "roas", metric: "roas", label: "Meta ROAS" },
    { field: "cpa", metric: "cpa", label: "Meta CPA" },
  ],
  GOOGLE: [
    { field: "spend", metric: "spend", label: "Google spend" },
    { field: "roas", metric: "roas", label: "Google ROAS" },
    { field: "cpa", metric: "cpa", label: "Google CPA" },
  ],
};
export type TargetField = "spend" | "revenue" | "mer" | "roas" | "cpa" | "ncac" | "orders" | "newCustomers";
export type TargetValues = Partial<Record<TargetField, number | null>>;

export interface MonthTargets {
  month: string;
  CLIENT: TargetValues;
  META: TargetValues;
  GOOGLE: TargetValues;
}

interface MonthRow {
  month: string;
  scope: TargetScope;
  totals: Totals;
  days: number;
}

/** Actuals per month (client blended + per ad platform), all in the reporting currency. */
async function monthActuals(clientId: string, from: string, to: string): Promise<MonthRow[]> {
  const blended = await prisma.$queryRawUnsafe<Record<string, number | string>[]>(
    `SELECT to_char(date_trunc('month', date), 'YYYY-MM-DD') AS month, COUNT(DISTINCT date)::int AS days,
       SUM(ad_spend)::float8 AS spend, SUM(platform_revenue)::float8 AS "platformRevenue", SUM(total_revenue)::float8 AS "totalRevenue",
       SUM(shopify_orders)::float8 AS orders, SUM(new_customers)::float8 AS "newCustomers", SUM(new_customer_revenue)::float8 AS "newCustomerRevenue",
       SUM(shopify_net_sales)::float8 AS "netSales", SUM(gross_sales)::float8 AS "grossSales", SUM(discounts)::float8 AS discounts,
       SUM(cogs)::float8 AS cogs, SUM(payment_fees)::float8 AS "paymentFees", SUM(other_revenue)::float8 AS "otherRevenue"
     FROM v_client_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date GROUP BY 1`,
    clientId,
    from,
    to,
  );
  const ads = await prisma.$queryRawUnsafe<Record<string, number | string>[]>(
    `SELECT to_char(date_trunc('month', date), 'YYYY-MM-DD') AS month, platform, COUNT(DISTINCT date)::int AS days,
       SUM(spend)::float8 AS spend, SUM(purchase_value)::float8 AS "purchaseValue", SUM(purchases)::float8 AS purchases
     FROM mv_ad_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date GROUP BY 1, 2`,
    clientId,
    from,
    to,
  );
  const num = (r: Record<string, number | string>, keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, r[k] === null ? null : Number(r[k])])) as Totals;
  return [
    ...blended.map((r) => ({
      month: String(r.month),
      scope: "CLIENT" as const,
      days: Number(r.days),
      totals: num(r, [
        "spend",
        "platformRevenue",
        "totalRevenue",
        "orders",
        "newCustomers",
        "newCustomerRevenue",
        "netSales",
        "grossSales",
        "discounts",
        "cogs",
        "paymentFees",
        "otherRevenue",
      ]),
    })),
    ...ads.map((r) => ({
      month: String(r.month),
      scope: r.platform as TargetScope,
      days: Number(r.days),
      totals: num(r, ["spend", "purchaseValue", "purchases"]),
    })),
  ];
}

function metricActual(metric: string, t: Totals | undefined): number | null {
  if (!t) return null;
  return ADDITIVE_TARGETS.has(metric) ? (computeMetric(metric, t) ?? 0) : computeMetric(metric, t);
}

async function targetsBetween(clientId: string, fromMonth: string, toMonth: string): Promise<MonthTargets[]> {
  const rows = await prisma.target.findMany({
    where: { clientId, connectionId: null, month: { gte: new Date(fromMonth + "T00:00:00Z"), lte: new Date(toMonth + "T00:00:00Z") } },
  });
  const map = new Map<string, MonthTargets>();
  for (const r of rows) {
    const m = r.month.toISOString().slice(0, 10);
    const entry = map.get(m) ?? { month: m, CLIENT: {}, META: {}, GOOGLE: {} };
    const scope: TargetScope = (r.platform as TargetScope | null) ?? "CLIENT";
    if (scope !== "CLIENT" && scope !== "META" && scope !== "GOOGLE") continue;
    entry[scope] = {
      spend: r.spend,
      revenue: r.revenue,
      mer: r.mer,
      roas: r.roas,
      cpa: r.cpa,
      ncac: r.ncac,
      orders: r.orders,
      newCustomers: r.newCustomers,
    };
    map.set(m, entry);
  }
  return [...map.values()];
}

export interface PacingGroup {
  scope: TargetScope;
  items: (PaceResult & { label: string; field: TargetField })[];
}

export interface MonthPacing {
  month: string;
  isCurrent: boolean;
  daysElapsed: number;
  daysInMonth: number;
  through: string | null;
  groups: PacingGroup[];
  targets: MonthTargets;
}

/**
 * Pacing for a month. For the current month, actuals run through yesterday (complete days only);
 * past months use the full month and the projection equals the actual.
 */
export async function getMonthPacing(clientId: string, month: string, today: string): Promise<MonthPacing> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`client:${clientId}`, `targets:${clientId}`);
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const daysInMonth = Number(end.slice(8, 10));
  const yesterday = addDays(today, -1);
  const isCurrent = today >= start && today <= end;
  const through = isCurrent ? (yesterday >= start ? yesterday : null) : end;
  const daysElapsed = isCurrent ? (through ? Number(through.slice(8, 10)) : 0) : daysInMonth;
  const [actuals, targets] = await Promise.all([
    through ? monthActuals(clientId, start, through) : Promise.resolve([]),
    targetsBetween(clientId, start, start),
  ]);
  const t: MonthTargets = targets[0] ?? { month: start, CLIENT: {}, META: {}, GOOGLE: {} };
  const groups: PacingGroup[] = (["CLIENT", "META", "GOOGLE"] as const).map((scope) => {
    const totals = actuals.find((a) => a.scope === scope)?.totals;
    return {
      scope,
      items: TARGET_FIELDS[scope]
        .filter((f) => typeof t[scope][f.field] === "number")
        .map((f) => ({
          ...pace({
            metric: f.metric,
            target: t[scope][f.field] as number,
            actual: metricActual(f.metric, totals),
            daysElapsed,
            daysInMonth,
          }),
          label: f.label,
          field: f.field,
        })),
    };
  });
  return { month: start, isCurrent, daysElapsed, daysInMonth, through, groups, targets: t };
}

export interface HistoryRow {
  month: string;
  items: { scope: TargetScope; field: TargetField; metric: string; label: string; target: number | null; actual: number | null }[];
}

/** Month-by-month target vs actual (last `n` months including the current one). */
export async function getTargetHistory(clientId: string, today: string, n = 12): Promise<HistoryRow[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`client:${clientId}`, `targets:${clientId}`);
  const last = startOfMonth(today);
  const first = addMonths(last, -(n - 1));
  const [actuals, targets] = await Promise.all([monthActuals(clientId, first, addDays(today, -1)), targetsBetween(clientId, first, last)]);
  const rows: HistoryRow[] = [];
  for (let m = last; m >= first; m = addMonths(m, -1)) {
    const t = targets.find((x) => x.month === m);
    const items = (["CLIENT", "META", "GOOGLE"] as const).flatMap((scope) => {
      const totals = actuals.find((a) => a.month === m && a.scope === scope)?.totals;
      return TARGET_FIELDS[scope].map((f) => ({
        scope,
        field: f.field,
        metric: f.metric,
        label: f.label,
        target: (t?.[scope][f.field] as number | null | undefined) ?? null,
        actual: metricActual(f.metric, totals),
      }));
    });
    if (items.some((i) => i.target !== null || i.actual !== null)) rows.push({ month: m, items });
  }
  return rows;
}

/** AOV and gross margin from Shopify over the last 90 complete days (for the breakeven calculator). */
export async function getShopifyEconomics(clientId: string, today: string) {
  "use cache";
  cacheLife("hours");
  cacheTag(`client:${clientId}`);
  const r = await prisma.$queryRawUnsafe<
    { orders: number; gross: number; discounts: number; net: number; cogs: number; fees: number; spend: number }[]
  >(
    `SELECT SUM(shopify_orders)::float8 AS orders, SUM(gross_sales)::float8 AS gross, SUM(discounts)::float8 AS discounts,
            SUM(shopify_net_sales)::float8 AS net, SUM(cogs)::float8 AS cogs, SUM(payment_fees)::float8 AS fees, SUM(ad_spend)::float8 AS spend
     FROM v_client_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date`,
    clientId,
    addDays(today, -90),
    addDays(today, -1),
  );
  const x = r[0];
  if (!x || !x.orders) return null;
  const aov = (x.gross - x.discounts) / x.orders;
  const marginPct = x.net > 0 ? ((x.net - x.cogs - x.fees) / x.net) * 100 : null;
  return { aov, marginPct, monthlySpend: (x.spend / 90) * 30 };
}
