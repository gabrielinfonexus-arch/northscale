"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCanEdit } from "./auth";

const num = z.number().finite().nonnegative().nullable().optional();
const Values = z.object({ spend: num, revenue: num, mer: num, roas: num, cpa: num, ncac: num, orders: num, newCustomers: num });
const Input = z.object({
  clientId: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}-01$/),
  CLIENT: Values,
  META: Values,
  GOOGLE: Values,
});
export type SaveTargetsInput = z.infer<typeof Input>;

export async function saveTargets(input: SaveTargetsInput) {
  const d = Input.parse(input);
  await assertCanEdit(d.clientId);
  const month = new Date(d.month + "T00:00:00Z");
  for (const scope of ["CLIENT", "META", "GOOGLE"] as const) {
    const platform = scope === "CLIENT" ? null : scope;
    const v = d[scope];
    const data = {
      spend: v.spend ?? null,
      revenue: scope === "CLIENT" ? (v.revenue ?? null) : null,
      mer: scope === "CLIENT" ? (v.mer ?? null) : null,
      ncac: scope === "CLIENT" ? (v.ncac ?? null) : null,
      orders: scope === "CLIENT" ? (v.orders ?? null) : null,
      newCustomers: scope === "CLIENT" ? (v.newCustomers ?? null) : null,
      roas: scope !== "CLIENT" ? (v.roas ?? null) : null,
      cpa: scope !== "CLIENT" ? (v.cpa ?? null) : null,
    };
    // NULL platform/connection can't be matched by a compound-unique upsert, so find first.
    const existing = await prisma.target.findFirst({ where: { clientId: d.clientId, month, platform, connectionId: null } });
    const empty = Object.values(data).every((x) => x === null);
    if (existing && empty) await prisma.target.delete({ where: { id: existing.id } });
    else if (existing) await prisma.target.update({ where: { id: existing.id }, data });
    else if (!empty) await prisma.target.create({ data: { clientId: d.clientId, month, platform, connectionId: null, ...data } });
  }
  updateTag(`targets:${d.clientId}`);
  updateTag(`client:${d.clientId}`);
}

const Breakeven = z.object({
  clientId: z.string().min(1),
  aov: z.number().finite().positive().nullable(),
  marginPct: z.number().finite().min(0).max(100).nullable(),
  fixedCosts: z.number().finite().nonnegative(),
  multiplier: z.number().finite().min(1).max(5),
});

export async function saveBreakevenSettings(input: z.infer<typeof Breakeven>) {
  const d = Breakeven.parse(input);
  await assertCanEdit(d.clientId);
  await prisma.client.update({
    where: { id: d.clientId },
    data: { breakevenAov: d.aov, breakevenMarginPct: d.marginPct, fixedCostsMonthly: d.fixedCosts, profitMultiplier: d.multiplier },
  });
  updateTag("clients");
  updateTag(`targets:${d.clientId}`);
}
