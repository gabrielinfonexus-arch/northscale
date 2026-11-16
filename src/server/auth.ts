import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";
import type { Role } from "@/generated/prisma/enums";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: Role;
}

/**
 * Phase 1: no login yet — resolves to the seeded Owner.
 * Phase 8 replaces the body with the real session (Supabase Auth), keeping this signature,
 * so every query and AI tool that already calls getCurrentUser()/accessibleClientIds() stays correct.
 */
export async function getCurrentUser(): Promise<SessionUser> {
  "use cache";
  cacheLife("minutes");
  cacheTag("users");
  const m = await prisma.membership.findFirst({ where: { role: "OWNER" }, include: { user: true }, orderBy: { createdAt: "asc" } });
  if (!m) throw new Error("No owner found. Run `npm run db:seed` first.");
  return { id: m.user.id, email: m.user.email, name: m.user.name, organizationId: m.organizationId, role: m.role };
}

/** Client ids this user may see. OWNER/ADMIN: all in the org; ANALYST/CLIENT_VIEWER: assigned only. */
export async function accessibleClientIds(user: SessionUser): Promise<string[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("clients", "users");
  const settings = await prisma.orgSetting.findUnique({ where: { organizationId: user.organizationId } });
  const showDemo = settings?.demoData ?? true;
  const base = { organizationId: user.organizationId, archivedAt: null, ...(showDemo ? {} : { isDemo: false }) };
  if (user.role === "OWNER" || user.role === "ADMIN") {
    return (await prisma.client.findMany({ where: base, select: { id: true } })).map((c) => c.id);
  }
  const rows = await prisma.clientAccess.findMany({ where: { userId: user.id, client: base }, select: { clientId: true } });
  return rows.map((r) => r.clientId);
}
