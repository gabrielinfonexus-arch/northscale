import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";
import { sumTotals, type Totals } from "@/lib/metrics";
import { addDays, bucketLabel, bucketStart, bucketsInRange, eachDay, type DateRange, type Granularity } from "@/lib/periods";
import { classifyCreative } from "@/lib/rules/creative-status";
import type { ChartNoteDTO } from "@/lib/notes";
import type { CreativeBadge } from "./types";
import * as S from "./sql";
import { getNotes } from "../notes";
import { getMonthPacing, type MonthPacing } from "../targets";

export interface DashboardArgs {
  clientId: string;
  currency: string;
  conn: string[] | null;
  connections: Record<string, { name: string; platform: string }>;
  range: DateRange;
  compareRange: DateRange | null;
  gran: Granularity;
  today: string;
}

export interface SeriesPoint {
  bucket: string;
  label: string;
  totals: Totals;
  compare: Totals | null;
  /** first day of the comparison bucket (for tooltips) */
  compareLabel: string | null;
}

export interface DashboardModel {
  currency: string;
  gran: Granularity;
  total: Totals;
  totalCompare: Totals | null;
  /** daily totals for sparklines */
  daily: { date: string; totals: Totals }[];
  series: SeriesPoint[];
  spendByPlatform: { bucket: string; label: string; META: number; GOOGLE: number }[];
  revenueByChannel: { channel: string; label: string; revenue: number; orders: number }[];
  platformVsShopify: { bucket: string; label: string; platform: number; shopify: number }[];
  funnel: { totals: Totals; compare: Totals | null; accounts: number; accountsTotal: number };
  topCampaigns: { id: string; name: string; platform: string; account: string; totals: Totals }[];
  topCreatives: { id: string; name: string; thumb: string | null; type: string | null; totals: Totals; badge: CreativeBadge | null }[];
  topProducts: { id: string; title: string; units: number; revenue: number }[];
  pacing: MonthPacing;
  notes: ChartNoteDTO[];
}

const CHANNEL_LABEL: Record<string, string> = {
  META: "Meta",
  GOOGLE: "Google",
  EMAIL: "Email",
  ORGANIC: "Organic",
  DIRECT: "Direct",
  OTHER: "Other",
};

/** Blended totals per day: ads (all platforms) + Shopify + other revenue, in the reporting currency. */
async function blendedDaily(a: DashboardArgs, range: DateRange) {
  const sc: S.Scope = { clientId: a.clientId, currency: a.currency, conn: a.conn, from: range.from, to: range.to };
  const otherConn = Object.entries(a.connections).find(([, c]) => c.platform === "OTHER_REVENUE")?.[0];
  const includeOther = !a.conn || (!!otherConn && a.conn.includes(otherConn));
  const [ads, shop, other] = await Promise.all([
    S.adsByBucketPlatform(sc, "day"),
    S.shopByBucket(sc, "day"),
    S.otherByBucket(sc, "day", includeOther),
  ]);
  const parts = new Map<string, Totals[]>();
  const push = (d: string, t: Totals) => parts.set(d, [...(parts.get(d) ?? []), t]);
  const platformSpend = new Map<string, { META: number; GOOGLE: number }>();
  for (const r of ads) {
    const t = S.pickTotals(r, ["spend", "purchaseValue", "purchases", "impressions", "clicks", "leads"]);
    push(r.bucket, { ...t, platformRevenue: t.purchaseValue });
    const ps = platformSpend.get(r.bucket) ?? { META: 0, GOOGLE: 0 };
    if (r.platform === "META" || r.platform === "GOOGLE") ps[r.platform] += Number(r.spend ?? 0);
    platformSpend.set(r.bucket, ps);
  }
  for (const r of shop) push(r.bucket, S.pickTotals(r, S.SHOP_COLS));
  for (const r of other) push(r.bucket, { otherRevenue: r.revenue, otherOrders: r.orders });
  const daily = new Map<string, Totals>();
  for (const d of eachDay(range)) {
    const t = sumTotals(parts.get(d) ?? []);
    t.totalRevenue = (t.netSales ?? 0) + (t.otherRevenue ?? 0);
    daily.set(d, t);
  }
  return { daily, platformSpend };
}

