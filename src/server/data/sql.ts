import "server-only";
import { prisma } from "@/lib/db";
import type { Granularity } from "@/lib/periods";
import type { Totals } from "@/lib/metrics";

/** Query scope: always a single client, optionally a subset of its connections. */
export interface Scope {
  clientId: string;
  currency: string; // reporting currency
  conn: string[] | null; // null = all accounts
  from: string;
  to: string;
}

export type AdPlatform = "META" | "GOOGLE";
export type Level = "ACCOUNT" | "CAMPAIGN" | "ADSET" | "AD" | "KEYWORD" | "SEARCH_TERM";
export type Breakdown = "AGE" | "GENDER" | "PLACEMENT" | "COUNTRY" | "REGION" | "HOUR" | "DEVICE" | "AUDIENCE_TYPE";

const GRAN: Record<Granularity, string> = { day: "day", week: "week", month: "month", year: "year" };
const LEVELS = new Set<Level>(["ACCOUNT", "CAMPAIGN", "ADSET", "AD", "KEYWORD", "SEARCH_TERM"]);
const BREAKDOWNS = new Set<Breakdown>(["AGE", "GENDER", "PLACEMENT", "COUNTRY", "REGION", "HOUR", "DEVICE", "AUDIENCE_TYPE"]);
const PLATFORMS = new Set<AdPlatform>(["META", "GOOGLE"]);

function bucketExpr(col: string, g: Granularity) {
  return `to_char(date_trunc('${GRAN[g]}', ${col}), 'YYYY-MM-DD')`;
}
function guard<T>(set: Set<T>, v: T): T {
  if (!set.has(v)) throw new Error(`Invalid identifier: ${String(v)}`);
  return v;
}

async function q<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql, ...params);
}

/** FX factor per (currency, day) for the scope, so money is summed in the reporting currency. */
const FX_CTE = `fx AS (
  SELECT cur.currency AS cur, d::date AS d, fx_factor(cur.currency, $4, d::date) AS f
  FROM (SELECT DISTINCT currency FROM connections WHERE "clientId" = $1) cur
  CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
)`;

const AD_METRICS = `
  SUM(a.spend * fx.f)::float8 AS spend,
  SUM(a.impressions)::float8 AS impressions,
  SUM(a.reach)::float8 AS reach,
  SUM(a.clicks)::float8 AS clicks,
  SUM(a."linkClicks")::float8 AS "linkClicks",
  SUM(a.purchases)::float8 AS purchases,
  SUM(a."purchaseValue" * fx.f)::float8 AS "purchaseValue",
  SUM(a."addToCart")::float8 AS "addToCart",
  SUM(a."initiateCheckout")::float8 AS "initiateCheckout",
  SUM(a.leads)::float8 AS leads,
  SUM(a.results)::float8 AS results,
  SUM(a."resultsValue" * fx.f)::float8 AS "resultsValue"`;

const VIDEO_METRICS = `,
  SUM(a."videoViews3s")::float8 AS "videoViews3s",
  SUM(a."thruPlays")::float8 AS "thruPlays"`;

export const METRIC_COLS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "linkClicks",
  "purchases",
  "purchaseValue",
  "addToCart",
  "initiateCheckout",
  "leads",
  "results",
  "resultsValue",
  "videoViews3s",
  "thruPlays",
] as const;

export function pickTotals(r: Record<string, unknown>, keys: readonly string[] = METRIC_COLS): Totals {
  const t: Record<string, number | null> = {};
  for (const k of keys) {
    const v = r[k];
    t[k] = v === null || v === undefined ? null : Number(v);
  }
  return t as Totals;
}

interface AdFilter {
  platform: AdPlatform;
  campaignId?: string | null;
  leadOnly?: boolean;
}

