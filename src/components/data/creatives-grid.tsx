"use client";
import { useEffect, useState } from "react";
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMetricValue } from "@/lib/format";
import { formatShortDay } from "@/lib/periods";
import type { DataRow, DataTableModel } from "@/server/data/types";
import { metricValue, shareValue, VerdictBadge } from "./cells";

const STATS: { key: string; label: string; fmt: "currency" | "ratio" | "percent" }[] = [
  { key: "spend", label: "Spend", fmt: "currency" },
  { key: "roas", label: "ROAS", fmt: "ratio" },
  { key: "cpa", label: "CPA", fmt: "currency" },
  { key: "ctr", label: "CTR", fmt: "percent" },
  { key: "hookRate", label: "Hook", fmt: "percent" },
  { key: "holdRate", label: "Hold", fmt: "percent" },
];

export function CreativesGrid({ model, rows, onOpen }: { model: DataTableModel; rows: DataRow[]; onOpen: (r: DataRow) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5" data-testid="creatives-grid">
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onOpen(r)}
          className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface text-left transition-shadow hover:shadow-md"
        >
          <div className="relative aspect-[16/9] bg-accent">
            {/* eslint-disable-next-line @next/next/no-img-element -- ad-platform CDN thumbnails, arbitrary hosts */}
            {r.thumb && <img src={r.thumb} alt="" className="size-full object-cover" loading="lazy" />}
            <span className="absolute left-2 top-2">
              <VerdictBadge badge={r.badge} />
            </span>
            <span className="absolute right-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
              {r.text?.type}
            </span>
          </div>
          <div className="flex flex-1 flex-col gap-2 p-3">
            <div>
              <div className="truncate text-[13px] font-medium" title={r.label}>
                {r.label}
              </div>
              <div className="truncate text-[11px] text-muted">{r.text?.campaign}</div>
            </div>
            <dl className="num grid grid-cols-3 gap-x-2 gap-y-1.5 text-[12px]">
              {STATS.map((s) => (
                <div key={s.key}>
                  <dt className="text-[10px] uppercase tracking-wide text-subtle">{s.label}</dt>
                  <dd>{formatMetricValue(metricValue(s.key, r.totals), s.fmt, model.currency)}</dd>
                </div>
              ))}
            </dl>
            <div className="text-[11px] text-muted">
              {formatMetricValue(shareValue("spend", r.totals, model.total), "percent", model.currency)} of spend
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function CreativeDialog({
  row,
  model,
  clientId,
  range,
  onClose,
}: {
  row: DataRow | null;
  model: DataTableModel;
  clientId: string;
  range: { from: string; to: string };
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; series: { date: string; spend: number; roas: number | null }[] } | null>(null);
  const series = row && loaded?.id === row.id ? loaded.series : null;
  useEffect(() => {
    if (!row) return;
    const [conn, ad] = row.id.split(":");
    const p = new URLSearchParams({ client: clientId, conn, ad, from: range.from, to: range.to });
    let alive = true;
    fetch(`/api/data/ad-daily?${p}`)
      .then((r) => r.json())
      .then((j: { rows: { date: string; spend: number; value: number }[] }) => {
        if (alive)
          setLoaded({
            id: row.id,
            series: j.rows.map((x) => ({ date: x.date, spend: x.spend, roas: x.spend ? x.value / x.spend : null })),
          });
      })
      .catch(() => {
        if (alive) setLoaded({ id: row.id, series: [] });
      });
    return () => {
      alive = false;
    };
  }, [row, clientId, range.from, range.to]);

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        {row && (
          <div className="flex flex-col gap-4">
            <div>
              <DialogTitle className="pr-8 text-base font-semibold">{row.label}</DialogTitle>
              <DialogDescription className="text-xs text-muted">
                {row.text?.campaign} · {row.text?.account}
              </DialogDescription>
            </div>
            <div className="grid gap-4 md:grid-cols-[220px_1fr]">
              <div className="flex flex-col gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- ad-platform CDN thumbnails */}
                {row.thumb && <img src={row.thumb} alt="" className="aspect-square w-full rounded-lg object-cover" />}
                <VerdictBadge badge={row.badge} />
              </div>
              <div className="flex flex-col gap-3 text-[13px]">
                {row.text?.headline && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-subtle">Headline</div>
                    {row.text.headline}
                  </div>
                )}
                {row.text?.body && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-subtle">Primary text</div>
                    {row.text.body}
                  </div>
                )}
                {row.text?.landing && (
                  <div className="truncate">
                    <div className="text-[10px] uppercase tracking-wide text-subtle">Destination</div>
                    <a className="text-primary underline" href={row.text.landing} target="_blank" rel="noreferrer">
                      {row.text.landing}
                    </a>
                  </div>
                )}
                <dl className="num grid grid-cols-3 gap-2">
                  {STATS.map((s) => (
                    <div key={s.key} className="rounded-md bg-accent px-2 py-1.5">
                      <dt className="text-[10px] uppercase tracking-wide text-subtle">{s.label}</dt>
                      <dd className="font-medium">{formatMetricValue(metricValue(s.key, row.totals), s.fmt, model.currency)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {(["spend", "roas"] as const).map((k) => (
                <figure key={k}>
                  <figcaption className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                    Daily {k === "spend" ? "spend" : "ROAS"}
                  </figcaption>
                  {series === null ? (
                    <Skeleton className="h-40 w-full" />
                  ) : (
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                        <XAxis
                          dataKey="date"
                          tickFormatter={formatShortDay}
                          tick={{ fontSize: 10, fill: "var(--muted)" }}
                          tickLine={false}
                          axisLine={false}
                          minTickGap={24}
                        />
                        <YAxis
                          width={52}
                          tick={{ fontSize: 10, fill: "var(--muted)" }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v: number) =>
                            formatMetricValue(v, k === "spend" ? "currency" : "ratio", model.currency, { compact: true })
                          }
                        />
                        <Tooltip
                          contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                          labelFormatter={(l) => formatShortDay(String(l))}
                          formatter={(v) => [
                            typeof v === "number" ? formatMetricValue(v, k === "spend" ? "currency" : "ratio", model.currency) : "—",
                            k === "spend" ? "Spend" : "ROAS",
                          ]}
                        />
                        <Line dataKey={k} stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </figure>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
