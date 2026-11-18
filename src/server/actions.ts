"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "./auth";

/** Per-user preference (column choices, layouts…). */
export async function savePreference(key: string, value: unknown) {
  const k = z
    .string()
    .regex(/^[a-zA-Z0-9_.:-]{1,120}$/)
    .parse(key);
  const user = await getCurrentUser();
  if (user.kind !== "user") return; // public links have no account to remember preferences
  await prisma.userPreference.upsert({
    where: { userId_key: { userId: user.id, key: k } },
    update: { value: value as never },
    create: { userId: user.id, key: k, value: value as never },
  });
  updateTag(`prefs:${user.id}`);
}

export async function setDemoData(enabled: boolean) {
  const user = await getCurrentUser();
  if (user.role !== "OWNER" && user.role !== "ADMIN") throw new Error("Forbidden");
  await prisma.orgSetting.update({ where: { organizationId: user.organizationId }, data: { demoData: z.boolean().parse(enabled) } });
  updateTag("clients");
}

/** Save the Meta app used for "Continue with Facebook" (Owner / Admin). The secret is stored encrypted. */
export async function saveMetaApp(input: {
  appId: string;
  secret: string;
  configId: string;
}): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  const user = await getCurrentUser();
  if (user.role !== "OWNER" && user.role !== "ADMIN") return { ok: false, error: "Only Owners and Admins can set this up." };
  const appId = input.appId.trim();
  const secret = input.secret.trim();
  const configId = input.configId.trim();
  if (!/^\d{5,25}$/.test(appId)) return { ok: false, error: "The App ID is a number (App settings → Basic)." };
  if (!/^[a-f0-9]{32}$/i.test(secret))
    return { ok: false, error: "The App secret has 32 letters and numbers (App settings → Basic → Show)." };
  if (configId && !/^\d{5,25}$/.test(configId))
    return { ok: false, error: "The Configuration ID is a number (Facebook Login for Business → Configurations)." };
  const { checkMetaApp } = await import("./meta-app");
  const problem = await checkMetaApp(appId, secret);
  if (problem && problem !== "unreachable") return { ok: false, error: `Meta rejected the App ID / secret: ${problem}` };
  const { encryptSecret } = await import("@/lib/crypto");
  await prisma.orgSetting.update({
    where: { organizationId: user.organizationId },
    data: { metaAppId: appId, metaAppSecretEncrypted: encryptSecret(secret), metaLoginConfigId: configId || null },
  });
  return { ok: true, ...(problem === "unreachable" ? { warning: "Saved, but Meta couldn't be reached to double-check the keys." } : {}) };
}
