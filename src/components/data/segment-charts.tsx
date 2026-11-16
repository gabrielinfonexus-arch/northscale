"use client";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SegmentChart } from "@/server/data/types";
import { formatMetricValue } from "@/lib/format";

/**
 * Two small single-axis charts side by side (never a dual axis):
 * share of spend per segment, and efficiency (ROAS or CPA) per segment.
 */
export function SegmentCharts({ chart, currency, efficiency }: { chart: SegmentChart; currency: string; efficiency: "roas" | "cpa" }) {
  const data = chart.items.map((i) => ({ label: i.label, share: i.spendShare, eff: efficiency === "roas" ? i.roas : i.cpa }));
  const hasEff = data.some((d) => d.eff !== null && d.eff !== undefined);
  const height = Math.max(150, Math.min(320, data.length * 26 + 30));
  const panel = (title: string, key: "share" | "eff", fmt: (v: number) => string) => (
    <figure className="min-w-0 flex-1">
      <figcaption className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</figcaption>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }} barCategoryGap={4}>
          <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis
            type="category"
            dataKey="label"
            width={130}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ fill: "var(--accent)" }}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
            formatter={(v) => [typeof v === "number" ? fmt(v) : "—", title]}
          />
          <Bar
            dataKey={key}
            fill="var(--series-1)"
            radius={[0, 4, 4, 0]}
            maxBarSize={16}
            label={{
              position: "right",
              fontSize: 11,
              fill: "var(--muted)",
              formatter: (v: unknown) => (typeof v === "number" ? fmt(v) : ""),
            }}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
  return (
    <div className="flex flex-col gap-6 border-b border-border px-4 py-4 md:flex-row" data-testid="segment-charts">
      {panel("% of spend", "share", (v) => formatMetricValue(v, "percent", currency))}
      {hasEff &&
        panel(efficiency === "roas" ? "ROAS" : "CPA", "eff", (v) =>
          formatMetricValue(v, efficiency === "roas" ? "ratio" : "currency", currency),
        )}
    </div>
  );
}
