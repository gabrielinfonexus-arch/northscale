"use client";
import { useState } from "react";
import { GripVertical } from "lucide-react";
import { compareValues, computeMetric, getMetric, type Totals } from "@/lib/metrics";
import { EMPTY, formatMetricValue } from "@/lib/format";
import { Tooltip } from "@/components/ui/tooltip";
import { Delta } from "@/components/data/cells";
import { cn } from "@/lib/utils";

export const KPI_OPTIONS = [
  "totalRevenue",
  "spend",
  "mer",
  "amer",
  "ncac",
  "orders",
  "aov",
  "roas",
  "contributionMargin",
  "newCustomers",
  "netSales",
  "platformRevenue",
  "attributionDiscrepancy",
  "cpa",
  "newCustomerPct",
  "otherRevenue",
  "refunds",
  "grossMarginPct",
] as const;
export const DEFAULT_KPIS = KPI_OPTIONS.slice(0, 10) as unknown as string[];

/** Tiny inline sparkline (single series, no axes). */
function Sparkline({ values }: { values: (number | null)[] }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1]));
  if (pts.length < 2) return <div className="h-7" />;
  const xs = values.length - 1 || 1;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys),
    max = Math.max(...ys);
  const span = max - min || 1;
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${((i / xs) * 100).toFixed(2)},${(26 - ((v - min) / span) * 24).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      <path d={d} fill="none" stroke="var(--series-1)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function KpiCards({
  kpis,
  total,
  totalCompare,
  daily,
  currency,
  threshold,
  editing,
  onReorder,
}: {
  kpis: string[];
  total: Totals;
  totalCompare: Totals | null;
  daily: { date: string; totals: Totals }[];
  currency: string;
  threshold: number;
  editing: boolean;
  onReorder: (next: string[]) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  return (
    <div className="grid h-full grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="kpi-cards">
      {kpis.map((k) => {
        const def = getMetric(k);
        const value = computeMetric(k, total);
        const prev = totalCompare ? computeMetric(k, totalCompare) : null;
        const c = compareValues(def.direction, value, prev, threshold);
        return (
          <div
            key={k}
            draggable={editing}
            onDragStart={() => setDragging(k)}
            onDragOver={(e) => editing && e.preventDefault()}
            onDrop={() => {
              if (!dragging || dragging === k) return;
              const next = kpis.filter((x) => x !== dragging);
              next.splice(next.indexOf(k), 0, dragging);
              onReorder(next);
              setDragging(null);
            }}
            className={cn(
              "flex min-w-0 flex-col justify-between rounded-xl border border-border bg-surface px-3.5 pb-2 pt-3",
              editing && "cursor-grab",
              dragging === k && "opacity-50",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <Tooltip
                content={
                  <span>
                    <b>{def.label}</b> — {def.description}
                    <br />
                    Formula: {def.formula}
                  </span>
                }
              >
                <span className="cursor-help truncate text-[11px] font-medium uppercase tracking-wide text-muted">{def.label}</span>
              </Tooltip>
              {editing && <GripVertical className="size-3.5 shrink-0 text-subtle" />}
            </div>
            <div className="num mt-1 text-[22px] font-semibold leading-tight tracking-tight">
              {formatMetricValue(value, def.format, currency, { compact: Math.abs(value ?? 0) >= 1_000_000 })}
            </div>
            <div className="num flex items-center gap-1.5 text-[11px] text-muted">
              <Delta c={c} currency={currency} />
              <span className="truncate">
                vs {prev === null ? EMPTY : formatMetricValue(prev, def.format, currency, { compact: Math.abs(prev) >= 100_000 })}
              </span>
            </div>
            <Sparkline values={daily.map((d) => computeMetric(k, d.totals))} />
          </div>
        );
      })}
    </div>
  );
}
