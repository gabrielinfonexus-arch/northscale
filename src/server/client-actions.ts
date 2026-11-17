"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertAdmin, assertCanEdit } from "./auth";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const tzOk = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const ClientInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes")
    .max(60)
    .optional()
    .or(z.literal("")),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "3-letter currency code (USD, BRL, EUR…)"),
  timezone: z.string().refine(tzOk, "Unknown timezone"),
  logoUrl: z.url().max(500).optional().or(z.literal("")),
  defaultMarginPct: z.number().min(0).max(100),
  paymentFeePct: z.number().min(0).max(20),
  shippingCostPerOrder: z.number().min(0).max(10_000),
  shippingCostPct: z.number().min(0).max(100),
  fixedCostsMonthly: z.number().min(0).max(100_000_000),
  newAudienceMinPct: z.number().min(0).max(100),
});
export type ClientInput = z.infer<typeof ClientInput>;

export const slugify = async (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);

function invalid(e: z.ZodError) {
  const i = e.issues[0];
  return `${i.path.join(".") || "Input"}: ${i.message}`;
}

function touched(clientId?: string) {
  updateTag("clients");
  if (clientId) updateTag(`client:${clientId}`);
}

/** Owner / Admin: create a client. The "Other revenue" source is created with it (manual / CSV / webhook). */
export async function createClient(input: ClientInput): Promise<Result<{ slug: string }>> {
  const user = await assertAdmin();
  const p = ClientInput.safeParse(input);
  if (!p.success) return { ok: false, error: invalid(p.error) };
  const d = p.data;
  const slug = d.slug || (await slugify(d.name)) || `client-${Date.now().toString(36)}`;
  if (await prisma.client.findUnique({ where: { slug } }))
    return { ok: false, error: `The slug "${slug}" is already used by another client.` };
  const c = await prisma.client.create({
    data: {
      organizationId: user.organizationId,
      name: d.name,
      slug,
      currency: d.currency,
      timezone: d.timezone,
      logoUrl: d.logoUrl || null,
      defaultMarginPct: d.defaultMarginPct,
      paymentFeePct: d.paymentFeePct,
      shippingCostPerOrder: d.shippingCostPerOrder,
      shippingCostPct: d.shippingCostPct,
      fixedCostsMonthly: d.fixedCostsMonthly,
      newAudienceMinPct: d.newAudienceMinPct,
      connections: {
        create: {
          platform: "OTHER_REVENUE",
          externalId: "other-revenue",
          name: "Other revenue (manual / CSV / webhook)",
          currency: d.currency,
          timezone: d.timezone,
        },
      },
    },
  });
  touched(c.id);
  return { ok: true, slug: c.slug };
}

export async function updateClient(clientId: string, input: ClientInput): Promise<Result<{ slug: string }>> {
  const user = await assertAdmin();
  const p = ClientInput.safeParse(input);
  if (!p.success) return { ok: false, error: invalid(p.error) };
  const d = p.data;
  const c = await prisma.client.findFirst({ where: { id: clientId, organizationId: user.organizationId } });
  if (!c) return { ok: false, error: "Client not found" };
  const slug = d.slug || c.slug;
  if (slug !== c.slug && (await prisma.client.findUnique({ where: { slug } })))
    return { ok: false, error: `The slug "${slug}" is already used.` };
  await prisma.client.update({
    where: { id: clientId },
    data: {
      name: d.name,
      slug,
      currency: d.currency,
      timezone: d.timezone,
      logoUrl: d.logoUrl || null,
      defaultMarginPct: d.defaultMarginPct,
      paymentFeePct: d.paymentFeePct,
      shippingCostPerOrder: d.shippingCostPerOrder,
      shippingCostPct: d.shippingCostPct,
      fixedCostsMonthly: d.fixedCostsMonthly,
      newAudienceMinPct: d.newAudienceMinPct,
    },
  });
  if (d.currency !== c.currency || d.timezone !== c.timezone) {
    // reporting currency / timezone feed the materialized views
    const { refreshReportingViews } = await import("./sync/writer");
    await refreshReportingViews();
  }
  touched(clientId);
  updateTag(`costs:${clientId}`);
  return { ok: true, slug };
}

/** Archive hides the client everywhere (data is kept); restore brings it back. */
export async function setClientArchived(clientId: string, archived: boolean): Promise<Result> {
  const user = await assertAdmin();
  const r = await prisma.client.updateMany({
    where: { id: clientId, organizationId: user.organizationId },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (!r.count) return { ok: false, error: "Client not found" };
  touched(clientId);
  return { ok: true };
}

/**
 * Disconnect an account: the stored token is deleted and syncs stop. Data already synced stays
 * (re-connecting the same account continues where it left off). Nothing is changed in the ad account.
 */
export async function disconnectConnection(connectionId: string): Promise<Result> {
  const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
  if (!conn) return { ok: false, error: "Connection not found" };
  await assertCanEdit(conn.clientId);
  await prisma.connection.update({
    where: { id: connectionId },
    data: { status: "DISCONNECTED", encryptedToken: null, encryptedRefresh: null, credentialId: null, nextSyncAt: null },
  });
  touched(conn.clientId);
  return { ok: true };
}
