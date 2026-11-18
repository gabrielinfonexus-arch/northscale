import "server-only";
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { addDays, chunkRange, todayInTz, type DateRange } from "@/lib/periods";
import { getConnector, hasConnector } from "../connectors/registry";
import { ConnectorError, type ConnectorContext } from "../connectors/types";
import { refreshReportingViews } from "./writer";
import { runWatchdogSafe } from "../watchdog/run";

/**
 * - BACKFILL: 13 months, in 31-day chunks (newest first)
 * - INCREMENTAL: today (hourly), plus yesterday during the first hours of the day
 * - DAILY: re-sync the last 7 days (Meta keeps attributing conversions after the fact) + creatives + health
 * - RESYNC_RANGE: a custom range chosen on Sync Status
 */
export type SyncKind = "BACKFILL" | "INCREMENTAL" | "DAILY" | "RESYNC_RANGE";

export interface SyncRequest {
  connectionId: string;
  kind: SyncKind;
  from?: string;
  to?: string;
  /** an already-created QUEUED job to run (so the UI can show it immediately) */
  jobId?: string;
}

export const BACKFILL_DAYS = 395;
const CHUNK_DAYS = 31;
/**
 * Serverless functions are cut off after a few minutes (Vercel: maxDuration 300 s). A backfill stops after this
 * budget, keeps its place (meta.backfillResumeTo) and continues in a new run — automatically with Inngest, or
 * the next time Sync Status is opened (resumePausedBackfills).
 */
/** Refresh cached pages for a client (no-op outside the Next.js server, e.g. CLI scripts). */
function invalidateClient(clientId: string) {
  try {
    revalidateTag(`client:${clientId}`, "max");
  } catch {
    /* not running inside Next.js */
  }
}

const TIME_BUDGET_MS = Number(process.env.SYNC_TIME_BUDGET_MS ?? 230_000);

const JOB_KIND = { BACKFILL: "BACKFILL", INCREMENTAL: "INCREMENTAL", DAILY: "RESYNC_RANGE", RESYNC_RANGE: "RESYNC_RANGE" } as const;

export function plannedRange(kind: SyncKind, today: string, hourLocal: number, custom?: { from?: string; to?: string }): DateRange {
  switch (kind) {
    case "BACKFILL":
      return { from: addDays(today, -BACKFILL_DAYS), to: today };
    case "INCREMENTAL":
      return { from: hourLocal < 6 ? addDays(today, -1) : today, to: today };
    case "DAILY":
      return { from: addDays(today, -7), to: addDays(today, -1) };
    case "RESYNC_RANGE": {
      if (!custom?.from || !custom?.to) throw new Error("RESYNC_RANGE needs from/to");
      return { from: custom.from, to: custom.to > today ? today : custom.to };
    }
  }
}

/** Create the job row up front so the UI can show "queued" right away. */
export async function createJob(req: SyncRequest) {
  const job = await prisma.syncJob.create({
    data: {
      connectionId: req.connectionId,
      kind: JOB_KIND[req.kind],
      status: "QUEUED",
      rangeFrom: req.from ? new Date(req.from + "T00:00:00Z") : null,
      rangeTo: req.to ? new Date(req.to + "T00:00:00Z") : null,
    },
  });
  return job.id;
}

export interface RunOptions {
  /** rethrow retryable errors so the queue retries with backoff */
  throwRetryable?: boolean;
  /** skip the Watchdog run after the sync (tests, bulk backfills) */
  skipWatchdog?: boolean;
}

