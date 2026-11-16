"use server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { assertCanEdit } from "./auth";
import { writeOtherRevenue } from "./other-revenue";
import { refreshReportingViews } from "./sync/writer";
import { revalidateTag } from "next/cache";

const Row = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().trim().min(1).max(80),
  revenue: z.number().finite(),
  orders: z.number().int().min(0).max(1_000_000),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export async function saveOtherRevenue(clientId: string, rows: z.infer<typeof Row>[]): Promise<Result<{ saved: number }>> {
  const parsed = z.array(Row).min(1).max(20_000).safeParse(rows);
  if (!parsed.success) return { ok: false, error: "Some rows are invalid (date, source and revenue are required)." };
  await assertCanEdit(clientId);
  return { ok: true, saved: await writeOtherRevenue(clientId, parsed.data) };
}

export async function deleteOtherRevenue(id: string): Promise<Result> {
  const row = await prisma.otherRevenue.findUnique({ where: { id } });
  if (!row) return { ok: true };
  await assertCanEdit(row.clientId);
  await prisma.otherRevenue.delete({ where: { id } });
  await refreshReportingViews();
  revalidateTag(`client:${row.clientId}`, "max");
  return { ok: true };
}

/** New API key for the generic webhook. Only its hash is stored; the key is shown once. */
export async function rotateWebhookKey(clientId: string): Promise<Result<{ key: string }>> {
  await assertCanEdit(clientId);
  const key = `nsk_${randomBytes(24).toString("base64url")}`;
  await prisma.client.update({ where: { id: clientId }, data: { webhookKeyHash: hashToken(key) } });
  return { ok: true, key };
}
