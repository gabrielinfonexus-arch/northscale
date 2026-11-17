import type { Metadata } from "next";
import { Suspense } from "react";
import { PageTitle } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { GenerateInsightsButton, InsightRuns, type InsightRun } from "@/components/ai/insight-cards";
import { prisma } from "@/lib/db";
import { getPageContext } from "@/server/page-context";
import { aiConfigured, aiMockEnabled } from "@/server/ai/config";

export const metadata: Metadata = { title: "AI Insights" };

const CADENCE: Record<string, string> = { daily: "Daily insights", weekly: "Weekly summary", on_demand: "On demand" };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as Record<string, number>;
const day = (d: Date | null) => (d ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d) : "");

async function Content({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext(searchParams);
  const canEdit = ctx.user.role !== "CLIENT_VIEWER";
  const configured = aiConfigured();
  const header = (
    <PageTitle title="AI Insights">
      {ctx.client && canEdit && <GenerateInsightsButton clientId={ctx.client.id} disabled={!configured} />}
    </PageTitle>
  );
  if (!ctx.client)
    return (
      <>
        {header}
        <EmptyState title="No clients yet">Add a client to get insights.</EmptyState>
      </>
    );
  const rows = await prisma.aiInsight.findMany({ where: { clientId: ctx.client.id }, orderBy: { createdAt: "desc" }, take: 60 });
  const runs = new Map<string, InsightRun>();
  for (const r of rows) {
    const key = r.runId ?? r.id;
    if (!runs.has(key))
      runs.set(key, {
        runId: key,
        label: `${CADENCE[r.cadence] ?? r.cadence} · ${day(r.periodFrom)} – ${day(r.periodTo)} · generated ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ctx.client.timezone }).format(r.createdAt)}`,
        insights: [],
      });
    runs.get(key)!.insights.push({
      id: r.id,
      priority: (r.priority as "high" | "medium" | "low") ?? "medium",
      title: r.title,
      whatChanged: r.whatChanged,
      likelyCause: r.likelyCause,
      action: r.action,
      metrics: (r.metrics as { label: string; value: string; change: string }[]) ?? [],
      dataLink: r.dataLink,
      feedback: r.feedback,
      hasNote: !!r.noteId,
    });
  }
  const list = [...runs.values()].map((r) => ({
    ...r,
    insights: r.insights.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]),
  }));
  return (
    <>
      {header}
      <p className="mb-4 text-[13px] text-muted">
        For <span className="font-medium text-foreground">{ctx.client.name}</span>: generated every morning (last 7 days vs the 7 before)
        and every Monday (last week vs the week before), or on demand. Read-only — nothing is changed in your ad accounts.
      </p>
      {aiMockEnabled() && (
        <p className="mb-4 text-[12.5px] text-warn" data-testid="ai-mock">
          Simulated AI (AI_MOCK): cards are generated without calling the API.
        </p>
      )}
      {!configured && <p className="mb-4 text-[13px] text-warn">Set ANTHROPIC_API_KEY in the server environment to generate insights.</p>}
      {list.length ? (
        <InsightRuns runs={list} canEdit={canEdit} />
      ) : (
        <EmptyState title="No insights yet">The first ones arrive tomorrow morning — or click “Generate now”.</EmptyState>
      )}
    </>
  );
}

export default function AiInsightsPage({ searchParams }: PageProps<"/ai-insights">) {
  return (
    <Suspense
      fallback={
        <>
          <PageTitle title="AI Insights">
            <Skeleton className="h-7 w-32" />
          </PageTitle>
          <Skeleton className="h-96 w-full rounded-xl" />
        </>
      }
    >
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