export async function runSync(
  req: SyncRequest,
  opts: RunOptions = {},
): Promise<{ jobId: string; status: "SUCCESS" | "FAILED"; rows: number }> {
  const conn = await prisma.connection.findUnique({ where: { id: req.connectionId }, include: { credential: true } });
  if (!conn) throw new Error(`Connection ${req.connectionId} not found`);
  const jobId = req.jobId ?? (await createJob(req));
  const started = new Date();
  await prisma.syncJob.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: started } });
  await prisma.connection.update({ where: { id: conn.id }, data: { status: "SYNCING", lastSyncAt: started } });

  const finish = async (
    status: "SUCCESS" | "FAILED",
    rows: number,
    extra: {
      error?: string;
      usage?: number;
      connStatus?: "OK" | "ERROR" | "TOKEN_EXPIRED";
      meta?: Record<string, unknown>;
      paused?: boolean;
    } = {},
  ) => {
    const now = new Date();
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status,
        finishedAt: now,
        rowsWritten: rows,
        error: extra.error ?? null,
        rateLimitPct: extra.usage ?? null,
        progress: status === "SUCCESS" ? 1 : undefined,
      },
    });
    await prisma.connection.update({
      where: { id: conn.id },
      data: {
        status: extra.connStatus ?? (status === "SUCCESS" ? "OK" : "ERROR"),
        lastError: extra.error ?? null,
        ...(status === "SUCCESS" ? { lastSuccessAt: now } : {}),
        nextSyncAt: new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000),
        ...(extra.meta ? { meta: { ...((conn.meta as Record<string, unknown>) ?? {}), ...extra.meta } as never } : {}),
        ...(req.kind === "BACKFILL" && status === "SUCCESS" && !extra.paused ? { backfillProgress: 1 } : {}),
      },
    });
    // Watchdog runs on every sync (success or failure); it never throws.
    if (!opts.skipWatchdog) await runWatchdogSafe(conn.clientId);
    return { jobId, status, rows };
  };

  // Demo connections have generated data: nothing to call.
  if (conn.isDemo) return finish("SUCCESS", 0, { meta: { lastDemoSync: new Date().toISOString() } });
  if (!hasConnector(conn.platform)) return finish("FAILED", 0, { error: `${conn.platform} connector arrives in a later phase.` });

  const encrypted = conn.encryptedToken ?? conn.credential?.encryptedToken;
  if (!encrypted) return finish("FAILED", 0, { error: "No credential — reconnect this account.", connStatus: "TOKEN_EXPIRED" });

  const connector = getConnector(conn.platform);
  let usage = 0;
  const ctx: ConnectorContext = {
    connectionId: conn.id,
    clientId: conn.clientId,
    externalId: conn.externalId,
    currency: conn.currency,
    timezone: conn.timezone,
    token: decryptSecret(encrypted),
    loginCustomerId: conn.loginCustomerId,
    meta: (conn.meta as Record<string, unknown>) ?? {},
    onUsage: (p) => (usage = Math.max(usage, p)),
  };

  const today = todayInTz(conn.timezone);
  const hourLocal = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: conn.timezone, hour: "numeric", hourCycle: "h23" }).format(new Date()),
  );
  const range = plannedRange(req.kind, today, hourLocal, req);
  const allChunks = chunkRange(range, CHUNK_DAYS);
  const baseMeta = (conn.meta as Record<string, unknown>) ?? {};
  const resumeTo = req.kind === "BACKFILL" && typeof baseMeta.backfillResumeTo === "string" ? baseMeta.backfillResumeTo : null;
  // resuming a paused backfill: skip the chunks already done (chunks are newest first)
  const chunks = resumeTo ? allChunks.filter((c) => c.to <= resumeTo) : allChunks;
  const doneBefore = allChunks.length - chunks.length;
  await prisma.syncJob.update({
    where: { id: jobId },
    data: { rangeFrom: new Date(range.from + "T00:00:00Z"), rangeTo: new Date(range.to + "T00:00:00Z") },
  });
  let rows = 0;
  const warnings: string[] = [];
  let metaPatch: Record<string, unknown> = {};

  try {
    for (let i = 0; i < chunks.length; i++) {
      const r1 = await connector.syncRange(ctx, chunks[i]);
      const r2 = await connector.syncBreakdowns(ctx, chunks[i]);
      rows += r1.rows + r2.rows;
      warnings.push(...r1.warnings, ...r2.warnings);
      metaPatch = { ...metaPatch, ...r1.metaPatch, ...r2.metaPatch };
      const progress = (doneBefore + i + 1) / allChunks.length;
      await prisma.syncJob.update({ where: { id: jobId }, data: { progress, rowsWritten: rows, rateLimitPct: usage || null } });
      if (req.kind === "BACKFILL") {
        const next = chunks[i + 1];
        // keep our place after every chunk, so even a hard timeout resumes here
        await prisma.connection.update({
          where: { id: conn.id },
          data: { backfillProgress: progress, meta: { ...baseMeta, ...metaPatch, backfillResumeTo: next ? next.to : null } as never },
        });
        // the most recent month first: make it visible right away
        if (i === 0 && doneBefore === 0) {
          await refreshReportingViews();
          invalidateClient(conn.clientId);
        }
        if (next && Date.now() - started.getTime() > TIME_BUDGET_MS) {
          await refreshReportingViews();
          invalidateClient(conn.clientId);
          const result = await finish("SUCCESS", rows, {
            usage,
            error: `Backfill ${Math.round(progress * 100)}% done (through ${next.to}); it continues automatically.`,
            meta: { ...metaPatch, backfillResumeTo: next.to },
            paused: true,
          });
          await continueBackfill(conn.id, conn.platform);
          return result;
        }
      }
    }
    if (req.kind !== "INCREMENTAL" && connector.syncCreatives) rows += (await connector.syncCreatives(ctx)).rows;
    const health = await connector.healthCheck(ctx);
    await refreshReportingViews();
    invalidateClient(conn.clientId);
    const uniqueWarnings = [...new Set(warnings)];
    return finish("SUCCESS", rows, {
      usage,
      connStatus: health.status,
      error: health.status !== "OK" ? health.message : uniqueWarnings.length ? `Warnings: ${uniqueWarnings.join(" ")}` : undefined,
      meta: {
        ...metaPatch,
        ...(health.account ? { account: health.account } : {}),
        warnings: uniqueWarnings,
        ...(req.kind === "BACKFILL" ? { backfillResumeTo: null } : {}),
      },
    });
  } catch (e) {
    const err = e instanceof ConnectorError ? e : new ConnectorError((e as Error).message ?? String(e), "transient");
    // keep whatever was written so far visible
    if (rows > 0) {
      await refreshReportingViews().catch(() => {});
      invalidateClient(conn.clientId);
    }
    const result = await finish("FAILED", rows, {
      usage,
      error: err.kind === "auth" ? `Token expired or revoked — reconnect. (${err.message})` : err.message,
      connStatus: err.kind === "auth" ? "TOKEN_EXPIRED" : "ERROR",
    });
    if (opts.throwRetryable && (err.kind === "rate_limit" || err.kind === "transient")) throw err;
    return result;
  }
}