/** WHERE clause for ad_insights_daily alias `a`. Params: $1 client, $2 from, $3 to, $4 currency, $5 conn[], $6 platform, $7 campaign */
function adWhere(level: Level, f: AdFilter) {
  guard(LEVELS, level);
  guard(PLATFORMS, f.platform);
  return `a."clientId" = $1 AND a.date BETWEEN $2::date AND $3::date AND a.attribution = 'default'
    AND a.level = '${level}'::"EntityLevel" AND a.platform = $6::"Platform"
    AND ($5::text[] IS NULL OR a."connectionId" = ANY($5::text[]))
    AND ($7::text IS NULL OR a."campaignId" = $7)
    ${f.leadOnly ? `AND EXISTS (SELECT 1 FROM ad_entities le WHERE le."connectionId" = a."connectionId" AND le.level = 'CAMPAIGN' AND le."externalId" = a."campaignId" AND le.objective ILIKE '%LEAD%')` : ""}`;
}
const adParams = (s: Scope, f: AdFilter) => [s.clientId, s.from, s.to, s.currency, s.conn, f.platform, f.campaignId ?? null];

export type AdRow = Record<string, unknown> & { bucket: string; entity_id: string; entity_name: string; connection_id: string };

/** Campaign rows per time bucket (Core, Lead Gen). */
export function adByBucketCampaign(s: Scope, f: AdFilter, g: Granularity) {
  return q<AdRow>(
    `WITH ${FX_CTE}
     SELECT ${bucketExpr("a.date", g)} AS bucket, a."campaignId" AS entity_id, MAX(a."campaignName") AS entity_name, a."connectionId" AS connection_id, ${AD_METRICS}${VIDEO_METRICS}
     FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
     WHERE ${adWhere("CAMPAIGN", f)}
     GROUP BY 1, 2, 4 ORDER BY 1`,
    ...adParams(s, f),
  );
}

/** Account-level series per day (Day of Week). */
export function adDaily(s: Scope, f: AdFilter) {
  return q<AdRow>(
    `WITH ${FX_CTE}
     SELECT to_char(a.date, 'YYYY-MM-DD') AS bucket, 'all' AS entity_id, '' AS entity_name, '' AS connection_id, ${AD_METRICS}${VIDEO_METRICS}
     FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
     WHERE ${adWhere(f.campaignId ? "CAMPAIGN" : "ACCOUNT", f)}
     GROUP BY 1 ORDER BY 1`,
    ...adParams(s, f),
  );
}

export type EntityRow = Record<string, unknown> & {
  entity_id: string;
  entity_name: string;
  connection_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  status: string | null;
  campaign_type: string | null;
  objective: string | null;
  landing_url: string | null;
  review: string | null;
  thumb: string | null;
  creative_type: string | null;
  headline: string | null;
  body: string | null;
};

/** Aggregated per entity over the range (Campaigns, Ad Sets, Ads, Keywords, Search terms, Creatives). */
export function adByEntity(s: Scope, f: AdFilter, level: Level) {
  return q<EntityRow>(
    `WITH ${FX_CTE}, agg AS (
       SELECT a."connectionId", a."entityId", MAX(a."entityName") AS entity_name, MAX(a."campaignId") AS campaign_id, MAX(a."campaignName") AS campaign_name,
              MAX(a."adsetId") AS adset_id, MAX(a."adsetName") AS adset_name, ${AD_METRICS}${VIDEO_METRICS}
       FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
       WHERE ${adWhere(level, f)}
       GROUP BY a."connectionId", a."entityId"
     )
     SELECT agg.*, agg."entityId" AS entity_id, agg."connectionId" AS connection_id,
            COALESCE(e."effectiveStatus", e.status) AS status, COALESCE(e."campaignType", ce."campaignType") AS campaign_type, COALESCE(e.objective, ce.objective) AS objective,
            e."landingUrl" AS landing_url, e."reviewFeedback" AS review,
            cr."thumbnailUrl" AS thumb, cr.type AS creative_type, cr.headline, cr.body
     FROM agg
     LEFT JOIN ad_entities e ON e."connectionId" = agg."connectionId" AND e.level = '${level}'::"EntityLevel" AND e."externalId" = agg."entityId"
     LEFT JOIN ad_entities ce ON ce."connectionId" = agg."connectionId" AND ce.level = 'CAMPAIGN' AND ce."externalId" = agg.campaign_id
     LEFT JOIN creatives cr ON cr."connectionId" = agg."connectionId" AND cr."adExternalId" = agg."entityId"
     ORDER BY spend DESC NULLS LAST`,
    ...adParams(s, f),
  );
}

