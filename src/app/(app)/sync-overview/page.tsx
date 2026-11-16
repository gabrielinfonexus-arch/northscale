import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { PageTitle } from "@/components/shell/page-header";
import { PlatformDot, PLATFORM_LABEL } from "@/components/shell/platform";
import { JobsPerDay } from "@/components/sync/overview-charts";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getSyncOverview } from "@/server/sync-status";

export const metadata: Metadata = { title: "Sync Overview" };

const KIND: Record<string, string> = {
  BACKFILL: "Backfill",
  INCREMENTAL: "Hourly",
  RESYNC_RANGE: "Re-sync",
  BREAKDOWNS: "Breakdowns",
  CREATIVES: "Creatives",
  WEBHOOK: "Webhook",
  RECONCILE: "Reconcile",
};
const STATUS_CLS: Record<string, string> = {
  SUCCESS: "text-good",
  FAILED: "text-bad",
  RUNNING: "text-primary",
  QUEUED: "text-muted",
  CANCELLED: "text-muted",
};

function duration(a: string | null, b: string | null) {
  if (!a || !b) return "—";
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
const fmtTime = (iso: string) => new Date(iso).toISOString().slice(5, 16).replace("T", " ");

async function Content() {
  await connection();
  const o = await getSyncOverview(14);
  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-4 md:grid-cols-3">
        {[
          ["Jobs (14 days)", o.totals.jobs.toLocaleString("en-US")],
          ["Failed", `${o.totals.failed} (${o.totals.jobs ? ((o.totals.failed / o.totals.jobs) * 100).toFixed(1) : 0}%)`],
          ["Rows written", o.totals.rows.toLocaleString("en-US")],
        ].map(([l, v]) => (
          <Card key={l} className="px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{l}</div>
            <div className="num mt-1 text-[22px] font-semibold">{v}</div>
          </Card>
        ))}
      </section>
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2" data-testid="jobs-per-day">
          <h2 className="mb-2 text-[13px] font-semibold">Jobs per day</h2>
          <JobsPerDay data={o.perDay} />
        </Card>
        <div className="flex flex-col gap-4">
          <Card className="p-4" data-testid="rate-limits">
            <h2 className="mb-3 text-[13px] font-semibold">API rate-limit usage (peak, last 24h)</h2>
            {o.usage.length === 0 && <p className="text-[12.5px] text-muted">No usage reported yet.</p>}
            <ul className="flex flex-col gap-3">
              {o.usage.map((u) => (
                <li key={u.platform} className="text-[12.5px]">
                  <div className="mb-1 flex items-center gap-2">
                    <PlatformDot platform={u.platform} />
                    <span className="flex-1">{PLATFORM_LABEL[u.platform]}</span>
                    <span className={cn("num font-medium", u.pct >= 75 ? "text-warn" : "text-muted")}>{Math.round(u.pct)}%</span>
                  </div>
                  <div
                    className="relative h-1.5 rounded-full bg-accent"
                    role="progressbar"
                    aria-valuenow={Math.round(u.pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${PLATFORM_LABEL[u.platform]} usage`}
                  >
                    <div
                      className={cn("h-full rounded-full", u.pct >= 75 ? "bg-warn" : "bg-primary")}
                      style={{ width: `${Math.min(100, u.pct)}%` }}
                    />
                    <span
                      className="absolute -top-0.5 h-2.5 w-px bg-foreground/50"
                      style={{ left: "75%" }}
                      title="Sync slows down above 75%"
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-4" data-testid="backfills">
            <h2 className="mb-3 text-[13px] font-semibold">Backfills in progress</h2>
            {o.backfills.length === 0 && <p className="text-[12.5px] text-muted">None running.</p>}
            <ul className="flex flex-col gap-3">
              {o.backfills.map((b) => (
                <li key={b.id} className="text-[12.5px]">
                  <div className="mb-1 flex justify-between">
                    <span>{b.connectionName}</span>
                    <span className="num text-muted">{Math.round((b.progress ?? 0) * 100)}%</span>
                  </div>
                  <div
                    className="h-1.5 rounded-full bg-accent"
                    role="progressbar"
                    aria-valuenow={Math.round((b.progress ?? 0) * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(3, (b.progress ?? 0) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </section>
      <Card className="overflow-hidden">
        <h2 className="px-4 pb-2 pt-3 text-[13px] font-semibold">Job log (latest 200)</h2>
        <div className="scroll-thin max-h-[560px] overflow-auto">
          <table className="w-full min-w-[960px] border-separate border-spacing-0 text-[12.5px]" data-testid="job-log">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-[10.5px] uppercase tracking-wide text-subtle">
                {["Started (UTC)", "Duration", "Type", "Account", "Client", "Status", "Rows", "Rate limit", "Error"].map((h, i) => (
                  <th
                    key={h}
                    className={cn("border-b border-border px-3 py-2 text-left font-medium", (i === 6 || i === 7) && "text-right")}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {o.jobs.map((j) => (
                <tr key={j.id} className="hover:bg-accent/50">
                  <td className="num whitespace-nowrap border-b border-border px-3 py-1.5">{fmtTime(j.startedAt ?? j.createdAt)}</td>
                  <td className="num border-b border-border px-3 py-1.5 text-muted">{duration(j.startedAt, j.finishedAt)}</td>
                  <td className="border-b border-border px-3 py-1.5">{KIND[j.kind] ?? j.kind}</td>
                  <td className="border-b border-border px-3 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <PlatformDot platform={j.platform} /> {j.connectionName}
                    </span>
                  </td>
                  <td className="border-b border-border px-3 py-1.5 text-muted">{j.clientName}</td>
                  <td className={cn("border-b border-border px-3 py-1.5 font-medium", STATUS_CLS[j.status])}>{j.status.toLowerCase()}</td>
                  <td className="num border-b border-border px-3 py-1.5 text-right">{j.rows.toLocaleString("en-US")}</td>
                  <td className="num border-b border-border px-3 py-1.5 text-right text-muted">
                    {j.rateLimitPct === null ? "—" : `${Math.round(j.rateLimitPct)}%`}
                  </td>
                  <td className="max-w-[320px] truncate border-b border-border px-3 py-1.5 text-bad" title={j.error ?? undefined}>
                    {j.error ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export default function SyncOverviewPage() {
  return (
    <>
      <PageTitle title="Sync Overview" />
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <Content />
      </Suspense>
    </>
  );
}
