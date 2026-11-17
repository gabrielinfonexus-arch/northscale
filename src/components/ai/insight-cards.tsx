"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowRight, ArrowUp, ExternalLink, NotebookPen, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { generateInsightsNow, insightToNote, setInsightFeedback } from "@/server/insight-actions";

export interface InsightView {
  id: string;
  priority: "high" | "medium" | "low";
  title: string;
  whatChanged: string;
  likelyCause: string;
  action: string;
  metrics: { label: string; value: string; change: string }[];
  dataLink: string | null;
  feedback: string | null;
  hasNote: boolean;
}
export interface InsightRun {
  runId: string;
  label: string;
  insights: InsightView[];
}

const PRIORITY = {
  high: { label: "High priority", cls: "bg-bad-bg text-bad", Icon: ArrowUp },
  medium: { label: "Medium", cls: "bg-warn-bg text-warn", Icon: ArrowRight },
  low: { label: "Low", cls: "bg-accent text-muted", Icon: ArrowDown },
} as const;

function InsightCard({ x, canEdit }: { x: InsightView; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const p = PRIORITY[x.priority] ?? PRIORITY.medium;
  const act = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      router.refresh();
    });
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="insight-card">
      <div className="flex items-start gap-2">
        <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium", p.cls)}>
          <p.Icon className="size-3" aria-hidden />
          {p.label}
        </span>
        <h3 className="text-[14.5px] font-medium leading-snug">{x.title}</h3>
      </div>
      <dl className="grid gap-2 text-[13px] leading-relaxed">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wide text-subtle">What changed</dt>
          <dd>{x.whatChanged}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wide text-subtle">Likely cause</dt>
          <dd>{x.likelyCause}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wide text-subtle">Recommended action</dt>
          <dd>{x.action}</dd>
        </div>
      </dl>
      {!!x.metrics.length && (
        <div className="flex flex-wrap gap-2">
          {x.metrics.map((m, i) => (
            <div key={i} className="rounded-md border border-border px-2.5 py-1.5 text-[12px]">
              <div className="text-subtle">{m.label}</div>
              <div className="font-medium tabular-nums">{m.value}</div>
              {m.change && <div className="text-[11px] text-muted">{m.change}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        {x.dataLink && (
          <Button asChild variant="outline" size="sm">
            <Link href={x.dataLink}>
              <ExternalLink aria-hidden /> View data
            </Link>
          </Button>
        )}
        {canEdit && (
          <>
            <Button
              variant={x.feedback === "useful" ? "subtle" : "ghost"}
              size="sm"
              aria-pressed={x.feedback === "useful"}
              disabled={pending}
              onClick={() => act(() => setInsightFeedback(x.id, x.feedback === "useful" ? null : "useful"))}
            >
              <ThumbsUp aria-hidden /> Useful
            </Button>
            <Button
              variant={x.feedback === "not_useful" ? "subtle" : "ghost"}
              size="sm"
              aria-pressed={x.feedback === "not_useful"}
              disabled={pending}
              onClick={() => act(() => setInsightFeedback(x.id, x.feedback === "not_useful" ? null : "not_useful"))}
            >
              <ThumbsDown aria-hidden /> Not useful
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={pending || x.hasNote}
              onClick={() => act(() => insightToNote(x.id))}
            >
              <NotebookPen aria-hidden /> {x.hasNote ? "Saved as Chart Note" : "Turn into Chart Note"}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

export function GenerateInsightsButton({ clientId, disabled }: { clientId: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      {msg && (
        <span role="status" className="text-[12px] text-muted">
          {msg}
        </span>
      )}
      <Button
        size="sm"
        disabled={pending || disabled}
        onClick={() =>
          start(async () => {
            const r = await generateInsightsNow(clientId);
            setMsg(r.ok ? `${r.count} new insight${r.count === 1 ? "" : "s"}.` : r.error);
            router.refresh();
          })
        }
      >
        <Sparkles aria-hidden /> {pending ? "Analyzing…" : "Generate now"}
      </Button>
    </div>
  );
}

export function InsightRuns({ runs, canEdit }: { runs: InsightRun[]; canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      {runs.map((r) => (
        <section key={r.runId} aria-label={r.label}>
          <h2 className="mb-3 text-[13px] font-medium text-muted">{r.label}</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {r.insights.map((x) => (
              <InsightCard key={x.id} x={x} canEdit={canEdit} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
