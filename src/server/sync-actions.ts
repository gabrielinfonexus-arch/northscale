"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isIsoDate } from "@/lib/periods";
import { assertCanEdit, getCurrentUser } from "./auth";
import { getConnector } from "./connectors/registry";
import { PLATFORM_SLUG, saveCredential } from "./connect";
import { enqueueSync } from "./queue/enqueue";

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
