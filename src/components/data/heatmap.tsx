"use client";
import { computeMetric } from "@/lib/metrics";
import { formatMetricValue } from "@/lib/format";
import { DOW_LABELS } from "@/lib/periods";
import type { HeatmapChart } from "@/server/data/types";

const STEPS = ["var(--seq-0)", "var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)"];

/** Day of week × hour of day, one sequential hue (darker = higher value). */
export function Heatmap({ chart, currency, metric }: { chart: HeatmapChart; currency: string; metric: "roas" | "cpa" }) {
  const grid = new Map(chart.cells.map((c) => [`${c.dow}:${c.hour}`, computeMetric(metric, c.totals)]));
  const values = [...grid.values()].filter((v): v is number => v !== null).sort((a, b) => a - b);
  const q = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))] ?? 0;
  const cuts = [q(0.17), q(0.33), q(0.5), q(0.67), q(0.83)];
  const step = (v: number) => cuts.filter((c) => v >= c).length;
  const fmt = (v: number | null) => formatMetricValue(v, metric === "roas" ? "ratio" : "currency", currency);

  return (
    <div className="border-b border-border px-4 py-4" data-testid="heatmap">
      <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted">
        <span>{metric === "roas" ? "ROAS" : "CPA"} by day of week × hour</span>
        <span className="flex items-center gap-1 normal-case tracking-normal">
          {fmt(values[0] ?? null)}
          {STEPS.map((s) => (
            <span key={s} className="inline-block h-2.5 w-4 rounded-sm" style={{ background: s }} />
          ))}
          {fmt(values[values.length - 1] ?? null)}
        </span>
      </div>
      <div className="scroll-thin overflow-x-auto">
        <div className="grid min-w-[640px] gap-[2px]" style={{ gridTemplateColumns: "36px repeat(24, minmax(0, 1fr))" }}>
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center text-[10px] text-subtle">
              {h % 3 === 0 ? h : ""}
            </span>
          ))}
          {DOW_LABELS.map((d, dow) => (
            <div key={d} className="contents">
              <span className="pr-1 text-right text-[11px] leading-6 text-muted">{d}</span>
              {Array.from({ length: 24 }, (_, h) => {
                const v = grid.get(`${dow}:${h}`) ?? null;
                return (
                  <span
                    key={h}
                    title={`${d} ${String(h).padStart(2, "0")}:00 — ${metric.toUpperCase()} ${fmt(v)}`}
                    className="h-6 rounded-[3px]"
                    style={{ background: v === null ? "var(--accent)" : STEPS[step(v)] }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
