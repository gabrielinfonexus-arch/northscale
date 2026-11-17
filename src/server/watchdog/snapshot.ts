import "server-only";
import { prisma } from "@/lib/db";
import { addDays, endOfMonth, startOfMonth, todayInTz } from "@/lib/periods";
import type { AdPlatform, DayAd, WatchdogInput } from "@/lib/watchdog/rules";

const q = <T>(sql: string, ...params: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...params);

/** FX CTE: factor per (currency, day) to the client's reporting currency. Params: $1 client, $2 from, $3 to, $4 currency. */
const FX = `fx AS (
  SELECT cur.currency AS cur, d::date AS d, fx_factor(cur.currency, $4, d::date) AS f
  FROM (SELECT DISTINCT currency FROM connections WHERE "clientId" = $1) cur
  CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
)`;

/** Everything the Watchdog rules read for one client, from the single reporting database. */
export async function buildSnapshot(client: { id: string; currency: string; timezone: string }, adWindowDays = 14): Promise<WatchdogInput> {
  const today = todayInTz(client.timezone);
  const yesterday = addDays(today, -1);
  const from = addDays(today, -40);
  const monthStart = startOfMonth(yesterday);
  const P = [client.id, from, yesterday, client.currency];

  const [daily, blended, connections, conSpend, targets, rejected, prospecting, ads, adsAccount] = await Promise.all([
    // account-level daily per platform (ATC stays NULL when the platform doesn't report it)
    q<{
      date: string;
      platform: AdPlatform;
      spend: number;
      purchases: number;
      value: number;
      clicks: number;
      impressions: number;
      atc: number | null;
    }>(
      `WITH ${FX}
       SELECT to_char(a.date, 'YYYY-MM-DD') AS date, a.platform::text AS platform, SUM(a.spend * fx.f)::float8 AS spend, SUM(a.purchases)::float8 AS purchases,
              SUM(a."purchaseValue" * fx.f)::float8 AS value, SUM(a.clicks)::float8 AS clicks, SUM(a.impressions)::float8 AS impressions, SUM(a."addToCart")::float8 AS atc
       FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
       WHERE a."clientId" = $1 AND a.date BETWEEN $2::date AND $3::date AND a.level = 'ACCOUNT' AND a.attribution = 'default' AND a.platform IN ('META', 'GOOGLE')
       GROUP BY 1, 2 ORDER BY 1`,
      ...P,
    ),
    q<{ date: string; spend: number; total_revenue: number; orders: number; net_sales: number; platform_revenue: number }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, ad_spend::float8 AS spend, total_revenue::float8, shopify_orders::float8 AS orders,
              shopify_net_sales::float8 AS net_sales, platform_revenue::float8
       FROM v_client_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date ORDER BY date`,
      client.id,
      from,
      yesterday,
    ),
    prisma.connection.findMany({ where: { clientId: client.id }, include: { credential: { select: { tokenExpiresAt: true } } } }),
    q<{ connection_id: string; date: string; spend: number }>(
      `SELECT connection_id, to_char(date, 'YYYY-MM-DD') AS date, spend::float8 FROM mv_ad_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date ORDER BY date`,
      client.id,
      addDays(yesterday, -13),
      yesterday,
    ),
    prisma.target.findMany({ where: { clientId: client.id, connectionId: null, month: new Date(monthStart + "T00:00:00Z") } }),
    q<{ connection_id: string; platform: string; ad_id: string; name: string; review: string; spend7d: number }>(
      `WITH ${FX}
       SELECT e."connectionId" AS connection_id, e.platform::text AS platform, e."externalId" AS ad_id, e.name, e."reviewFeedback" AS review,
              COALESCE(SUM(a.spend * fx.f) FILTER (WHERE a.date >= $3::date - 6), 0)::float8 AS spend7d
       FROM ad_entities e
       LEFT JOIN ad_insights_daily a ON a."connectionId" = e."connectionId" AND a.level = 'AD' AND a."entityId" = e."externalId" AND a.attribution = 'default' AND a.date BETWEEN $2::date AND $3::date
       LEFT JOIN fx ON fx.cur = a.currency AND fx.d = a.date
       WHERE e."clientId" = $1 AND e.level = 'AD' AND e."reviewFeedback" IS NOT NULL
       GROUP BY 1, 2, 3, 4, 5`,
      ...P,
    ),
    q<{ connection_id: string; campaign_id: string; name: string; impressions: number; reach: number | null; spend: number }>(
      `WITH ${FX}
       SELECT a."connectionId" AS connection_id, a."entityId" AS campaign_id, MAX(a."entityName") AS name, SUM(a.impressions)::float8 AS impressions,
              SUM(a.reach)::float8 AS reach, SUM(a.spend * fx.f)::float8 AS spend
       FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
       JOIN ad_entities e ON e."connectionId" = a."connectionId" AND e.level = 'CAMPAIGN' AND e."externalId" = a."entityId" AND e."isProspecting" = true
       WHERE a."clientId" = $1 AND a.platform = 'META' AND a.level = 'CAMPAIGN' AND a.attribution = 'default' AND a.date BETWEEN $3::date - 6 AND $3::date
       GROUP BY 1, 2`,
      ...P,
    ),
    q<{ platform: AdPlatform; connection_id: string; ad_id: string; name: string; spend: number; purchases: number; value: number }>(
      `WITH ${FX}
       SELECT a.platform::text AS platform, a."connectionId" AS connection_id, a."entityId" AS ad_id, MAX(a."entityName") AS name,
              SUM(a.spend * fx.f)::float8 AS spend, SUM(a.purchases)::float8 AS purchases, SUM(a."purchaseValue" * fx.f)::float8 AS value
       FROM ad_insights_daily a JOIN fx ON fx.cur = a.currency AND fx.d = a.date
       WHERE a."clientId" = $1 AND a.level = 'AD' AND a.attribution = 'default' AND a.platform IN ('META', 'GOOGLE') AND a.date BETWEEN $3::date - ($5::int - 1) AND $3::date
       GROUP BY 1, 2, 3 HAVING SUM(a.spend) > 0`,
      ...P,
      adWindowDays,
    ),
    q<{ platform: AdPlatform; spend: number }>(
      `WITH ${FX}
       SELECT m.platform::text AS platform, SUM(m.spend * fx.f)::float8 AS spend
       FROM mv_ad_daily m JOIN fx ON fx.cur = m.currency AND fx.d = m.date
       WHERE m.client_id = $1 AND m.platform IN ('META', 'GOOGLE') AND m.date BETWEEN $3::date - ($5::int - 1) AND $3::date
       GROUP BY 1`,
      ...P,
      adWindowDays,
    ),
  ]);

  const platformDaily: WatchdogInput["platformDaily"] = {};
  for (const d of daily) {
    const row: DayAd = {
      date: d.date,
      spend: d.spend ?? 0,
      purchases: d.purchases ?? 0,
      value: d.value ?? 0,
      clicks: d.clicks ?? 0,
      impressions: d.impressions ?? 0,
      addToCart: d.atc,
    };
    (platformDaily[d.platform] ??= []).push(row);
  }

  const t = (platform: string | null) => targets.find((x) => (x.platform ?? null) === platform);
  const mtd = { META: 0, GOOGLE: 0, CLIENT: 0 };
  for (const d of daily)
    if (d.date >= monthStart) {
      mtd[d.platform] += d.spend ?? 0;
      mtd.CLIENT += d.spend ?? 0;
    }

  const spendByConn = new Map<string, { date: string; spend: number }[]>();
  for (const r of conSpend)
    spendByConn.set(r.connection_id, [...(spendByConn.get(r.connection_id) ?? []), { date: r.date, spend: r.spend }]);

  return {
    today,
    currency: client.currency,
    platformDaily,
    blendedDaily: blended.map((b) => ({
      date: b.date,
      spend: b.spend,
      totalRevenue: b.total_revenue,
      orders: b.orders,
      netSales: b.net_sales,
      platformRevenue: b.platform_revenue,
    })),
    hasShopify: connections.some((c) => c.platform === "SHOPIFY"),
    connections: connections.map((c) => {
      const meta = (c.meta as { account?: { accountStatus?: string } } | null) ?? {};
      return {
        id: c.id,
        name: c.name,
        platform: c.platform,
        status: c.status,
        isDemo: c.isDemo,
        lastError: c.lastError,
        lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
        tokenExpiresAt: (c.credential?.tokenExpiresAt ?? c.tokenExpiresAt)?.toISOString() ?? null,
        accountStatus: meta.account?.accountStatus ?? null,
        dailySpend: spendByConn.get(c.id) ?? [],
      };
    }),
    targets: {
      META: { cpa: t("META")?.cpa, roas: t("META")?.roas, spend: t("META")?.spend },
      GOOGLE: { cpa: t("GOOGLE")?.cpa, roas: t("GOOGLE")?.roas, spend: t("GOOGLE")?.spend },
      CLIENT: { mer: t(null)?.mer, spend: t(null)?.spend },
    },
    monthToDate: { daysElapsed: Number(yesterday.slice(8, 10)), daysInMonth: Number(endOfMonth(monthStart).slice(8, 10)), spend: mtd },
    rejectedAds: rejected.map((r) => ({
      connectionId: r.connection_id,
      platform: r.platform,
      adId: r.ad_id,
      name: r.name,
      review: r.review,
      spend7d: r.spend7d,
    })),
    prospecting: prospecting.map((p) => ({
      connectionId: p.connection_id,
      campaignId: p.campaign_id,
      name: p.name,
      impressions: p.impressions,
      reach: p.reach,
      spend: p.spend,
    })),
    ads: ads.map((a) => ({
      platform: a.platform,
      connectionId: a.connection_id,
      adId: a.ad_id,
      name: a.name,
      spend: a.spend,
      purchases: a.purchases,
      value: a.value,
    })),
    adsAccountSpend: Object.fromEntries(adsAccount.map((a) => [a.platform, a.spend])),
  };
}
