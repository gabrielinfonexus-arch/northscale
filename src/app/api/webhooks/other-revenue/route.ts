import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { writeOtherRevenue } from "@/server/other-revenue";

/**
 * Generic Other Revenue webhook (Stripe, Amazon, TikTok Shop, Hotmart… or Zapier/Make in between).
 *   POST /api/webhooks/other-revenue
 *   Authorization: Bearer nsk_…   (per-client key, Other Revenue page → Webhook)
 *   { "date": "2026-11-15", "source": "Hotmart", "revenue": 1234.5, "orders": 7, "currency": "BRL" }   (or an array of those)
 * Same (date, source) replaces the previous value, so senders can push daily totals idempotently.
 */
const Row = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().trim().min(1).max(80),
  revenue: z.coerce.number().finite(),
  orders: z.coerce.number().int().min(0).default(0),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : (req.headers.get("x-api-key") ?? "").trim();
  if (!key.startsWith("nsk_")) return NextResponse.json({ error: "Missing API key" }, { status: 401 });
  const client = await prisma.client.findFirst({ where: { webhookKeyHash: hashToken(key) }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = z.union([Row, z.array(Row).min(1).max(5_000)]).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", issues: parsed.error.issues.slice(0, 5) }, { status: 422 });
  const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const saved = await writeOtherRevenue(client.id, rows);
  return NextResponse.json({ ok: true, saved });
}
