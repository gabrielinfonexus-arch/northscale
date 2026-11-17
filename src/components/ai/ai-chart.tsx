"use client";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartSpec } from "@/lib/ai-display";

const COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];

function fmt(v: number, f: ChartSpec["format"], compact = false) {
  if (!Number.isFinite(v)) return "—";
  const nf = (o: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat("en-US", { notation: compact ? "compact" : "standard", ...o }).format(v);
  if (f === "percent") return `${(v * 100).toFixed(1)}%`;
  if (f === "ratio") return `${v.toFixed(2)}x`;
  if (f === "currency") return nf({ maximumFractionDigits: compact ? 1 : 2 });
  return nf({ maximumFractionDigits: compact ? 1 : 2 });
}

/** Chart the model asked for in a ```chart block. Data come straight from tool results. */
export function AiChart({ spec }: { spec: ChartSpec }) {
  const data = spec.x.map((x, i) => Object.fromEntries([["x", x], ...spec.series.map((s) => [s.name, s.data[i]])]));
  const common = (
    <>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
      <XAxis
        dataKey="x"
        tick={{ fontSize: 11, fill: "var(--muted)" }}
        tickLine={false}
        axisLine={{ stroke: "var(--border)" }}
        minTickGap={16}
      />
      <YAxis
        tick={{ fontSize: 11, fill: "var(--muted)" }}
        tickLine={false}
        axisLine={false}
        width={56}
        tickFormatter={(v: number) => fmt(v, spec.format, true)}
      />
      <Tooltip
        formatter={(v) => fmt(Number(v), spec.format)}
        contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
      />
      {spec.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
    </>
  );
  return (
    <figure className="my-3 rounded-lg border border-border bg-surface p-3" data-testid="ai-chart">
      {spec.title && <figcaption className="mb-2 text-[12.5px] font-medium">{spec.title}</figcaption>}
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === "bar" ? (
            <BarChart data={data}>
              {common}
              {spec.series.map((s, i) => (
                <Bar key={s.name} dataKey={s.name} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          ) : (
            <LineChart data={data}>
              {common}
              {spec.series.map((s, i) => (
                <Line key={s.name} dataKey={s.name} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={2} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
