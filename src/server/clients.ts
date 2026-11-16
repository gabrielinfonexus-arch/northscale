import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";
import { accessibleClientIds, getCurrentUser } from "./auth";
import type { Platform, ConnectionStatus } from "@/generated/prisma/enums";

/** Safe projection: never includes tokens. */
export interface ConnectionSummary {
  id: string;
  platform: Platform;
  externalId: string;
  name: string;
  currency: string;
  status: ConnectionStatus;
}
export interface ClientSummary {
  id: string;
  slug: string;
  name: string;
  currency: string;
  timezone: string;
  logoUrl: string | null;
  isDemo: boolean;
  newAudienceMinPct: number;
  connections: ConnectionSummary[];
}

async function loadClients(ids: string[]): Promise<ClientSummary[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("clients");
  const rows = await prisma.client.findMany({
    where: { id: { in: ids } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      currency: true,
      timezone: true,
      logoUrl: true,
      isDemo: true,
      newAudienceMinPct: true,
      connections: {
        orderBy: [{ platform: "asc" }, { name: "asc" }],
        select: { id: true, platform: true, externalId: true, name: true, currency: true, status: true },
      },
    },
  });
  return rows;
}

export async function listClients(): Promise<ClientSummary[]> {
  const user = await getCurrentUser();
  return loadClients(await accessibleClientIds(user));
}

/** Resolve the client from the URL slug, falling back to the first accessible client. */
export async function resolveClient(slug: string | null): Promise<{ client: ClientSummary | null; clients: ClientSummary[] }> {
  const clients = await listClients();
  const client = (slug && clients.find((c) => c.slug === slug)) || clients[0] || null;
  return { client, clients };
}

export async function getOrgSettings() {
  const user = await getCurrentUser();
  return prisma.orgSetting.findUnique({ where: { organizationId: user.organizationId } });
}