/** Funnel from ad accounts that actually report ATC / IC (so rates are not diluted by accounts that don't). */
async function funnelTotals(a: DashboardArgs, range: DateRange) {
  const rows = await prisma.$queryRawUnsafe<(Record<string, number> & { tracked: number; accounts: number })[]>(
    `WITH fx AS (
       SELECT cur.currency AS cur, d::date AS d, fx_factor(cur.currency, $4, d::date) AS f
       FROM (SELECT DISTINCT currency FROM connections WHERE "clientId" = $1) cur
       CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
     ), acc AS (
       SELECT a."connectionId", bool_or(a."addToCart" IS NOT NULL) AS tracked,
         SUM(a.spend * fx.f) AS spend, SUM(a.impressions) AS impressions, SUM(a.clicks) AS clicks,
         SUM(a."addToCart") AS atc, SUM(a."initiateCheckout") AS ic, SUM(a.purchases) AS purchases
       FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
       WHERE a."clientId" = $1 AND a.date BETWEEN $2::date AND $3::date AND a.level = 'ACCOUNT' AND a.attribution = 'default'
         AND ($5::text[] IS NULL OR a."connectionId" = ANY($5::text[]))
       GROUP BY 1
     )
     SELECT COUNT(*) FILTER (WHERE tracked)::int AS tracked, COUNT(*)::int AS accounts,
       SUM(spend) FILTER (WHERE tracked)::float8 AS spend, SUM(impressions) FILTER (WHERE tracked)::float8 AS impressions,
       SUM(clicks) FILTER (WHERE tracked)::float8 AS clicks, SUM(atc) FILTER (WHERE tracked)::float8 AS "addToCart",
       SUM(ic) FILTER (WHERE tracked)::float8 AS "initiateCheckout", SUM(purchases) FILTER (WHERE tracked)::float8 AS purchases
     FROM acc`,
    a.clientId,
    range.from,
    range.to,
    a.currency,
    a.conn,
  );
  const r = rows[0];
  return {
    totals: S.pickTotals(r ?? {}, ["spend", "impressions", "clicks", "addToCart", "initiateCheckout", "purchases"]),
    accounts: r?.tracked ?? 0,
    accountsTotal: r?.accounts ?? 0,
  };
}

