"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { createSession, destroySession } from "./auth";
import { hashPassword, newToken, passwordProblem, verifyPassword } from "./password";
import { absoluteUrl, sendEmail } from "./email";

/** `values` re-fills non-secret fields after an error (React resets the form after every action). */
export type FormState = { error?: string; message?: string; values?: Record<string, string> } | null;

const email = z.email().transform((e) => e.trim().toLowerCase());

async function clientIp() {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

/** Same-site relative path only (no open redirects). */
function safeNext(next: unknown): string {
  const n = typeof next === "string" ? next : "";
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/dashboard";
}

const WINDOW_MS = 15 * 60_000;

export async function login(_: FormState, form: FormData): Promise<FormState> {
  const parsed = email.safeParse(form.get("email"));
  const password = String(form.get("password") ?? "");
  if (!parsed.success || !password) return { error: "Enter your email and password." };
  const ip = await clientIp();
  const since = new Date(Date.now() - WINDOW_MS);
  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({ where: { email: parsed.data, ok: false, createdAt: { gte: since } } }),
    ip ? prisma.loginAttempt.count({ where: { ip, ok: false, createdAt: { gte: since } } }) : 0,
  ]);
  const values = { email: parsed.data };
  if (byEmail >= 8 || byIp >= 40) return { error: "Too many attempts. Wait 15 minutes or reset your password.", values };

  const user = await prisma.user.findUnique({ where: { email: parsed.data }, include: { memberships: { take: 1 } } });
  const ok = !!user && !user.disabledAt && user.memberships.length > 0 && (await verifyPassword(password, user.passwordHash));
  await prisma.loginAttempt.create({ data: { email: parsed.data, ip, ok } });
  if (!ok || !user) return { error: "Wrong email or password.", values };
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession({ userId: user.id });
  redirect(safeNext(form.get("next")));
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

/** Always answers the same way, so it can't be used to find out which emails have accounts. */
export async function requestPasswordReset(_: FormState, form: FormData): Promise<FormState> {
  const parsed = email.safeParse(form.get("email"));
  if (!parsed.success) return { error: "Enter a valid email." };
  const user = await prisma.user.findUnique({ where: { email: parsed.data }, include: { memberships: { take: 1 } } });
  if (user && !user.disabledAt && user.memberships[0]) {
    const recent = await prisma.authToken.count({
      where: { email: parsed.data, kind: "reset", createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
    });
    if (recent < 3) {
      const token = newToken();
      await prisma.authToken.create({
        data: {
          kind: "reset",
          tokenHash: hashToken(token),
          email: parsed.data,
          organizationId: user.memberships[0].organizationId,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const url = absoluteUrl(`/reset/${token}`, (await headers()).get("origin"));
      await sendEmail(
        parsed.data,
        "Reset your NorthScale password",
        `Open this link within 1 hour to choose a new password:\n\n${url}\n\nIf you didn't ask for this, ignore this email.`,
      );
    }
  }
  return { message: "If that email has an account, a reset link is on its way. No email? Ask an admin for a reset link (Team Members)." };
}

async function usableToken(token: string, kind: "invite" | "reset") {
  const t = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!t || t.kind !== kind || t.usedAt || t.expiresAt <= new Date()) return null;
  return t;
}

export async function resetPassword(_: FormState, form: FormData): Promise<FormState> {
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return { error: "The passwords don't match." };
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const t = await usableToken(token, "reset");
  if (!t) return { error: "This link has expired or was already used. Ask for a new one." };
  const user = await prisma.user.findUnique({ where: { email: t.email } });
  if (!user || user.disabledAt) return { error: "This account is not active." };
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } }),
    prisma.authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
    prisma.session.deleteMany({ where: { userId: user.id } }), // sign out everywhere
  ]);
  await createSession({ userId: user.id });
  redirect("/dashboard");
}

export async function acceptInvite(_: FormState, form: FormData): Promise<FormState> {
  const token = String(form.get("token") ?? "");
  const name = String(form.get("name") ?? "")
    .trim()
    .slice(0, 120);
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return { error: "The passwords don't match." };
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const t = await usableToken(token, "invite");
  if (!t || !t.role) return { error: "This invitation has expired or was already used. Ask for a new one." };

  const existing = await prisma.user.findUnique({ where: { email: t.email }, include: { memberships: true } });
  if (existing?.memberships.some((m) => m.organizationId !== t.organizationId))
    return { error: "This email already belongs to another organization." };
  const passwordHash = await hashPassword(password);
  const user = await prisma.$transaction(async (tx) => {
    const u = existing
      ? await tx.user.update({ where: { id: existing.id }, data: { name: name || existing.name, passwordHash, disabledAt: null } })
      : await tx.user.create({ data: { email: t.email, name: name || null, passwordHash } });
    await tx.membership.upsert({
      where: { userId_organizationId: { userId: u.id, organizationId: t.organizationId } },
      update: { role: t.role! },
      create: { userId: u.id, organizationId: t.organizationId, role: t.role! },
    });
    for (const clientId of t.clientIds)
      await tx.clientAccess.upsert({
        where: { userId_clientId: { userId: u.id, clientId } },
        update: { allowedPages: t.allowedPages },
        create: { userId: u.id, clientId, allowedPages: t.allowedPages },
      });
    await tx.authToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
    return u;
  });
  updateTag("users");
  updateTag(`access:${user.id}`);
  await createSession({ userId: user.id });
  redirect("/dashboard");
}
