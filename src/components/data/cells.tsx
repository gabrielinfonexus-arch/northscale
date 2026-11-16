"use client";
import { ArrowDown, ArrowUp, CircleCheck, CircleX, Eye } from "lucide-react";
import { compareToTarget, compareValues, computeMetric, getMetric, type Comparison, type Tone, type Totals } from "@/lib/metrics";
import { EMPTY, formatDeltaPct, formatMetricValue } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CreativeBadge } from "@/server/data/types";

export const toneBg: Record<Tone, string> = { good: "bg-good-bg", bad: "bg-bad-bg", neutral: "" };
export const toneText: Record<Tone, string> = { good: "text-good", bad: "text-bad", neutral: "text-muted" };

export function metricValue(metric: string, totals: Totals | null | undefined): number | null {
  if (!totals) return null;
  return computeMetric(metric, totals);
}

export function shareValue(metric: string, totals: Totals, grand: Totals): number | null {
  const v = totals[metric as keyof Totals];
  const g = grand[metric as keyof Totals];
  if (v === null || v === undefined || !g) return null;
  return v / g;
}

export function cmp(metric: string, cur: Totals, prev: Totals | null | undefined, threshold: number): Comparison {
  return compareValues(getMetric(metric).direction, metricValue(metric, cur), prev ? metricValue(metric, prev) : null, threshold);
}

export function vsTarget(metric: string, cur: Totals, target: Record<string, number> | undefined, threshold: number): Comparison | null {
  if (!target || target[metric] === undefined) return null;
  return compareToTarget(metric, metricValue(metric, cur), target[metric], threshold);
}

export function Delta({ c, currency, className }: { c: Comparison; currency: string; className?: string }) {
  if (c.deltaPct === null) return <span className={cn("text-[11px] text-subtle", className)}>{EMPTY}</span>;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", toneText[c.tone], className)}>
      {c.arrow === "up" ? <ArrowUp className="size-3" /> : c.arrow === "down" ? <ArrowDown className="size-3" /> : null}
      {formatDeltaPct(c.deltaPct, currency)}
    </span>
  );
}

/** Hover text for a cell: current, comparison, delta (and target). */
export function cellTitle(
  metric: string,
  c: Comparison | null,
  t: Comparison | null,
  currency: string,
  unavailable?: string,
): string | undefined {
  const def = getMetric(metric);
  const parts: string[] = [];
  if (c && c.current === null && unavailable) return unavailable;
  if (c && c.previous !== null)
    parts.push(
      `Comparison: ${formatMetricValue(c.previous, def.format, currency)} (${c.deltaPct === null ? EMPTY : `${c.deltaPct > 0 ? "+" : ""}${c.deltaPct.toFixed(1)}%`})`,
    );
  if (t && t.previous !== null)
    parts.push(
      `Target: ${formatMetricValue(t.previous, def.format, currency)} (${t.deltaPct === null ? EMPTY : `${t.deltaPct > 0 ? "+" : ""}${t.deltaPct.toFixed(1)}%`})`,
    );
  return parts.length ? parts.join("\n") : undefined;
}

const BADGE: Record<CreativeBadge, { label: string; cls: string; Icon: typeof CircleCheck }> = {
  winner: { label: "Winner", cls: "bg-good-bg text-good", Icon: CircleCheck },
  watch: { label: "Watch", cls: "bg-warn-bg text-warn", Icon: Eye },
  cut: { label: "Cut", cls: "bg-bad-bg text-bad", Icon: CircleX },
};

export function VerdictBadge({ badge }: { badge: CreativeBadge | null | undefined }) {
  if (!badge) return <span className="text-subtle">{EMPTY}</span>;
  const b = BADGE[badge];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", b.cls)}>
      <b.Icon className="size-3" />
      {b.label}
    </span>
  );
}
