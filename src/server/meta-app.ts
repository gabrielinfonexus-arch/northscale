import "server-only";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

export interface MetaAppConfig {
  appId: string;
  secret: string;
  configId: string | null;
  source: "env" | "settings";
}

/**
 * The Meta app used for "Continue with Facebook". Environment variables (META_APP_ID / META_APP_SECRET /
 * META_LOGIN_CONFIG_ID) win; otherwise the values saved in NorthScale (Sync Status → Connect Meta → set up),
 * with the secret stored AES-256-GCM encrypted.
 */
export async function getMetaAppConfig(): Promise<MetaAppConfig | null> {
  if (process.env.META_APP_ID && process.env.META_APP_SECRET)
    return {
      appId: process.env.META_APP_ID,
      secret: process.env.META_APP_SECRET,
      configId: process.env.META_LOGIN_CONFIG_ID || null,
      source: "env",
    };
  const s = await prisma.orgSetting.findFirst({
    where: { metaAppId: { not: null }, metaAppSecretEncrypted: { not: null } },
    select: { metaAppId: true, metaAppSecretEncrypted: true, metaLoginConfigId: true },
  });
  if (!s?.metaAppId || !s.metaAppSecretEncrypted) return null;
  try {
    return { appId: s.metaAppId, secret: decryptSecret(s.metaAppSecretEncrypted), configId: s.metaLoginConfigId, source: "settings" };
  } catch {
    return null; // ENCRYPTION_KEY changed: set it up again
  }
}

export const metaMockOn = () => process.env.META_MOCK === "1" && process.env.NODE_ENV !== "production";

/**
 * Ask Meta whether the App ID + secret pair is valid (an app access token is only issued for a correct pair).
 * Returns null when valid, an error message when Meta rejects it, or "unreachable" when Meta can't be reached.
 */
export async function checkMetaApp(appId: string, secret: string): Promise<string | null> {
  const v = process.env.META_API_VERSION || "v26.0";
  const u = new URL(`https://graph.facebook.com/${v}/oauth/access_token`);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("client_secret", secret);
  u.searchParams.set("grant_type", "client_credentials");
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) return null;
    const body = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    return body.error?.message ?? `Meta answered ${r.status}`;
  } catch {
    return "unreachable";
  }
}