/** Ad-level performance grouped by an attribute of the ad / campaign entity. */
export function adByAttribute(s: Scope, f: AdFilter, attr: "landing" | "campaignType") {
  const level: Level = attr === "landing" ? "AD" : "CAMPAIGN";
  const key = attr === "landing" ? `COALESCE(split_part(e."landingUrl", '?', 1), '(unknown)')` : `COALESCE(e."campaignType", '(unknown)')`;
  return q<AdRow & { n: number }>(
    `WITH ${FX_CTE}
     SELECT ${key} AS entity_id, ${key} AS entity_name, '' AS connection_id, '' AS bucket, COUNT(DISTINCT a."entityId")::int AS n, ${AD_METRICS}${VIDEO_METRICS}
     FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
     LEFT JOIN ad_entities e ON e."connectionId" = a."connectionId" AND e.level = '${level}'::"EntityLevel" AND e."externalId" = a."entityId"
     WHERE ${adWhere(level, f)}
     GROUP BY 1 ORDER BY spend DESC`,
    ...adParams(s, f),
  );
}

/** Breakdown rows (Age, Gender, Placement, Country, Device, Audience type, Hour). */
export function adBreakdown(s: Scope, f: AdFilter, type: Breakdown, byDow = false) {
  guard(BREAKDOWNS, type);
  guard(PLATFORMS, f.platform);
  return q<AdRow & { dow: number | null }>(
    `WITH ${FX_CTE}
     SELECT a."breakdownValue" AS entity_id, a."breakdownValue" AS entity_name, '' AS connection_id, '' AS bucket,
            ${byDow ? `(EXTRACT(isodow FROM a.date)::int - 1)` : "NULL::int"} AS dow, ${AD_METRICS}
     FROM ad_insights_breakdown a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
     WHERE a."clientId" = $1 AND a.date BETWEEN $2::date AND $3::date AND a.attribution = 'default'
       AND a."breakdownType" = '${type}'::"BreakdownType" AND a.platform = $6::"Platform"
       AND ($5::text[] IS NULL OR a."connectionId" = ANY($5::text[]))
       AND ($7::text IS NULL OR a."campaignId" = $7)
     GROUP BY 1, 5 ORDER BY 1`,
    ...adParams(s, f),
  );
}

/** Total ad spend for the scope (for "% of spend"). */
export async function adTotalSpend(s: Scope, f: AdFilter): Promise<number> {
  const r = await q<{ spend: number | null }>(
    `WITH ${FX_CTE}
     SELECT SUM(a.spend * fx.f)::float8 AS spend FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
     WHERE ${adWhere(f.campaignId ? "CAMPAIGN" : "ACCOUNT", f)}`,
    ...adParams(s, f),
  );
  return r[0]?.spend ?? 0;
}

export function campaignsFor(clientId: string, platform: AdPlatform, conn: string[] | null) {
  return q<{ id: string; name: string }>(
    `SELECT DISTINCT ON ("externalId") "externalId" AS id, name FROM ad_entities
     WHERE "clientId" = $1 AND platform = $2::"Platform" AND level = 'CAMPAIGN' AND ($3::text[] IS NULL OR "connectionId" = ANY($3::text[]))
     ORDER BY "externalId", name`,
    clientId,
    platform,
    conn,
  );
}

// ───────────────────────── Commerce ─────────────────────────

const SHOP_COLS = [
  "orders",
  "grossSales",
  "discounts",
  "refunds",
  "netSales",
  "shipping",
  "taxes",
  "cogs",
  "paymentFees",
  "newCustomers",
  "returningOrders",
  "newCustomerRevenue",
  "returningCustomerRevenue",
] as const;
export { SHOP_COLS };

