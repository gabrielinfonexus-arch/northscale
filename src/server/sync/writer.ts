import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Shared, platform-agnostic writes. Every connector produces normalized rows and calls these,
 * so all platforms land in the same tables in the same format.
 * Each replace* call is idempotent for its range: re-syncing a window never duplicates rows.
 */
const BATCH = 2_000;
const asDate = (d: string) => new Date(d + "T00:00:00Z");

export type DailyRow = Omit<Prisma.AdInsightDailyCreateManyInput, "id">;
export type BreakdownRow = Omit<Prisma.AdInsightBreakdownCreateManyInput, "id">;

export async function replaceDaily(
  connectionId: string,
  range: { from: string; to: string },
  scope: { levels: string[]; attributions: string[] },
  rows: DailyRow[],
): Promise<number> {
  await prisma.$transaction(
    async (tx) => {
      await tx.adInsightDaily.deleteMany({
        where: {
          connectionId,
          date: { gte: asDate(range.from), lte: asDate(range.to) },
          level: { in: scope.levels as never[] },
          attribution: { in: scope.attributions },
        },
      });
      for (let i = 0; i < rows.length; i += BATCH)
        await tx.adInsightDaily.createMany({ data: rows.slice(i, i + BATCH), skipDuplicates: true });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  return rows.length;
}

export async function replaceBreakdowns(
  connectionId: string,
  range: { from: string; to: string },
  types: string[],
  rows: BreakdownRow[],
): Promise<number> {
  await prisma.$transaction(
    async (tx) => {
      await tx.adInsightBreakdown.deleteMany({
        where: { connectionId, date: { gte: asDate(range.from), lte: asDate(range.to) }, breakdownType: { in: types as never[] } },
      });
      for (let i = 0; i < rows.length; i += BATCH)
        await tx.adInsightBreakdown.createMany({ data: rows.slice(i, i + BATCH), skipDuplicates: true });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  return rows.length;
}

export type EntityRow = Omit<Prisma.AdEntityCreateManyInput, "id" | "updatedAt">;

export async function upsertEntities(rows: EntityRow[]): Promise<number> {
  for (const r of rows) {
    await prisma.adEntity.upsert({
      where: { connectionId_level_externalId: { connectionId: r.connectionId, level: r.level, externalId: r.externalId } },
      create: r,
      update: { ...r, landingUrl: r.landingUrl ?? undefined, creativeId: r.creativeId ?? undefined },
    });
  }
  return rows.length;
}

export type CreativeRow = Omit<Prisma.CreativeCreateManyInput, "id" | "updatedAt">;

export async function upsertCreatives(rows: CreativeRow[]): Promise<number> {
  for (const r of rows) {
    await prisma.creative.upsert({
      where: { connectionId_adExternalId: { connectionId: r.connectionId, adExternalId: r.adExternalId } },
      create: r,
      update: r,
    });
  }
  return rows.length;
}

/** Refresh the reporting materialized views (all clients). Called once per finished job. */
export async function refreshReportingViews() {
  await prisma.$executeRawUnsafe("SELECT refresh_reporting_views()");
}

export interface OrderWrite {
  order: Omit<Prisma.ShopifyOrderCreateManyInput, "id" | "clientId" | "connectionId" | "updatedAt" | "date"> & { date: string };
  lines: Omit<Prisma.ShopifyOrderLineCreateManyInput, "id" | "orderId">[];
  refunds: { externalId: string; date: string; amount: number }[];
}

/**
 * Upsert orders by (connection, externalId): previous versions (and their lines/refunds) are replaced.
 * Refunds are stored on their own date so they hit the day they happened.
 */
export async function upsertOrders(connectionId: string, clientId: string, currency: string, orders: OrderWrite[]): Promise<number> {
  if (!orders.length) return 0;
  const { randomUUID } = await import("node:crypto");
  await prisma.$transaction(
    async (tx) => {
      await tx.shopifyOrder.deleteMany({ where: { connectionId, externalId: { in: orders.map((o) => o.order.externalId) } } });
      const rows = orders.map((o) => ({ id: randomUUID(), ...o }));
      await tx.shopifyOrder.createMany({
        data: rows.map((r) => ({ ...r.order, id: r.id, clientId, connectionId, date: asDate(r.order.date) })),
      });
      const lines = rows.flatMap((r) => r.lines.map((l) => ({ ...l, orderId: r.id })));
      for (let i = 0; i < lines.length; i += BATCH) await tx.shopifyOrderLine.createMany({ data: lines.slice(i, i + BATCH) });
      const refunds = rows.flatMap((r) =>
        r.refunds.map((x) => ({ orderId: r.id, clientId, externalId: x.externalId, date: asDate(x.date), amount: x.amount, currency })),
      );
      if (refunds.length) await tx.shopifyRefund.createMany({ data: refunds, skipDuplicates: true });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  // keep manual COGS overrides applied after every (re)sync
  if (await prisma.productCost.count({ where: { clientId } })) {
    const ids = await prisma.shopifyOrder.findMany({
      where: { connectionId, externalId: { in: orders.map((o) => o.order.externalId) } },
      select: { id: true },
    });
    await recomputeCogs(clientId, { orderIds: ids.map((i) => i.id) });
  }
  return orders.length;
}

let lastRefresh = 0;
/** For webhooks: refresh the views at most once a minute (the hourly sync catches up the rest). */
export async function refreshReportingViewsThrottled(minIntervalMs = 60_000): Promise<boolean> {
  if (Date.now() - lastRefresh < minIntervalMs) return false;
  lastRefresh = Date.now();
  await refreshReportingViews();
  return true;
}

/**
 * Recompute stored order COGS for a client: manual override (P&L → Costs) > Shopify unit cost > default margin.
 * Scope to orders containing given products, or given orders; omit both to recompute every order.
 */
export async function recomputeCogs(clientId: string, scope: { productIds?: string[]; orderIds?: string[] } = {}) {
  const filter = scope.productIds
    ? `AND l."orderId" IN (SELECT "orderId" FROM shopify_order_lines WHERE "productId" = ANY($2::text[]))`
    : scope.orderIds
      ? `AND l."orderId" = ANY($2::text[])`
      : "";
  return prisma.$executeRawUnsafe(
    `UPDATE shopify_orders o SET cogs = x.c
     FROM (
       SELECT l."orderId", SUM(COALESCE(pc."unitCost", l."unitCost", l.price * (1 - cl."defaultMarginPct" / 100.0)) * l.quantity) AS c
       FROM shopify_order_lines l
       JOIN shopify_orders o2 ON o2.id = l."orderId"
       JOIN clients cl ON cl.id = o2."clientId"
       LEFT JOIN product_costs pc ON pc."clientId" = o2."clientId" AND pc."productId" = l."productId" AND pc."variantId" = ''
       WHERE o2."clientId" = $1 ${filter}
       GROUP BY l."orderId"
     ) x
     WHERE o.id = x."orderId"`,
    clientId,
    ...(scope.productIds ? [scope.productIds] : scope.orderIds ? [scope.orderIds] : []),
  );
}
