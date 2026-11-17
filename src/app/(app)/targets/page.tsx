import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageTitle } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { PaceRow } from "@/components/dashboard/widgets";
import { TargetsWorkspace } from "@/components/targets/targets-workspace";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { compareToTarget, getMetric } from "@/lib/metrics";
import { EMPTY, formatMetricValue } from "@/lib/format";
import { pickGlobalParams } from "@/lib/filters";
import { addMonths, startOfMonth } from "@/lib/periods";
import { cn } from "@/lib/utils";
import { getPageContext } from "@/server/page-context";
import { getMonthPacing, getShopifyEconomics, getTargetHistory, TARGET_FIELDS, type TargetScope } from "@/server/targets";

export const metadata: Metadata = { title: "Targets" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const SCOPE_TITLE: Record<TargetScope, string> = { CLIENT: "Whole client", META: "Meta", GOOGLE: "Google" };

async function TargetsContent({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams, "targets");
  const { client } = ctx;
  if (!client) {
    return (
      <>
        <PageTitle title="Targets" />
        <EmptyState title="No clients yet">Add a client first.</EmptyState>
      </>
    );
  }
  const current = startOfMonth(ctx.today);
  const raw = typeof ctx.sp.month === "string" && /^\d{4}-\d{2}$/.test(ctx.sp.month) ? `${ctx.sp.month}-01` : current;
  const month = raw > addMonths(current, 12) ? current : raw;
  const [pacing, prevPacing, history, economics] = await Promise.all([
    getMonthPacing(client.id, month, ctx.today),
    getMonthPacing(client.id, addMonths(month, -1), ctx.today),
    getTargetHistory(client.id, ctx.today, 12),
    getShopifyEconomics(client.id, ctx.today),
  ]);

  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(ctx.sp)) if (typeof v === "string") sp.set(k, v);
  const monthHref = (m: string) => {
    const p = pickGlobalParams(sp);
    if (m !== current) p.set("month", m.slice(0, 7));
    return `/targets${p.toString() ? `?${p}` : ""}`;
  };
  const hasPrevTargets = Object.values(prevPacing.targets).some((s) => Object.values(s).some((v) => typeof v === "number"));

  return (
    <>
      <PageTitle title="Targets">
        <nav className="flex h-8 items-center rounded-lg border border-border bg-surface" aria-label="Month">
          <Link
            href={monthHref(addMonths(month, -1))}
            className="flex h-full items-center px-2 text-muted hover:text-foreground"
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" />
          </Link>
          <span className="min-w-[132px] text-center text-[13px] font-medium" data-testid="target-month">
            {monthName(month)}
          </span>
          <Link
            href={monthHref(addMonths(month, 1))}
            className="flex h-full items-center px-2 text-muted hover:text-foreground"
            aria-label="Next month"
          >
            <ChevronRight className="size-4" />
          </Link>
        </nav>
      </PageTitle>

      <section className="mb-4 grid gap-4 md:grid-cols-3" data-testid="pacing-section">
        {pacing.groups.map((g) => (
          <Card key={g.scope} className="p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold">{SCOPE_TITLE[g.scope]}</h2>
              <span className="text-[11px] text-muted">
                {pacing.isCurrent ? `${pacing.daysElapsed}/${pacing.daysInMonth} days · projected` : month > current ? "Upcoming" : "Final"}
              </span>
            </div>
            {g.items.length === 0 ? (
              <p className="text-[12.5px] text-muted">No targets set for {SCOPE_TITLE[g.scope].toLowerCase()} this month.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {g.items.map((i) => (
                  <PaceRow key={i.field} item={i} currency={client.currency} label={i.label} />
                ))}
              </ul>
            )}
          </Card>
        ))}
      </section>

      <TargetsWorkspace
        key={`${client.id}:${month}`}
        clientId={client.id}
        month={month}
        currency={client.currency}
        fields={TARGET_FIELDS}
        targets={pacing.targets}
        previous={hasPrevTargets ? prevPacing.targets : null}
        economics={economics}
        saved={{
          aov: client.breakevenAov,
          marginPct: client.breakevenMarginPct,
          fixedCosts: client.fixedCostsMonthly,
          multiplier: client.profitMultiplier,
        }}
        canEdit={ctx.user.role !== "CLIENT_VIEWER"}
      />

      <Card className="mt-4 overflow-hidden" data-testid="targets-history">
        <h2 className="px-4 pb-2 pt-3 text-[13px] font-semibold">Target vs actual — last 12 months</h2>
        <div className="scroll-thin overflow-x-auto">
          <table className="num w-full border-separate border-spacing-0 text-[12.5px]">
            <thead>
              <tr className="text-[10.5px] uppercase tracking-wide text-subtle">
                <th className="sticky left-0 border-b border-border bg-surface px-4 py-2 text-left font-medium">Month</th>
                {(["CLIENT", "META", "GOOGLE"] as const).flatMap((scope) =>
                  TARGET_FIELDS[scope].map((f) => (
                    <th key={`${scope}.${f.field}`} className="whitespace-nowrap border-b border-border px-3 py-2 text-right font-medium">
                      {f.label}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.month}>
                  <td className="sticky left-0 whitespace-nowrap border-b border-border bg-surface px-4 py-2">
                    <Link href={monthHref(row.month)} className="hover:underline">
                      {monthName(row.month)}
                    </Link>
                    {row.month === current && <span className="ml-1 text-[10.5px] text-subtle">(to date)</span>}
                  </td>
                  {row.items.map((it) => {
                    const def = getMetric(it.metric);
                    const c =
                      it.target !== null && row.month !== current
                        ? compareToTarget(it.metric, it.actual, it.target, ctx.thresholdPct)
                        : null;
                    return (
                      <td
                        key={`${it.scope}.${it.field}`}
                        className={cn(
                          "whitespace-nowrap border-b border-border px-3 py-1.5 text-right",
                          c?.tone === "good" && "bg-good-bg",
                          c?.tone === "bad" && "bg-bad-bg",
                        )}
                        title={c?.deltaPct != null ? `${c.deltaPct > 0 ? "+" : ""}${c.deltaPct.toFixed(1)}% vs target` : undefined}
                      >
                        <div className="leading-tight">
                          {formatMetricValue(it.actual, def.format, client.currency, { compact: def.format === "currency" })}
                        </div>
                        <div className="text-[10.5px] leading-tight text-subtle">
                          {it.target === null
                            ? EMPTY
                            : `of ${formatMetricValue(it.target, def.format, client.currency, { compact: def.format === "currency" })}`}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-2 text-[11px] text-subtle">
          Green = beat the target, red = missed (direction-aware: lower is better for CPA and nCAC). Spend is neutral. Current month is not
          coloured until it closes.
        </p>
      </Card>
    </>
  );
}

export default function TargetsPage({ searchParams }: PageProps<"/targets">) {
  return (
    <Suspense
      fallback={
        <>
          <PageTitle title="Targets" />
          <div className="grid gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-56 rounded-xl" />
            ))}
          </div>
        </>
      }
    >
      <TargetsContent searchParams={searchParams} />
    </Suspense>
  );
}