/** Shopify per bucket per store (from the materialized view, already in reporting currency). */
export function shopByBucket(s: Scope, g: Granularity) {
  return q<Record<string, unknown> & { bucket: string; connection_id: string }>(
    `SELECT ${bucketExpr("date", g)} AS bucket, connection_id,
       SUM(orders)::float8 AS orders, SUM(gross_sales)::float8 AS "grossSales", SUM(discounts)::float8 AS discounts, SUM(refunds)::float8 AS refunds,
       SUM(net_sales)::float8 AS "netSales", SUM(shipping)::float8 AS shipping, SUM(taxes)::float8 AS taxes, SUM(cogs)::float8 AS cogs,
       SUM(payment_fees)::float8 AS "paymentFees", SUM(new_customers)::float8 AS "newCustomers", SUM(returning_orders)::float8 AS "returningOrders",
       SUM(new_customer_revenue)::float8 AS "newCustomerRevenue", SUM(returning_customer_revenue)::float8 AS "returningCustomerRevenue"
     FROM mv_shopify_daily
     WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date AND ($4::text[] IS NULL OR connection_id = ANY($4::text[]))
     GROUP BY 1, 2 ORDER BY 1`,
    s.clientId,
    s.from,
    s.to,
    s.conn,
  );
}

const ORDER_FX = `ofx AS (
  SELECT cur.currency AS cur, d::date AS d, fx_factor(cur.currency, $4, d::date) AS f
  FROM (SELECT DISTINCT currency FROM connections WHERE "clientId" = $1) cur
  CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
)`;
const ORDER_WHERE = `o."clientId" = $1 AND o.date BETWEEN $2::date AND $3::date AND o."cancelledAt" IS NULL AND ($5::text[] IS NULL OR o."connectionId" = ANY($5::text[]))`;
const orderParams = (s: Scope) => [s.clientId, s.from, s.to, s.currency, s.conn];

/** Shopify revenue by last-click / first-click channel, optionally per bucket. */
export function shopByChannel(s: Scope, g: Granularity | null) {
  return q<{
    bucket: string;
    channel: string;
    first_revenue: number;
    revenue: number;
    orders: number;
    new_customers: number;
    gross: number;
    discounts: number;
  }>(
    `WITH ${ORDER_FX}
     SELECT ${g ? bucketExpr("o.date", g) : "''"} AS bucket, COALESCE(o."channelLastClick", 'OTHER') AS channel,
       SUM((o."grossSales" - o.discounts) * ofx.f)::float8 AS revenue, COUNT(*)::float8 AS orders,
       COUNT(*) FILTER (WHERE o."isNewCustomer")::float8 AS new_customers,
       SUM(o."grossSales" * ofx.f)::float8 AS gross, SUM(o.discounts * ofx.f)::float8 AS discounts,
       0::float8 AS first_revenue
     FROM shopify_orders o JOIN ofx ON ofx.cur = o.currency AND ofx.d = o.date
     WHERE ${ORDER_WHERE}
     GROUP BY 1, 2
     UNION ALL
     SELECT ${g ? bucketExpr("o.date", g) : "''"}, COALESCE(o."channelFirstClick", 'OTHER'), 0, 0, 0, 0, 0, SUM((o."grossSales" - o.discounts) * ofx.f)::float8
     FROM shopify_orders o JOIN ofx ON ofx.cur = o.currency AND ofx.d = o.date
     WHERE ${ORDER_WHERE}
     GROUP BY 1, 2`,
    ...orderParams(s),
  );
}

export function shopProducts(s: Scope) {
  return q<{ id: string; title: string; units: number; orders: number; gross: number; cogs: number | null; missing_cost: number }>(
    `WITH ${ORDER_FX}
     SELECT l."productId" AS id, MAX(l.title) AS title, SUM(l.quantity)::float8 AS units, COUNT(DISTINCT o.id)::float8 AS orders,
       SUM(l.price * l.quantity * ofx.f)::float8 AS gross,
       SUM(COALESCE(pc."unitCost", l."unitCost" * ofx.f) * l.quantity)::float8 AS cogs,
       COUNT(*) FILTER (WHERE COALESCE(pc."unitCost", l."unitCost") IS NULL)::int AS missing_cost
     FROM shopify_order_lines l JOIN shopify_orders o ON o.id = l."orderId" JOIN ofx ON ofx.cur = o.currency AND ofx.d = o.date
     LEFT JOIN product_costs pc ON pc."clientId" = o."clientId" AND pc."productId" = l."productId" AND pc."variantId" = ''
     WHERE ${ORDER_WHERE}
     GROUP BY 1 ORDER BY gross DESC`,
    ...orderParams(s),
  );
}

