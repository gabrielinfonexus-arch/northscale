"use server";
import { headers } from "next/headers";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { DEFAULT_VIEWER_PAGES, VIEWER_PAGES } from "@/lib/permissions";
import type { Role } from "@/generated/prisma/enums";
import { assertAdmin, type SessionUser } from "./auth";
import { newToken } from "./password";
import { absoluteUrl, sendEmail } from "./email";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const INVITE_DAYS = 7;
const ROLE_LABEL: Record<Role, string> = { OWNER: "Owner", ADMIN: "Admin", ANALYST: "Analyst", CLIENT_VIEWER: "Client viewer" };
const email = z.email().transform((e) => e.trim().toLowerCase());
const pages = z.array(z.enum(VIEWER_PAGES.map((p) => p.id) as [string, ...string[]])).max(VIEWER_PAGES.length);

/** Owners manage everyone; Admins manage Analysts and Client Viewers. */
function canManage(actor: SessionUser, role: Role) {
  if (actor.role === "OWNER") return true;
  return actor.role === "ADMIN" && (role === "ANALYST" || role === "CLIENT_VIEWER");
}

async function orgClientIds(orgId: string, ids: string[]) {
  const rows = await prisma.client.findMany({ where: { organizationId: orgId, id: { in: ids } }, select: { id: true } });
  return rows.map((r) => r.id);
}

function touched(userId?: string) {
  updateTag("users");
  updateTag("clients");
  if (userId) updateTag(`access:${userId}`);
}

/** Create a one-time invitation link (and email it when Resend is configured). The link is returned once. */
async function issueInvite(actor: SessionUser, a: { email: string; role: Role; clientIds: string[]; allowedPages: string[] }) {
  const token = newToken();
  await prisma.authToken.updateMany({
    where: { email: a.email, kind: "invite", usedAt: null, organizationId: actor.organizationId },
    data: { usedAt: new Date() },
  }); // one live invite per email
  await prisma.authToken.create({
    data: {
      kind: "invite",
      tokenHash: hashToken(token),
      email: a.email,
      organizationId: actor.organizationId,
      role: a.role,
      clientIds: a.clientIds,
      allowedPages: a.allowedPages,
      createdById: actor.id,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    },
  });
  const url = absoluteUrl(`/invite/${token}`, (await headers()).get("origin"));
  const sent = await sendEmail(
    a.email,
    "You're invited to NorthScale",
    `${actor.name || actor.email} invited you to NorthScale as ${ROLE_LABEL[a.role]}.\n\nOpen this link within ${INVITE_DAYS} days to choose your password:\n${url}`,
  );
  return { url, emailed: sent === true, emailError: sent === true ? null : sent };
}

const TeamInvite = z.object({ email, role: z.enum(["ADMIN", "ANALYST", "OWNER"]), clientIds: z.array(z.string()).max(500) });

export async function inviteTeamMember(
  input: z.input<typeof TeamInvite>,
): Promise<Result<{ url: string; emailed: boolean; emailError: string | null }>> {
  const actor = await assertAdmin();
  const p = TeamInvite.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the email and role." };
  if (!canManage(actor, p.data.role)) return { ok: false, error: "Only the Owner can invite Owners and Admins." };
  const existing = await prisma.user.findUnique({ where: { email: p.data.email }, include: { memberships: true } });
  if (existing?.memberships.length && existing.passwordHash)
    return { ok: false, error: "This person already has an account. Change their role in the list instead." };
  const clientIds = p.data.role === "ANALYST" ? await orgClientIds(actor.organizationId, p.data.clientIds) : [];
  return { ok: true, ...(await issueInvite(actor, { email: p.data.email, role: p.data.role, clientIds, allowedPages: [] })) };
}

export async function revokeInvite(id: string): Promise<Result> {
  const actor = await assertAdmin();
  await prisma.authToken.updateMany({
    where: { id, organizationId: actor.organizationId, kind: "invite", usedAt: null },
    data: { usedAt: new Date(), expiresAt: new Date() },
  });
  return { ok: true };
}

async function memberOf(actor: SessionUser, userId: string) {
  const m = await prisma.membership.findFirst({ where: { userId, organizationId: actor.organizationId }, include: { user: true } });
  if (!m) throw new Error("Member not found");
  return m;
}

export async function updateMember(userId: string, input: { role: Role; clientIds: string[] }): Promise<Result> {
  const actor = await assertAdmin();
  const m = await memberOf(actor, userId);
  const role = z.enum(["OWNER", "ADMIN", "ANALYST", "CLIENT_VIEWER"]).parse(input.role);
  if (userId === actor.id && role !== m.role) return { ok: false, error: "You can't change your own role." };
  if (!canManage(actor, m.role) || !canManage(actor, role)) return { ok: false, error: "Only the Owner can change Owners and Admins." };
  if (
    m.role === "OWNER" &&
    role !== "OWNER" &&
    (await prisma.membership.count({ where: { organizationId: actor.organizationId, role: "OWNER" } })) < 2
  )
    return { ok: false, error: "There must be at least one Owner." };
  const clientIds = await orgClientIds(actor.organizationId, input.clientIds);
  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: m.id }, data: { role } });
    if (role === "ANALYST") {
      await tx.clientAccess.deleteMany({ where: { userId, clientId: { notIn: clientIds } } });
      for (const clientId of clientIds)
        await tx.clientAccess.upsert({ where: { userId_clientId: { userId, clientId } }, update: {}, create: { userId, clientId } });
    } else if (role === "OWNER" || role === "ADMIN") await tx.clientAccess.deleteMany({ where: { userId } }); // they see everything
  });
  touched(userId);
  return { ok: true };
}

