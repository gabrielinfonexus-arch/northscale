import "server-only";
import { prisma } from "@/lib/db";
import { accessibleClientIds, getCurrentUser } from "./auth";

export interface ConnectionStatusRow {
  id: string;
  platform: string;
  name: string;
  externalId: string;
  clientId: string;
  clientName: string;
  clientSlug: string;
  status: string;
  isDemo: boolean;
  lastSuccessAt: string | null;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  backfillProgress: number | null;
  credentialLabel: string | null;
  tokenExpiresAt: string | null;
  lastJob: { status: string; kind: string; rows: number; finishedAt: string | null; progress: number | null } | null;
  account: Record<string, unknown> | null;
}

/** Server time of the snapshot (so relative times render identically on server and client). */
export function snapshotTime(): number {
  return Date.now();
}

/** Live (uncached) — statuses change while jobs run. */
export async function getConnectionStatuses(): Promise<ConnectionStatusRow[]> {
  const user = await getCurrentUser();
  const ids = await accessibleClientIds(user);
  const conns = await prisma.connection.findMany({
    where: { clientId: { in: ids } },
    include: {
      client: { select: { name: true, slug: true } },
      credential: { select: { label: true, tokenExpiresAt: true } },
      jobs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: [{ client: { name: "asc" } }, { platform: "asc" }, { name: "asc" }],
  });
  return conns.map((c) => {
    const j = c.jobs[0];
    const meta = (c.meta as Record<string, unknown> | null) ?? {};
    return {
      id: c.id,
      platform: c.platform,
      name: c.name,
      externalId: c.externalId,
      clientId: c.clientId,
      clientName: c.client.name,
      clientSlug: c.client.slug,
      status: c.status,
      isDemo: c.isDemo,
      lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      nextSyncAt: c.nextSyncAt?.toISOString() ?? null,
      lastError: c.lastError,
      backfillProgress: c.backfillProgress,
      credentialLabel: c.credential?.label ?? null,
      tokenExpiresAt: (c.credential?.tokenExpiresAt ?? c.tokenExpiresAt)?.toISOString() ?? null,
      lastJob: j
        ? { status: j.status, kind: j.kind, rows: j.rowsWritten, finishedAt: j.finishedAt?.toISOString() ?? null, progress: j.progress }
        : null,
      account: (meta.account as Record<string, unknown>) ?? null,
    };
  });
}

export interface JobRow {
  id: string;
  connectionName: string;
  platform: string;
  clientName: string;
  kind: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  rows: number;
  error: string | null;
  rateLimitPct: number | null;
  progress: number | null;
}

export async function getSyncOverview(days = 14) {
  const user = await getCurrentUser();
  const ids = await accessibleClientIds(user);
  const since = new Date(Date.now() - days * 86_400_000);
  const scope = { connection: { clientId: { in: ids } }, createdAt: { gte: since } };
  const [jobs, perDayRaw, usageRaw, totalsRaw, backfillJobs] = await Promise.all([
    prisma.syncJob.findMany({
      where: scope,
      include: { connection: { select: { name: true, platform: true, client: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.$queryRawUnsafe<{ date: string; status: string; n: number }[]>(
      `SELECT to_char(j."createdAt", 'YYYY-MM-DD') AS date, j.status::text AS status, COUNT(*)::int AS n
       FROM sync_jobs j JOIN connections c ON c.id = j."connectionId"
       WHERE c."clientId" = ANY($1::text[]) AND j."createdAt" >= $2 GROUP BY 1, 2`,
      ids,
      since,
    ),
    prisma.$queryRawUnsafe<{ platform: string; pct: number }[]>(
      `SELECT c.platform::text AS platform, MAX(j."rateLimitPct")::float8 AS pct
       FROM sync_jobs j JOIN connections c ON c.id = j."connectionId"
       WHERE c."clientId" = ANY($1::text[]) AND j."createdAt" >= now() - interval '24 hours' AND j."rateLimitPct" IS NOT NULL GROUP BY 1`,
      ids,
    ),
    prisma.$queryRawUnsafe<{ jobs: number; failed: number; rows: number }[]>(
      `SELECT COUNT(*)::int AS jobs, COUNT(*) FILTER (WHERE j.status = 'FAILED')::int AS failed, COALESCE(SUM(j."rowsWritten"), 0)::float8 AS rows
       FROM sync_jobs j JOIN connections c ON c.id = j."connectionId" WHERE c."clientId" = ANY($1::text[]) AND j."createdAt" >= $2`,
      ids,
      since,
    ),
    prisma.syncJob.findMany({
      where: { connection: { clientId: { in: ids } }, kind: "BACKFILL", status: { in: ["RUNNING", "QUEUED"] } },
      include: { connection: { select: { name: true, platform: true, client: { select: { name: true } } } } },
    }),
  ]);
  const toRow = (j: (typeof jobs)[number]): JobRow => ({
    id: j.id,
    connectionName: j.connection.name,
    platform: j.connection.platform,
    clientName: j.connection.client.name,
    kind: j.kind,
    status: j.status,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
    rows: j.rowsWritten,
    error: j.error,
    rateLimitPct: j.rateLimitPct,
    progress: j.progress,
  });
  const perDay = new Map<string, { SUCCESS: number; FAILED: number; RUNNING: number; QUEUED: number }>();
  for (let i = days - 1; i >= 0; i--)
    perDay.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), { SUCCESS: 0, FAILED: 0, RUNNING: 0, QUEUED: 0 });
  for (const r of perDayRaw) {
    const e = perDay.get(r.date);
    if (e && r.status in e) e[r.status as keyof typeof e] += r.n;
  }
  const t = totalsRaw[0] ?? { jobs: 0, failed: 0, rows: 0 };
  return {
    jobs: jobs.map(toRow),
    perDay: [...perDay].map(([date, c]) => ({ date, ...c })),
    usage: usageRaw.map((u) => ({ platform: u.platform, pct: u.pct })),
    backfills: backfillJobs.map(toRow),
    totals: { jobs: t.jobs, failed: t.failed, rows: t.rows },
  };
}
