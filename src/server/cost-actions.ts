"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertCanEdit } from "./auth";
import { recomputeCogs, refreshReportingViews } from "./sync/writer";

type Result = { ok: true } | { ok: false; error: string };
const money = z.number().finite().min(0).max(1e9);

function invalidate(clientId: string) {
  updateTag(`client:${clientId}`);
  updateTag(`costs:${clientId}`);
  updateTag("clients");
}

export async function saveCostSettings(
  clientId: string,
  input: { shippingCostPerOrder: number; shippingCostPct: number; paymentFeePct: number; defaultMarginPct: number },
): Promise<Result> {
  const d = z
    .object({
      shippingCostPerOrder: money,
      shippingCostPct: z.number().min(0).max(100),
      paymentFeePct: z.number().min(0).max(100),
      defaultMarginPct: z.number().min(0).max(100),
    })
    .safeParse(input);
  if (!d.success) return { ok: false, error: "Check the values (percentages between 0 and 100)." };
  await assertCanEdit(clientId);
  const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { defaultMarginPct: true } });
  await prisma.client.update({ where: { id: clientId }, data: d.data });
  if (before.defaultMarginPct !== d.data.defaultMarginPct) {
    await recomputeCogs(clientId);
    await refreshReportingViews();
  }
  invalidate(clientId);
  return { ok: true };
}

const Item = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  type: z.enum(["FIXED_MONTHLY", "VARIABLE_PER_ORDER", "VARIABLE_PCT_REVENUE"]),
  amount: money,
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(""))
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .or(z.literal(""))
    .optional(),
});

export async function saveCostItem(clientId: string, input: z.infer<typeof Item>): Promise<Result> {
  const d = Item.safeParse(input);
  if (!d.success) return { ok: false, error: "Name, type and a non-negative amount are required." };
  if (d.data.type === "VARIABLE_PCT_REVENUE" && d.data.amount > 100) return { ok: false, error: "A percentage must be ≤ 100." };
  await assertCanEdit(clientId);
  const data = {
    name: d.data.name,
    type: d.data.type,
    amount: d.data.amount,
    startDate: d.data.startDate ? new Date(d.data.startDate + "T00:00:00Z") : null,
    endDate: d.data.endDate ? new Date(d.data.endDate + "T00:00:00Z") : null,
  };
  if (d.data.id) {
    const existing = await prisma.costItem.findFirst({ where: { id: d.data.id, clientId } });
    if (!existing) return { ok: false, error: "Not found." };
    await prisma.costItem.update({ where: { id: d.data.id }, data });
  } else await prisma.costItem.create({ data: { ...data, clientId } });
  invalidate(clientId);
  return { ok: true };
}

export async function deleteCostItem(clientId: string, id: string): Promise<Result> {
  await assertCanEdit(clientId);
  await prisma.costItem.deleteMany({ where: { id, clientId } });
  invalidate(clientId);
  return { ok: true };
}

/** Manual unit cost per product (null clears the override). Recomputes stored COGS so every screen agrees. */
export async function saveProductCosts(
  clientId: string,
  rows: { productId: string; title: string; unitCost: number | null }[],
): Promise<Result> {
  const d = z
    .array(z.object({ productId: z.string().min(1).max(64), title: z.string().max(300), unitCost: money.nullable() }))
    .max(1000)
    .safeParse(rows);
  if (!d.success) return { ok: false, error: "Costs must be non-negative numbers." };
  await assertCanEdit(clientId);
  for (const r of d.data) {
    if (r.unitCost === null) await prisma.productCost.deleteMany({ where: { clientId, productId: r.productId, variantId: "" } });
    else
      await prisma.productCost.upsert({
        where: { clientId_productId_variantId: { clientId, productId: r.productId, variantId: "" } },
        create: { clientId, productId: r.productId, variantId: "", title: r.title, unitCost: r.unitCost },
        update: { unitCost: r.unitCost, title: r.title },
      });
  }
  if (d.data.length) {
    await recomputeCogs(clientId, { productIds: d.data.map((r) => r.productId) });
    await refreshReportingViews();
  }
  invalidate(clientId);
  return { ok: true };
}
