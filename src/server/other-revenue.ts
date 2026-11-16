import "server-only";
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/db";
import type { OtherRevenueRow } from "@/lib/other-revenue-csv";
import { refreshReportingViews } from "./sync/writer";

/** The client's "Other revenue" connection (created on first use) — keeps every source in the same model. */
export async function otherRevenueConnection(clientId: string) {
  const existing = await prisma.connection.findFirst({ where: { clientId, platform: "OTHER_REVENUE" } });
  if (existing) return existing;
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  return prisma.connection.create({
    data: {
      clientId,
      platform: "OTHER_REVENUE",
      externalId: "manual",
      name: "Other revenue (manual / CSV / webhook)",
      currency: client.currency,
      timezone: client.timezone,
      status: "OK",
    },
  });
}

/** Upsert by (client, date, source): re-importing the same day replaces it. */
export async function writeOtherRevenue(clientId: string, rows: OtherRevenueRow[]): Promise<number> {
  if (!rows.length) return 0;
  const conn = await otherRevenueConnection(clientId);
  for (const r of rows) {
    const date = new Date(r.date + "T00:00:00Z");
    await prisma.otherRevenue.upsert({
      where: { clientId_date_source: { clientId, date, source: r.source } },
      create: {
        clientId,
        connectionId: conn.id,
        date,
        source: r.source,
        revenue: r.revenue,
        orders: r.orders,
        currency: r.currency ?? conn.currency,
      },
      update: { revenue: r.revenue, orders: r.orders, currency: r.currency ?? conn.currency },
    });
  }
  await prisma.connection.update({ where: { id: conn.id }, data: { lastSuccessAt: new Date(), lastSyncAt: new Date(), status: "OK" } });
  await refreshReportingViews();
  revalidateTag(`client:${clientId}`, "max");
  return rows.length;
}

export async function listOtherRevenue(clientId: string, from: string, to: string) {
  const rows = await prisma.otherRevenue.findMany({
    where: { clientId, date: { gte: new Date(from + "T00:00:00Z"), lte: new Date(to + "T00:00:00Z") } },
    orderBy: [{ date: "desc" }, { source: "asc" }],
  });
  const sources = await prisma.otherRevenue.findMany({ where: { clientId }, distinct: ["source"], select: { source: true } });
  return {
    rows: rows.map((r) => ({
      id: r.id,
      date: r.date.toISOString().slice(0, 10),
      source: r.source,
      revenue: r.revenue,
      orders: r.orders,
      currency: r.currency,
    })),
    sources: sources.map((s) => s.source).sort(),
  };
}
