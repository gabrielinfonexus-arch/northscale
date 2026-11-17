import "server-only";
import { prisma } from "@/lib/db";
import { startOfMonth, todayInTz } from "@/lib/periods";
import { DEFAULT_VIEWER_PAGES } from "@/lib/permissions";
import { assertAdmin } from "./auth";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Clients page: every client of the organization (archived too) with an onboarding checklist. */
export async function listClientsAdmin() {
  const user = await assertAdmin();
  const rows = await prisma.client.findMany({
    where: { organizationId: user.organizationId },
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    include: {
      connections: { select: { id: true, platform: true, status: true, name: true } },
      _count: { select: { access: true } },
    },
  });
  const months = new Map(rows.map((c) => [c.id, startOfMonth(todayInTz(c.timezone))]));
  const targets = await prisma.target.findMany({
    where: { clientId: { in: rows.map((r) => r.id) }, month: { in: [...new Set(months.values())].map((m) => new Date(m + "T00:00:00Z")) } },
    select: { clientId: true, month: true },
  });
  return rows.map((c) => {
    const live = c.connections.filter((x) => x.status !== "DISCONNECTED");
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      currency: c.currency,
      timezone: c.timezone,
      isDemo: c.isDemo,
      archived: !!c.archivedAt,
      counts: {
        META: live.filter((x) => x.platform === "META").length,
        GOOGLE: live.filter((x) => x.platform === "GOOGLE").length,
        SHOPIFY: live.filter((x) => x.platform === "SHOPIFY").length,
      },
      problems: live.filter((x) => x.status === "ERROR" || x.status === "TOKEN_EXPIRED").length,
      checklist: {
        ads: live.some((x) => x.platform === "META" || x.platform === "GOOGLE"),
        store: live.some((x) => x.platform === "SHOPIFY"),
        targets: targets.some((t) => t.clientId === c.id && t.month.toISOString().slice(0, 10) === months.get(c.id)),
        viewers: c._count.access > 0,
      },
    };
  });
}

export async function getClientAdmin(slug: string) {
  const user = await assertAdmin();
  const c = await prisma.client.findFirst({
    where: { slug, organizationId: user.organizationId },
    include: {
      connections: {
        orderBy: [{ platform: "asc" }, { name: "asc" }],
        select: { id: true, platform: true, name: true, externalId: true, status: true, lastSuccessAt: true, isDemo: true },
      },
    },
  });
  if (!c) return null;
  const list = await listClientsAdmin();
  return {
    client: {
      id: c.id,
      slug: c.slug,
      name: c.name,
      currency: c.currency,
      timezone: c.timezone,
      logoUrl: c.logoUrl ?? "",
      defaultMarginPct: c.defaultMarginPct,
      paymentFeePct: c.paymentFeePct,
      shippingCostPerOrder: c.shippingCostPerOrder,
      shippingCostPct: c.shippingCostPct,
      fixedCostsMonthly: c.fixedCostsMonthly,
      newAudienceMinPct: c.newAudienceMinPct,
      archived: !!c.archivedAt,
      isDemo: c.isDemo,
    },
    connections: c.connections.map((x) => ({ ...x, lastSuccessAt: iso(x.lastSuccessAt) })),
    checklist: list.find((x) => x.id === c.id)!.checklist,
  };
}

/** Team Members page: staff (Owner/Admin/Analyst) and their pending invitations. */
export async function listTeam() {
  const user = await assertAdmin();
  const [members, invites, clients] = await Promise.all([
    prisma.membership.findMany({
      where: { organizationId: user.organizationId, role: { not: "CLIENT_VIEWER" } },
      orderBy: { createdAt: "asc" },
      include: { user: { include: { clientAccess: { select: { clientId: true } } } } },
    }),
    prisma.authToken.findMany({
      where: {
        organizationId: user.organizationId,
        kind: "invite",
        usedAt: null,
        expiresAt: { gt: new Date() },
        role: { not: "CLIENT_VIEWER" },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.client.findMany({
      where: { organizationId: user.organizationId, archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return {
    me: { id: user.id, role: user.role },
    clients,
    members: members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      clientIds: m.user.clientAccess.map((a) => a.clientId),
      disabled: !!m.user.disabledAt,
      hasPassword: !!m.user.passwordHash,
      lastLoginAt: iso(m.user.lastLoginAt),
    })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: iso(i.expiresAt)!, clientIds: i.clientIds })),
  };
}

/** Client Viewers page for one client: viewers, pending viewer invitations and public links. */
export async function listViewers(clientId: string) {
  const user = await assertAdmin();
  const client = await prisma.client.findFirst({ where: { id: clientId, organizationId: user.organizationId }, select: { id: true } });
  if (!client) return null;
  const [access, invites, links] = await Promise.all([
    prisma.clientAccess.findMany({
      where: { clientId, user: { memberships: { some: { organizationId: user.organizationId, role: "CLIENT_VIEWER" } } } },
      include: { user: true },
      orderBy: { user: { email: "asc" } },
    }),
    prisma.authToken.findMany({
      where: {
        organizationId: user.organizationId,
        kind: "invite",
        usedAt: null,
        expiresAt: { gt: new Date() },
        role: "CLIENT_VIEWER",
        clientIds: { has: clientId },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.shareLink.findMany({ where: { clientId, revokedAt: null }, orderBy: { createdAt: "desc" } }),
  ]);
  const now = Date.now();
  return {
    viewers: access.map((a) => ({
      userId: a.userId,
      email: a.user.email,
      name: a.user.name,
      pages: a.allowedPages.length ? a.allowedPages : DEFAULT_VIEWER_PAGES,
      disabled: !!a.user.disabledAt,
      lastLoginAt: iso(a.user.lastLoginAt),
    })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, pages: i.allowedPages, expiresAt: iso(i.expiresAt)! })),
    links: links
      .filter((l) => !l.expiresAt || l.expiresAt.getTime() > now)
      .map((l) => ({
        id: l.id,
        label: l.label,
        pages: l.allowedPages,
        expiresAt: iso(l.expiresAt),
        lastUsedAt: iso(l.lastUsedAt),
        createdAt: iso(l.createdAt)!,
      })),
  };
}