export function shopDiscountCodes(s: Scope) {
  return q<{ code: string; orders: number; gross: number; discounts: number; new_customers: number }>(
    `WITH ${ORDER_FX}
     SELECT COALESCE(code, '(no code)') AS code, COUNT(*)::float8 AS orders, SUM(o."grossSales" * ofx.f)::float8 AS gross,
       SUM(o.discounts * ofx.f)::float8 AS discounts, COUNT(*) FILTER (WHERE o."isNewCustomer")::float8 AS new_customers
     FROM shopify_orders o JOIN ofx ON ofx.cur = o.currency AND ofx.d = o.date
     LEFT JOIN LATERAL unnest(CASE WHEN cardinality(o."discountCodes") = 0 THEN ARRAY[NULL]::text[] ELSE o."discountCodes" END) code ON true
     WHERE ${ORDER_WHERE}
     GROUP BY 1 ORDER BY orders DESC`,
    ...orderParams(s),
  );
}

export function shopRefundsByBucket(s: Scope, g: Granularity) {
  return q<{ bucket: string; refunds: number; refund_count: number }>(
    `WITH ${ORDER_FX}
     SELECT ${bucketExpr("r.date", g)} AS bucket, SUM(r.amount * ofx.f)::float8 AS refunds, COUNT(*)::float8 AS refund_count
     FROM shopify_refunds r JOIN shopify_orders o ON o.id = r."orderId" JOIN ofx ON ofx.cur = r.currency AND ofx.d = r.date
     WHERE r."clientId" = $1 AND r.date BETWEEN $2::date AND $3::date AND ($5::text[] IS NULL OR o."connectionId" = ANY($5::text[]))
     GROUP BY 1 ORDER BY 1`,
    ...orderParams(s),
  );
}

export function otherByBucket(s: Scope, g: Granularity | null, includeOther: boolean) {
  if (!includeOther) return Promise.resolve([] as { bucket: string; source: string; revenue: number; orders: number }[]);
  return q<{ bucket: string; source: string; revenue: number; orders: number }>(
    `SELECT ${g ? bucketExpr("date", g) : "''"} AS bucket, source, SUM(revenue)::float8 AS revenue, SUM(orders)::float8 AS orders
     FROM mv_other_revenue_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date
     GROUP BY 1, 2 ORDER BY 1`,
    s.clientId,
    s.from,
    s.to,
  );
}

/** Ad spend & platform revenue per bucket per platform (All Platforms). */
export function adsByBucketPlatform(s: Scope, g: Granularity) {
  return q<Record<string, unknown> & { bucket: string; platform: string }>(
    `SELECT ${bucketExpr("date", g)} AS bucket, platform,
       SUM(spend)::float8 AS spend, SUM(purchase_value)::float8 AS "purchaseValue", SUM(purchases)::float8 AS purchases,
       SUM(impressions)::float8 AS impressions, SUM(clicks)::float8 AS clicks, SUM(add_to_cart)::float8 AS "addToCart",
       SUM(initiate_checkout)::float8 AS "initiateCheckout", SUM(leads)::float8 AS leads
     FROM mv_ad_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date AND ($4::text[] IS NULL OR connection_id = ANY($4::text[]))
     GROUP BY 1, 2 ORDER BY 1`,
    s.clientId,
    s.from,
    s.to,
    s.conn,
  );
}

export function targetsFor(clientId: string, from: string, to: string) {
  return prisma.target.findMany({
    where: { clientId, connectionId: null, month: { gte: new Date(from.slice(0, 8) + "01T00:00:00Z"), lte: new Date(to + "T00:00:00Z") } },
  });
}
