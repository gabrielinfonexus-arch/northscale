"use client";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Plus } from "lucide-react";
import { computeMetric, getMetric } from "@/lib/metrics";
import { formatMetricValue } from "@/lib/format";
import { bucketStart, formatDay, formatShortDay, type Granularity } from "@/lib/periods";
import { NOTE_CATEGORY_MAP, type ChartNoteDTO } from "@/lib/notes";
import { NoteDot } from "@/components/notes/note-dialog";
import type { SeriesPoint } from "@/server/data/dashboard";

export const TREND_METRICS = [
  "totalRevenue",
  "spend",
  "mer",
  "amer",
  "ncac",
  "orders",
  "aov",
  "newCustomers",
  "roas",
  "platformRevenue",
  "netSales",
  "contributionMargin",
  "cpa",
  "purchases",
  "impressions",
  "clicks",
];

const COLORS = ["var(--series-1)", "var(--series-2)"];

interface Props {
  series: SeriesPoint[];
  gran: Granularity;
  currency: string;
  notes: ChartNoteDTO[];
  hasCompare: boolean;
  onAddNote: (date: string) => void;
  onEditNote: (n: ChartNoteDTO) => void;
}

export function TrendChart({ series, gran, currency, notes, hasCompare, onAddNote, onEditNote }: Props) {
  const [a, setA] = useState("totalRevenue");
  const [b, setB] = useState<string>("spend");
  const [openBucket, setOpenBucket] = useState<string | null>(null);

  const metrics = [a, ...(b && b !== a ? [b] : [])];
  const sameUnit = metrics.length === 2 && getMetric(metrics[0]).format === getMetric(metrics[1]).format;
  const panels: string[][] = metrics.length === 2 && !sameUnit ? [[metrics[0]], [metrics[1]]] : [metrics];

  const data = useMemo(
    () =>
      series.map((p) => {
        const row: Record<string, string | number | null> = { bucket: p.bucket, label: p.label, compareLabel: p.compareLabel };
        for (const m of b && b !== a ? [a, b] : [a]) {
          row[m] = computeMetric(m, p.totals);
          row[`${m}__cmp`] = p.compare ? computeMetric(m, p.compare) : null;
        }
        return row;
      }),
    [series, a, b],
  );

  const notesByBucket = useMemo(() => {
    const m = new Map<string, ChartNoteDTO[]>();
    for (const n of notes) {
      const k = bucketStart(n.date, gran);
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return m;
  }, [notes, gran]);

  const tick = (v: string) => (gran === "day" || gran === "week" ? formatShortDay(v) : gran === "month" ? v.slice(0, 7) : v.slice(0, 4));
  const height = panels.length === 2 ? 140 : 280;

  return (
    <div className="flex h-full flex-col gap-2" data-testid="trend-chart">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {[a, b].map((val, i) => (
          <label key={i} className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-4 rounded" style={{ background: COLORS[i] }} aria-hidden />
            <select
              aria-label={i === 0 ? "Primary metric" : "Secondary metric"}
              value={val}
              onChange={(e) => (i === 0 ? setA(e.target.value) : setB(e.target.value))}
              className="h-7 rounded-md border border-border bg-surface px-1.5 text-[12px]"
            >
              {i === 1 && <option value="">None</option>}
              {TREND_METRICS.map((m) => (
                <option key={m} value={m}>
                  {getMetric(m).label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {hasCompare && (
          <span className="flex items-center gap-1.5 text-muted">
            <svg width="16" height="4" aria-hidden>
              <line x1="0" y1="2" x2="16" y2="2" stroke="var(--muted)" strokeDasharray="3 3" strokeWidth="2" />
            </svg>
            Comparison period
          </span>
        )}
        <span className="ml-auto text-muted">Click the chart to add a note</span>
      </div>
      {panels.map((pm, pi) => (
        <ResponsiveContainer key={pm.join()} width="100%" height="100%" minHeight={height} className="min-h-0 flex-1">
          <LineChart
            data={data}
            syncId="trend"
            margin={{ top: 14, right: 12, bottom: 0, left: 0 }}
            onClick={(s) => {
              const label = (s as { activeLabel?: string | number }).activeLabel;
              if (label !== undefined && label !== null) onAddNote(String(label));
            }}
            className="cursor-crosshair"
          >
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="bucket"
              tickFormatter={tick}
              tick={{ fontSize: 11, fill: "var(--muted)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              minTickGap={28}
              hide={pi < panels.length - 1}
            />
            <YAxis
              width={76}
              tick={{ fontSize: 11, fill: "var(--muted)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatMetricValue(v, getMetric(pm[0]).format, currency, { compact: true })}
            />
            <Tooltip
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              labelFormatter={(l, payload) => {
                const p = payload?.[0]?.payload as { compareLabel?: string } | undefined;
                return `${formatDay(String(l))}${p?.compareLabel ? `  ·  vs ${formatDay(p.compareLabel)}` : ""}`;
              }}
              formatter={(v, name) => {
                const key = String(name).replace("__cmp", "");
                const def = getMetric(key);
                return [
                  typeof v === "number" ? formatMetricValue(v, def.format, currency) : "—",
                  `${def.label}${String(name).endsWith("__cmp") ? " (comparison)" : ""}`,
                ];
              }}
            />
            {[...notesByBucket.entries()].map(([bucket, list]) => (
              <ReferenceLine
                key={bucket}
                x={bucket}
                stroke={NOTE_CATEGORY_MAP[list[0].category].color}
                strokeDasharray="2 3"
                ifOverflow="hidden"
                label={
                  pi === 0
                    ? ({ viewBox }: { viewBox?: { x?: number; y?: number } }) => (
                        <g
                          transform={`translate(${viewBox?.x ?? 0},${(viewBox?.y ?? 0) - 6})`}
                          style={{ cursor: "pointer" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenBucket(openBucket === bucket ? null : bucket);
                          }}
                          role="button"
                          aria-label={`${list.length} note(s): ${list.map((n) => n.title).join(", ")}`}
                        >
                          <circle r={6} fill={NOTE_CATEGORY_MAP[list[0].category].color} stroke="var(--surface)" strokeWidth={2} />
                          {list.length > 1 && (
                            <text y={3} textAnchor="middle" fontSize={8} fill="#fff" fontWeight={700}>
                              {list.length}
                            </text>
                          )}
                        </g>
                      )
                    : undefined
                }
              />
            ))}
            {pm.map((m) => {
              const color = COLORS[metrics.indexOf(m)];
              return [
                hasCompare ? (
                  <Line
                    key={`${m}c`}
                    dataKey={`${m}__cmp`}
                    stroke={color}
                    strokeOpacity={0.45}
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ) : null,
                <Line
                  key={m}
                  dataKey={m}
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls
                />,
              ];
            })}
          </LineChart>
        </ResponsiveContainer>
      ))}
      {openBucket && notesByBucket.get(openBucket) && (
        <ul className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2 p-2 text-[12px]" data-testid="note-popover">
          {notesByBucket.get(openBucket)!.map((n) => (
            <li key={n.id} className="flex items-start gap-2">
              <NoteDot category={n.category} className="mt-1" />
              <button type="button" className="text-left hover:underline" onClick={() => onEditNote(n)}>
                <span className="font-medium">
                  {formatShortDay(n.date)} · {n.title}
                </span>
                {n.description ? <span className="text-muted"> — {n.description}</span> : null}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-muted hover:text-foreground"
              onClick={() => onAddNote(openBucket)}
            >
              <Plus className="size-3" /> Add note here
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
