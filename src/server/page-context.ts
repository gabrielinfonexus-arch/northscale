import "server-only";
import { connection } from "next/server";
import { parseFilters, type GlobalFilters, type SearchParams } from "@/lib/filters";
import { todayInTz } from "@/lib/periods";
import { getCurrentUser, type SessionUser } from "./auth";
import { getOrgSettings, resolveClient, type ClientSummary } from "./clients";

export interface PageContext {
  user: SessionUser;
  sp: SearchParams;
  client: ClientSummary | null;
  clients: ClientSummary[];
  filters: GlobalFilters;
  /** account ids actually applied (only ids that belong to the client) */
  connectionIds: string[];
  today: string;
  thresholdPct: number;
}

/** Everything a page needs from the URL, resolved against the user's permissions. */
export async function getPageContext(searchParams: Promise<SearchParams>): Promise<PageContext> {
  const sp = await searchParams;
  const user = await getCurrentUser();
  const { client, clients } = await resolveClient(typeof sp.client === "string" ? sp.client : null);
  await connection(); // "today" depends on the request time
  const today = todayInTz(client?.timezone ?? "UTC");
  const filters = parseFilters(sp, today);
  const valid = new Set(client?.connections.map((c) => c.id) ?? []);
  const connectionIds = filters.accounts.filter((a) => valid.has(a));
  const settings = await getOrgSettings();
  return { user, sp, client, clients, filters, connectionIds, today, thresholdPct: settings?.comparisonThresholdPct ?? 2 };
}