/** Disable signs the person out everywhere and blocks sign-in; enable restores it. */
export async function setMemberDisabled(userId: string, disabled: boolean): Promise<Result> {
  const actor = await assertAdmin();
  const m = await memberOf(actor, userId);
  if (userId === actor.id) return { ok: false, error: "You can't disable yourself." };
  if (!canManage(actor, m.role)) return { ok: false, error: "Only the Owner can disable Owners and Admins." };
  await prisma.user.update({ where: { id: userId }, data: { disabledAt: disabled ? new Date() : null } });
  if (disabled) await prisma.session.deleteMany({ where: { userId } });
  touched(userId);
  return { ok: true };
}

/** For people without email delivery: a one-time reset link the admin can send them. */
export async function createResetLink(userId: string): Promise<Result<{ url: string }>> {
  const actor = await assertAdmin();
  const m = await memberOf(actor, userId);
  if (!canManage(actor, m.role) && userId !== actor.id) return { ok: false, error: "Only the Owner can reset Owners and Admins." };
  const token = newToken();
  await prisma.authToken.create({
    data: {
      kind: "reset",
      tokenHash: hashToken(token),
      email: m.user.email,
      organizationId: actor.organizationId,
      createdById: actor.id,
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    },
  });
  return { ok: true, url: absoluteUrl(`/reset/${token}`, (await headers()).get("origin")) };
}

// ───────────────────────── Client Viewers ─────────────────────────

const ViewerInvite = z.object({ clientId: z.string(), email, pages });

/** Invite a client's contact as a read-only viewer of that client (or add access if they already have an account). */
export async function inviteViewer(
  input: z.input<typeof ViewerInvite>,
): Promise<Result<{ url: string | null; emailed: boolean; emailError: string | null; added: boolean }>> {
  const actor = await assertAdmin();
  const p = ViewerInvite.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the email and pages." };
  const [clientId] = await orgClientIds(actor.organizationId, [p.data.clientId]);
  if (!clientId) return { ok: false, error: "Client not found" };
  const allowedPages = p.data.pages.length ? p.data.pages : DEFAULT_VIEWER_PAGES;
  const existing = await prisma.user.findUnique({ where: { email: p.data.email }, include: { memberships: true } });
  const m = existing?.memberships.find((x) => x.organizationId === actor.organizationId);
  if (m && m.role !== "CLIENT_VIEWER") return { ok: false, error: "This person is a team member and already sees this client." };
  if (existing && m && existing.passwordHash) {
    await prisma.clientAccess.upsert({
      where: { userId_clientId: { userId: existing.id, clientId } },
      update: { allowedPages },
      create: { userId: existing.id, clientId, allowedPages },
    });
    touched(existing.id);
    return { ok: true, url: null, emailed: false, emailError: null, added: true };
  }
  return {
    ok: true,
    added: false,
    ...(await issueInvite(actor, { email: p.data.email, role: "CLIENT_VIEWER", clientIds: [clientId], allowedPages })),
  };
}

export async function updateViewerPages(userId: string, clientId: string, allowed: string[]): Promise<Result> {
  const actor = await assertAdmin();
  await memberOf(actor, userId);
  const list = pages.parse(allowed);
  if (!list.length) return { ok: false, error: "Choose at least one page." };
  await prisma.clientAccess.update({ where: { userId_clientId: { userId, clientId } }, data: { allowedPages: list } });
  touched(userId);
  return { ok: true };
}

export async function removeViewerAccess(userId: string, clientId: string): Promise<Result> {
  const actor = await assertAdmin();
  const m = await memberOf(actor, userId);
  if (m.role !== "CLIENT_VIEWER") return { ok: false, error: "Not a client viewer." };
  await prisma.clientAccess.deleteMany({ where: { userId, clientId } });
  touched(userId);
  return { ok: true };
}

const ShareInput = z.object({
  clientId: z.string(),
  label: z.string().trim().max(80).optional(),
  pages,
  days: z.number().int().min(1).max(365),
});

/** Public read-only link with an expiry. Only its hash is stored; the link is shown once. */
export async function createShareLink(input: z.input<typeof ShareInput>): Promise<Result<{ url: string }>> {
  const actor = await assertAdmin();
  const p = ShareInput.safeParse(input);
  if (!p.success) return { ok: false, error: "Check the pages and expiry." };
  const [clientId] = await orgClientIds(actor.organizationId, [p.data.clientId]);
  if (!clientId) return { ok: false, error: "Client not found" };
  const allowed = p.data.pages.filter((x) => x !== "hive-mind");
  if (!allowed.length) return { ok: false, error: "Choose at least one page." };
  const token = newToken();
  await prisma.shareLink.create({
    data: {
      clientId,
      tokenHash: hashToken(token),
      label: p.data.label || null,
      allowedPages: allowed,
      expiresAt: new Date(Date.now() + p.data.days * 86_400_000),
      createdById: actor.id,
    },
  });
  return { ok: true, url: absoluteUrl(`/share/${token}`, (await headers()).get("origin")) };
}

export async function revokeShareLink(id: string): Promise<Result> {
  const actor = await assertAdmin();
  const link = await prisma.shareLink.findFirst({ where: { id, client: { organizationId: actor.organizationId } } });
  if (!link) return { ok: false, error: "Link not found" };
  await prisma.$transaction([
    prisma.shareLink.update({ where: { id }, data: { revokedAt: new Date() } }),
    prisma.session.deleteMany({ where: { shareLinkId: id } }),
  ]);
  return { ok: true };
}
