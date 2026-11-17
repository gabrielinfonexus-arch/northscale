import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { canSeePage, DEFAULT_VIEWER_PAGES, SHARE_FORBIDDEN_PAGES } from "@/lib/permissions";
import type { Role } from "@/generated/prisma/enums";
import { newToken } from "./password";

export const SESSION_COOKIE = "ns_session";
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: Role;
  /** "share" = a public read-only link (no account) */
  kind: "user" | "share";
  /** Client Viewers: clientId → pages they may open. null for staff. */
  viewerPages: Record<string, string[]> | null;
  /** share links only */
  shareClientId?: string;
}

/**
 * Data Access Layer: the one place that turns the session cookie into a user.
 * Request-scoped (React cache), never stored in a shared cache. Redirects to /login when signed out.
 */
export const getOptionalUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const s = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: { include: { memberships: { orderBy: { createdAt: "asc" }, take: 1 }, clientAccess: true } },
      shareLink: { include: { client: { select: { organizationId: true, name: true } } } },
    },
  });
  const now = new Date();
  if (!s || s.expiresAt <= now) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > 10 * 60_000)
    await prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: now } }).catch(() => {});

  if (s.shareLink) {
    const l = s.shareLink;
    if (l.revokedAt || (l.expiresAt && l.expiresAt <= now)) return null;
    return {
      id: `share_${l.id}`,
      email: "",
      name: `Shared link · ${l.client.name}`,
      organizationId: l.client.organizationId,
      role: "CLIENT_VIEWER",
      kind: "share",
      viewerPages: { [l.clientId]: l.allowedPages.filter((p) => !SHARE_FORBIDDEN_PAGES.includes(p)) },
      shareClientId: l.clientId,
    };
  }
  const u = s.user;
  const m = u?.memberships[0];
  if (!u || !m || u.disabledAt) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    organizationId: m.organizationId,
    role: m.role,
    kind: "user",
    viewerPages:
      m.role === "CLIENT_VIEWER"
        ? Object.fromEntries(u.clientAccess.map((a) => [a.clientId, a.allowedPages.length ? a.allowedPages : DEFAULT_VIEWER_PAGES]))
        : null,
  };
});

export async function getCurrentUser(): Promise<SessionUser> {
  const u = await getOptionalUser();
  if (!u) redirect("/login");
  return u;
}

/** Start a session (after a password check, an accepted invite or a public link) and set the cookie. */
export async function createSession(a: { userId?: string; shareLinkId?: string; expiresAt?: Date }) {
  const token = newToken();
  const max = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const expiresAt = a.expiresAt && a.expiresAt < max ? a.expiresAt : max;
  const ua = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  await prisma.session.create({
    data: { tokenHash: hashToken(token), userId: a.userId, shareLinkId: a.shareLinkId, expiresAt, userAgent: ua },
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
}

/** Client ids this user may see. OWNER/ADMIN: all in the org; ANALYST/CLIENT_VIEWER: assigned only; share link: its client. */
export async function accessibleClientIds(user: SessionUser): Promise<string[]> {
  if (user.kind === "share") return clientIdsFor(user.organizationId, "share", user.role, user.shareClientId ?? "");
  return clientIdsFor(user.organizationId, user.id, user.role, "");
}

async function clientIdsFor(organizationId: string, userId: string, role: Role, shareClientId: string): Promise<string[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("clients", "users", `access:${userId}`);
  const settings = await prisma.orgSetting.findUnique({ where: { organizationId } });
  const showDemo = settings?.demoData ?? true;
  const base = { organizationId, archivedAt: null, ...(showDemo ? {} : { isDemo: false }) };
  if (userId === "share")
    return (await prisma.client.findMany({ where: { ...base, id: shareClientId }, select: { id: true } })).map((c) => c.id);
  if (role === "OWNER" || role === "ADMIN") return (await prisma.client.findMany({ where: base, select: { id: true } })).map((c) => c.id);
  const rows = await prisma.clientAccess.findMany({ where: { userId, client: base }, select: { clientId: true } });
  return rows.map((r) => r.clientId);
}

/** Throws unless the current user may see this client. Use in every server action / route handler. */
export async function assertClientAccess(clientId: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!(await accessibleClientIds(user)).includes(clientId)) throw new Error("Forbidden");
  return user;
}

/** Viewers (and public links) are read-only. */
export async function assertCanEdit(clientId: string): Promise<SessionUser> {
  const user = await assertClientAccess(clientId);
  if (user.role === "CLIENT_VIEWER") throw new Error("Forbidden");
  return user;
}

/** Owner / Admin only (clients, team, viewers, billing, org settings). */
export async function assertAdmin(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (user.role !== "OWNER" && user.role !== "ADMIN") throw new Error("Forbidden");
  return user;
}

/** Page guard for server components: redirects away when the user may not open this page (for this client). */
export async function requirePage(page: string, clientId?: string | null): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!canSeePage(user, page, clientId)) redirect(`/forbidden?page=${encodeURIComponent(page)}`);
  return user;
}
