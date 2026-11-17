import "server-only";
import { timingSafeEqual, createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "./password";

/**
 * Owner sign-in from the server environment (OWNER_EMAIL + OWNER_PASSWORD).
 * When someone signs in with exactly those two values, the Owner account is created or repaired
 * (that email, Owner role, enabled, that password) — no build step or database access needed.
 * To turn it off after the first sign-in, remove OWNER_PASSWORD from the environment.
 */
export function matchesOwnerEnv(email: string, password: string): boolean {
  const envEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const envPw = process.env.OWNER_PASSWORD;
  if (!envEmail || !envPw) return false;
  const h = (s: string) => createHash("sha256").update(s).digest(); // equal length for a constant-time compare
  return email === envEmail && timingSafeEqual(h(password), h(envPw));
}

export async function ensureOwnerFromEnv(email: string, password: string) {
  let org = await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } });
  if (!org) {
    org = await prisma.organization.create({ data: { name: "NorthScale" } });
    await prisma.orgSetting.create({ data: { organizationId: org.id, demoData: true } });
  }
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // rename the seeded placeholder Owner if it's still there, otherwise create the account
    const placeholder = await prisma.user.findUnique({ where: { email: "owner@northscale.local" } });
    user = placeholder
      ? await prisma.user.update({ where: { id: placeholder.id }, data: { email } })
      : await prisma.user.create({ data: { email, name: "Owner" } });
  }
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
    update: { role: "OWNER" },
    create: { userId: user.id, organizationId: org.id, role: "OWNER" },
  });
  const needsHash = !(await verifyPassword(password, user.passwordHash));
  return prisma.user.update({
    where: { id: user.id },
    data: { disabledAt: null, ...(needsHash ? { passwordHash: await hashPassword(password) } : {}) },
  });
}