export async function getDashboard(a: DashboardArgs): Promise<DashboardModel> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`client:${a.clientId}`);

  const sc: S.Scope = { clientId: a.clientId, currency: a.currency, conn: a.conn, from: a.range.from, to: a.range.to };
  const [cur, cmp, channels, metaCampaigns, googleCampaigns, metaAds, metaSpend, products, funnel, funnelCmp, notes, pacing] =
    await Promise.all([
      blendedDaily(a, a.range),
      a.compareRange ? blendedDaily(a, a.compareRange) : null,
      S.shopByChannel(sc, null),
      S.adByEntity(sc, { platform: "META" }, "CAMPAIGN"),
      S.adByEntity(sc, { platform: "GOOGLE" }, "CAMPAIGN"),
      S.adByEntity(sc, { platform: "META" }, "AD"),
      S.adTotalSpend(sc, { platform: "META" }),
      S.shopProducts(sc),
      funnelTotals(a, a.range),
      a.compareRange ? funnelTotals(a, a.compareRange) : null,
      getNotes(a.clientId, a.range),
      getMonthPacing(a.clientId, a.today.slice(0, 8) + "01", a.today),
    ]);

  // ── time series by bucket, comparison by the same days shifted ──
  const offset = a.compareRange ? Math.round((Date.parse(a.compareRange.from) - Date.parse(a.range.from)) / 86_400_000) : 0;
  const days = eachDay(a.range);
  const buckets = bucketsInRange(a.range, a.gran);
  const daysByBucket = new Map<string, string[]>(buckets.map((b) => [b, []]));
  for (const d of days) daysByBucket.get(bucketStart(d, a.gran))?.push(d);
  const series: SeriesPoint[] = buckets.map((b) => {
    const ds = daysByBucket.get(b) ?? [];
    const totals = sumTotals(ds.map((d) => cur.daily.get(d) ?? {}));
    totals.totalRevenue = (totals.netSales ?? 0) + (totals.otherRevenue ?? 0);
    let compare: Totals | null = null;
    if (cmp) {
      const cd = ds.map((d) => cmp.daily.get(addDays(d, offset))).filter((x): x is Totals => !!x);
      if (cd.length) {
        compare = sumTotals(cd);
        compare.totalRevenue = (compare.netSales ?? 0) + (compare.otherRevenue ?? 0);
      }
    }
    return { bucket: b, label: bucketLabel(b, a.gran), totals, compare, compareLabel: cmp && ds.length ? addDays(ds[0], offset) : null };
  });

  const spendByPlatform = buckets.map((b) => {
    const ds = daysByBucket.get(b) ?? [];
    return {
      bucket: b,
      label: bucketLabel(b, a.gran),
      META: ds.reduce((s, d) => s + (cur.platformSpend.get(d)?.META ?? 0), 0),
      GOOGLE: ds.reduce((s, d) => s + (cur.platformSpend.get(d)?.GOOGLE ?? 0), 0),
    };
  });

  const total = sumTotals([...cur.daily.values()]);
  total.totalRevenue = (total.netSales ?? 0) + (total.otherRevenue ?? 0);
  let totalCompare: Totals | null = null;
  if (cmp) {
    totalCompare = sumTotals([...cmp.daily.values()]);
    totalCompare.totalRevenue = (totalCompare.netSales ?? 0) + (totalCompare.otherRevenue ?? 0);
  }

  const chMap = new Map<string, { revenue: number; orders: number }>();
  for (const r of channels) {
    const x = chMap.get(r.channel) ?? { revenue: 0, orders: 0 };
    x.revenue += r.revenue;
    x.orders += r.orders;
    chMap.set(r.channel, x);
  }
  const ORDER = ["META", "GOOGLE", "EMAIL", "ORGANIC", "DIRECT", "OTHER"];
  const revenueByChannel = ORDER.filter((c) => chMap.has(c) && chMap.get(c)!.revenue > 0).map((c) => ({
    channel: c,
    label: CHANNEL_LABEL[c],
    ...chMap.get(c)!,
  }));

  const metaTarget = pacing.targets.META;
  const topCampaigns = [...metaCampaigns.map((r) => ({ r, platform: "META" })), ...googleCampaigns.map((r) => ({ r, platform: "GOOGLE" }))]
    .map(({ r, platform }) => ({
      id: `${r.connection_id}:${r.entity_id}`,
      name: r.entity_name,
      platform,
      account: a.connections[r.connection_id]?.name ?? "",
      totals: S.pickTotals(r),
    }))
    .sort((x, y) => (y.totals.spend ?? 0) - (x.totals.spend ?? 0))
    .slice(0, 5);
  const topCreatives = metaAds
    .filter((r) => r.thumb)
    .slice(0, 5)
    .map((r) => {
      const t = S.pickTotals(r);
      return {
        id: `${r.connection_id}:${r.entity_id}`,
        name: r.entity_name,
        thumb: r.thumb,
        type: r.creative_type,
        totals: t,
        badge: classifyCreative({
          spend: t.spend ?? 0,
          purchases: t.purchases ?? 0,
          purchaseValue: t.purchaseValue ?? 0,
          accountSpend: metaSpend,
          targetCpa: metaTarget.cpa,
          targetRoas: metaTarget.roas,
        }),
      };
    });

  return {
    currency: a.currency,
    gran: a.gran,
    total,
    totalCompare,
    daily: days.map((d) => ({ date: d, totals: cur.daily.get(d) ?? {} })),
    series,
    spendByPlatform,
    revenueByChannel,
    platformVsShopify: series.map((p) => ({
      bucket: p.bucket,
      label: p.label,
      platform: p.totals.platformRevenue ?? 0,
      shopify: p.totals.netSales ?? 0,
    })),
    funnel: { totals: funnel.totals, compare: funnelCmp?.totals ?? null, accounts: funnel.accounts, accountsTotal: funnel.accountsTotal },
    topCampaigns,
    topCreatives,
    topProducts: products.slice(0, 5).map((p) => ({ id: p.id, title: p.title, units: p.units, revenue: p.gross })),
    pacing,
    notes,
  };
}
