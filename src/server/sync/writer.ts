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
