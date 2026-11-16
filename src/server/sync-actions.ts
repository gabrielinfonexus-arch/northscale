"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isIsoDate } from "@/lib/periods";
import { assertCanEdit, getCurrentUser } from "./auth";
import { getConnector } from "./connectors/registry";
import { PLATFORM_SLUG, saveCredential } from "./connect";
import { enqueueSync } from "./queue/enqueue";
import { decryptSecret } from "@/lib/crypto";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** System User token (Business Manager → Users → System users → Generate token with ads_read). */
export async function addTokenCredential(input: {
  clientId: string;
  platform: string;
  token: string;
}): Promise<Result<{ credentialId: string }>> {
  const d = z
    .object({ clientId: z.string().min(1), platform: z.enum(["meta"]), token: z.string().trim().min(20).max(2000) })
    .safeParse(input);
  if (!d.success) return { ok: false, error: "Paste a valid access token." };
  const user = await assertCanEdit(d.data.clientId);
  const platform = PLATFORM_SLUG[d.data.platform];
  try {
    const info = await getConnector(platform).inspectToken(d.data.token);
    const credentialId = await saveCredential({
      organizationId: user.organizationId,
      platform,
      kind: "system_user",
      token: d.data.token,
      label: `${info.name} (system user)`,
      externalUserId: info.id,
      expiresAt: info.expiresAt,
      scopes: info.scopes,
      createdById: user.id,
    });
    return { ok: true, credentialId };
  } catch (e) {
    return { ok: false, error: `Meta rejected the token: ${(e as Error).message}` };
  }
}

/** Shopify store: legacy custom-app token (shpat_…) or a Dev Dashboard app's client ID + secret. */
export async function addShopifyCredential(input: {
  clientId: string;
  shop: string;
  accessToken?: string;
  appClientId?: string;
  appClientSecret?: string;
}): Promise<Result<{ credentialId: string }>> {
  const d = z
    .object({
      clientId: z.string().min(1),
      shop: z.string().trim().min(3).max(200),
      accessToken: z.string().trim().max(500).optional(),
      appClientId: z.string().trim().max(200).optional(),
      appClientSecret: z.string().trim().max(500).optional(),
    })
    .safeParse(input);
  if (!d.success) return { ok: false, error: "Fill in the store domain and either an access token or the app's client ID and secret." };
  const user = await assertCanEdit(d.data.clientId);
  const { shop, accessToken, appClientId, appClientSecret } = d.data;
  if (!accessToken && !(appClientId && appClientSecret))
    return { ok: false, error: "Paste an Admin API access token, or the app's client ID and client secret." };
  const raw = JSON.stringify(accessToken ? { shop, accessToken } : { shop, clientId: appClientId, clientSecret: appClientSecret });
  try {
    const info = await getConnector("SHOPIFY").inspectToken(raw);
    const credentialId = await saveCredential({
      organizationId: user.organizationId,
      platform: "SHOPIFY",
      kind: accessToken ? "api_token" : "client_credentials",
      token: JSON.stringify({ ...JSON.parse(raw), shop: info.id }),
      label: `${info.name} (${info.id})`,
      externalUserId: info.id,
      createdById: user.id,
    });
    return { ok: true, credentialId };
  } catch (e) {
    return { ok: false, error: `Shopify rejected the credentials: ${(e as Error).message}` };
  }
}

const LinkInput = z.object({
  credentialId: z.string().min(1),
  clientId: z.string().min(1),
  accounts: z
    .array(
      z.object({
        externalId: z.string().min(1),
        name: z.string().min(1),
        currency: z.string().length(3),
        timezone: z.string().min(1),
        loginCustomerId: z.string().nullish(),
      }),
    )
    .min(1)
    .max(100),
});

/** Link the chosen ad accounts to a client and start a 13-month backfill for each. */
export async function linkAccounts(input: z.infer<typeof LinkInput>): Promise<Result<{ connections: number }>> {
  const d = LinkInput.parse(input);
  const user = await assertCanEdit(d.clientId);
  const cred = await prisma.connectorCredential.findFirst({ where: { id: d.credentialId, organizationId: user.organizationId } });
  if (!cred) return { ok: false, error: "Credential not found." };
  for (const a of d.accounts) {
    const conn = await prisma.connection.upsert({
      where: { clientId_platform_externalId: { clientId: d.clientId, platform: cred.platform, externalId: a.externalId } },
      create: {
        clientId: d.clientId,
        platform: cred.platform,
        externalId: a.externalId,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        status: "SYNCING",
        credentialId: cred.id,
        loginCustomerId: a.loginCustomerId ?? null,
        backfillProgress: 0,
        meta: { accountName: a.name },
      },
      update: { credentialId: cred.id, status: "SYNCING", lastError: null, name: a.name, loginCustomerId: a.loginCustomerId ?? null },
    });
    if (cred.platform === "SHOPIFY") await registerShopifyWebhooks(conn.id, cred.encryptedToken).catch(() => {});
    const hasData = await prisma.syncJob.count({ where: { connectionId: conn.id, kind: "BACKFILL", status: "SUCCESS" } });
    await enqueueSync({ connectionId: conn.id, platform: cred.platform, kind: hasData ? "INCREMENTAL" : "BACKFILL" });
  }
  updateTag("clients");
  return { ok: true, connections: d.accounts.length };
}

async function connectionFor(connectionId: string) {
  const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error("Not found");
  await assertCanEdit(conn.clientId);
  return conn;
}

export async function syncNow(connectionId: string): Promise<Result> {
  const conn = await connectionFor(connectionId);
  await enqueueSync({ connectionId, platform: conn.platform, kind: "INCREMENTAL" });
  return { ok: true };
}

export async function resyncRange(connectionId: string, from: string, to: string): Promise<Result> {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return { ok: false, error: "Pick a valid date range." };
  const conn = await connectionFor(connectionId);
  await enqueueSync({ connectionId, platform: conn.platform, kind: "RESYNC_RANGE", from, to });
  return { ok: true };
}

export async function currentUserCanEdit() {
  const u = await getCurrentUser();
  return u.role !== "CLIENT_VIEWER";
}

/** Subscribe the store to orders/create, orders/updated and refunds/create (needs a public https APP_URL). */
async function registerShopifyWebhooks(connectionId: string, encryptedToken: string) {
  const base = process.env.APP_URL ?? "";
  const mock = process.env.SHOPIFY_MOCK === "1";
  if (!base.startsWith("https://") && !mock) return;
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
  const connector = getConnector("SHOPIFY");
  const r = await connector.registerWebhooks!(
    {
      connectionId,
      clientId: conn.clientId,
      externalId: conn.externalId,
      currency: conn.currency,
      timezone: conn.timezone,
      token: decryptSecret(encryptedToken),
      meta: {},
    },
    `${base || "https://mock.northscale.local"}/api/webhooks/shopify`,
  );
  await prisma.connection.update({
    where: { id: connectionId },
    data: { meta: { ...((conn.meta as object) ?? {}), webhooks: r.registered, webhookWarnings: r.warnings } },
  });
}
