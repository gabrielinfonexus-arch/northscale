import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";
import { pnlForDays, type CostSettings, type DayInput, type PnlLines } from "@/lib/pnl";
import { addDays, bucketLabel, bucketStart, bucketsInRange, eachDay, type DateRange, type Granularity } from "@/lib/periods";

export async function getCostSettings(clientId: string): Promise<CostSettings & { paymentFeePct: number; defaultMarginPct: number }> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`client:${clientId}`, `costs:${clientId}`);
  const [c, items] = await Promise.all([
    prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { shippingCostPerOrder: true, shippingCostPct: true, paymentFeePct: true, defaultMarginPct: true },
    }),
    prisma.costItem.findMany({ where: { clientId }, orderBy: { name: "asc" } }),
  ]);
  return {
    shippingCostPerOrder: c.shippingCostPerOrder,
    shippingCostPct: c.shippingCostPct,
    paymentFeePct: c.paymentFeePct,
    defaultMarginPct: c.defaultMarginPct,
    costItems: items.map((i) => ({
      name: i.name,
      type: i.type as CostSettings["costItems"][number]["type"],
      amount: i.amount,
      startDate: i.startDate?.toISOString().slice(0, 10) ?? null,
      endDate: i.endDate?.toISOString().slice(0, 10) ?? null,
    })),
  };
}

export async function getCostItems(clientId: string) {
  const items = await prisma.costItem.findMany({ where: { clientId }, orderBy: { name: "asc" } });
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    type: i.type,
    amount: i.amount,
    startDate: i.startDate?.toISOString().slice(0, 10) ?? "",
    endDate: i.endDate?.toISOString().slice(0, 10) ?? "",
  }));
}

/** Daily commerce + ad inputs for the P&L (client level, reporting currency). */
async function dailyInputs(clientId: string, range: DateRange): Promise<DayInput[]> {
  const [days, ads] = await Promise.all([
    prisma.$queryRawUnsafe<
      { date: string; gross: number; discounts: number; refunds: number; other: number; cogs: number; fees: number; orders: number }[]
    >(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, gross_sales::float8 AS gross, discounts::float8, refunds::float8, other_revenue::float8 AS other,
              cogs::float8, payment_fees::float8 AS fees, shopify_orders::float8 AS orders
       FROM v_client_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date`,
      clientId,
      range.from,
      range.to,
    ),
    prisma.$queryRawUnsafe<{ date: string; platform: string; spend: number }[]>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, platform, SUM(spend)::float8 AS spend FROM mv_ad_daily WHERE client_id = $1 AND date BETWEEN $2::date AND $3::date GROUP BY 1, 2`,
      clientId,
      range.from,
      range.to,
    ),
  ]);
  const byDay = new Map(days.map((d) => [d.date, d]));
  const adByDay = new Map<string, Record<string, number>>();
  for (const a of ads) adByDay.set(a.date, { ...(adByDay.get(a.date) ?? {}), [a.platform]: a.spend });
  return eachDay(range).map((date) => {
    const d = byDay.get(date);
    return {
      date,
      grossSales: d?.gross ?? 0,
      discounts: d?.discounts ?? 0,
      refunds: d?.refunds ?? 0,
      otherRevenue: d?.other ?? 0,
      cogs: d?.cogs ?? 0,
      paymentFees: d?.fees ?? 0,
      orders: d?.orders ?? 0,
      adSpend: adByDay.get(date) ?? {},
    };
  });
}

export interface PnlModel {
  currency: string;
  periods: { bucket: string; label: string; lines: PnlLines; compare: PnlLines | null }[];
  total: PnlLines;
  totalCompare: PnlLines | null;
  platforms: string[];
  missingCogsOrders: number;
}

export async function getPnl(a: {
  clientId: string;
  currency: string;
  range: DateRange;
  compareRange: DateRange | null;
  gran: Granularity;
}): Promise<PnlModel> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`client:${a.clientId}`, `costs:${a.clientId}`);
  const settings = await getCostSettings(a.clientId);
  const [cur, cmp, missing] = await Promise.all([
    dailyInputs(a.clientId, a.range),
    a.compareRange ? dailyInputs(a.clientId, a.compareRange) : null,
    prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(DISTINCT o.id)::int AS n FROM shopify_orders o JOIN shopify_order_lines l ON l."orderId" = o.id
       LEFT JOIN product_costs pc ON pc."clientId" = o."clientId" AND pc."productId" = l."productId" AND pc."variantId" = ''
       WHERE o."clientId" = $1 AND o.date BETWEEN $2::date AND $3::date AND l."unitCost" IS NULL AND pc.id IS NULL`,
      a.clientId,
      a.range.from,
      a.range.to,
    ),
  ]);
  const offset = a.compareRange ? Math.round((Date.parse(a.compareRange.from) - Date.parse(a.range.from)) / 86_400_000) : 0;
  const cmpByDay = new Map((cmp ?? []).map((d) => [d.date, d]));
  const buckets = bucketsInRange(a.range, a.gran);
  const periods = buckets.map((b) => {
    const days = cur.filter((d) => bucketStart(d.date, a.gran) === b);
    const cdays = days.map((d) => cmpByDay.get(addDays(d.date, offset))).filter((x): x is DayInput => !!x);
    return {
      bucket: b,
      label: bucketLabel(b, a.gran),
      lines: pnlForDays(days, settings),
      compare: cmp ? pnlForDays(cdays, settings) : null,
    };
  });
  const platforms = [...new Set(cur.flatMap((d) => Object.keys(d.adSpend)))].sort();
  return {
    currency: a.currency,
    periods,
    total: pnlForDays(cur, settings),
    totalCompare: cmp ? pnlForDays(cmp, settings) : null,
    platforms,
    missingCogsOrders: missing[0]?.n ?? 0,
  };
}

/** Products sold in the last 365 days with Shopify cost and manual override (P&L → Costs). */
export async function getProductCosts(clientId: string) {
  return prisma.$queryRawUnsafe<
    {
      productId: string;
      title: string;
      units: number;
      revenue: number;
      shopifyCost: number | null;
      override: number | null;
      avgPrice: number;
    }[]
  >(
    `SELECT l."productId" AS "productId", MAX(l.title) AS title, SUM(l.quantity)::float8 AS units, SUM(l.price * l.quantity)::float8 AS revenue,
            AVG(l."unitCost")::float8 AS "shopifyCost", MAX(pc."unitCost")::float8 AS override, AVG(l.price)::float8 AS "avgPrice"
     FROM shopify_order_lines l JOIN shopify_orders o ON o.id = l."orderId"
     LEFT JOIN product_costs pc ON pc."clientId" = o."clientId" AND pc."productId" = l."productId" AND pc."variantId" = ''
     WHERE o."clientId" = $1 AND o.date >= (now() - interval '365 days')::date AND l."productId" IS NOT NULL
     GROUP BY 1 ORDER BY revenue DESC LIMIT 500`,
    clientId,
  );
}
