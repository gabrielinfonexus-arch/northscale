import "server-only";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getConnector } from "./connectors/registry";
import type { ConnectorPlatform, ExternalAccount } from "./connectors/types";

export const PLATFORM_SLUG: Record<string, ConnectorPlatform> = { meta: "META", google: "GOOGLE", shopify: "SHOPIFY" };

export async function saveCredential(input: {
  organizationId: string;
  platform: ConnectorPlatform;
  kind: "oauth" | "system_user" | "api_token";
  token: string;
  label: string;
  externalUserId?: string | null;
  expiresAt?: Date | null;
  scopes?: string[];
  createdById?: string;
}) {
  const c = await prisma.connectorCredential.create({
    data: {
      organizationId: input.organizationId,
      platform: input.platform,
      kind: input.kind,
      label: input.label,
      externalUserId: input.externalUserId ?? null,
      encryptedToken: encryptSecret(input.token),
      tokenExpiresAt: input.expiresAt ?? null,
      scopes: input.scopes ?? [],
      createdById: input.createdById,
    },
  });
  return c.id;
}

/** Accounts visible to a stored credential (token is decrypted server-side only). */
export async function accountsForCredential(
  credentialId: string,
  organizationId: string,
): Promise<{
  credential: { id: string; label: string; platform: ConnectorPlatform; kind: string; tokenExpiresAt: Date | null };
  accounts: ExternalAccount[];
}> {
  const cred = await prisma.connectorCredential.findFirst({ where: { id: credentialId, organizationId } });
  if (!cred) throw new Error("Credential not found");
  const accounts = await getConnector(cred.platform as ConnectorPlatform).listAccounts(decryptSecret(cred.encryptedToken));
  return {
    credential: {
      id: cred.id,
      label: cred.label,
      platform: cred.platform as ConnectorPlatform,
      kind: cred.kind,
      tokenExpiresAt: cred.tokenExpiresAt,
    },
    accounts,
  };
}