/** Queue the next part of a paused backfill (with Inngest it runs right away; inline it runs on the next trigger). */
async function continueBackfill(connectionId: string, platform: string) {
  try {
    const { enqueueSync, queueMode } = await import("../queue/enqueue");
    if (queueMode() === "inngest") await enqueueSync({ connectionId, platform, kind: "BACKFILL" });
  } catch (e) {
    // the saved place is kept: Sync Status (or the next scheduled run) resumes it
    console.warn(`[sync] could not queue the next backfill part for ${connectionId}: ${(e as Error).message}`);
  }
}

/**
 * Inline mode (no Inngest): continue backfills that paused or were cut off by the platform's time limit.
 * Called when Sync Status / Sync Overview are opened.
 */
export async function resumePausedBackfills(clientIds: string[]) {
  const stale = new Date(Date.now() - 6 * 60_000);
  const conns = await prisma.connection.findMany({
    where: { clientId: { in: clientIds }, isDemo: false, status: { notIn: ["TOKEN_EXPIRED", "DISCONNECTED"] } },
    select: {
      id: true,
      platform: true,
      status: true,
      lastSyncAt: true,
      meta: true,
      jobs: { where: { status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true, startedAt: true, createdAt: true } },
    },
  });
  const { enqueueSync } = await import("../queue/enqueue");
  for (const c of conns) {
    const resumeTo = (c.meta as Record<string, unknown> | null)?.backfillResumeTo;
    if (typeof resumeTo !== "string" || !hasConnector(c.platform)) continue;
    const active = c.jobs.filter((j) => (j.startedAt ?? j.createdAt) > stale);
    if (active.length) continue; // still running
    // jobs cut off by a timeout never finished: close them
    if (c.jobs.length)
      await prisma.syncJob.updateMany({
        where: { id: { in: c.jobs.map((j) => j.id) } },
        data: { status: "FAILED", finishedAt: new Date(), error: "Stopped by the server time limit; resumed." },
      });
    await enqueueSync({ connectionId: c.id, platform: c.platform, kind: "BACKFILL" });
  }
}

/** Connections the scheduler should sync (real, connected, with a connector). */
export async function schedulableConnections() {
  const rows = await prisma.connection.findMany({
    where: { isDemo: false, status: { notIn: ["TOKEN_EXPIRED", "DISCONNECTED"] } },
    select: { id: true, platform: true },
  });
  return rows.filter((r) => hasConnector(r.platform));
}
