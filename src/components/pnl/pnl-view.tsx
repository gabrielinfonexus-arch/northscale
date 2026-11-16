"use client";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Tooltip as Tip } from "@/components/ui/tooltip";
import { Delta } from "@/components/data/cells";
import { compareValues, type MetricDirection } from "@/lib/metrics";
import { EMPTY, formatMetricValue } from "@/lib/format";
import { pct, type PnlLines } from "@/lib/pnl";
import { PLATFORM_LABEL } from "@/components/shell/platform";
import type { PnlModel } from "@/server/pnl";
import { cn } from "@/lib/utils";

interface LineDef {
  key: string;
  label: string;
  /** shown as a deduction (−) */
  cost?: boolean;
  /** subtotal row */
  total?: boolean;
  dir: MetricDirection;
  margin?: boolean;
  help: string;
}

function lines(platforms: string[]): LineDef[] {
  return [
    { key: "grossSales", label: "Gross sales", dir: "up", help: "Line items × price, before discounts (Shopify)." },
    { key: "discounts", label: "Discounts", cost: true, dir: "down", help: "Discount codes and automatic discounts." },
    { key: "refunds", label: "Refunds", cost: true, dir: "down", help: "Booked on the refund date." },
    { key: "netSales", label: "Net sales", total: true, dir: "up", help: "Gross sales − discounts − refunds." },
    { key: "otherRevenue", label: "Other revenue", dir: "up", help: "Manual, CSV and webhook revenue (Amazon, marketplaces…)." },
    { key: "totalRevenue", label: "Total revenue", total: true, dir: "up", help: "Net sales + other revenue." },
    {
      key: "cogs",
      label: "COGS",
      cost: true,
      dir: "down",
      help: "Unit cost × quantity: manual override → Shopify unit cost → default margin.",
    },
    { key: "grossProfit", label: "Gross profit", total: true, dir: "up", margin: true, help: "Total revenue − COGS." },
    { key: "shippingCost", label: "Shipping cost", cost: true, dir: "down", help: "Orders × cost per order + % of net sales (Costs tab)." },
    { key: "paymentFees", label: "Payment fees", cost: true, dir: "down", help: "From Shopify transactions, or the % in the Costs tab." },
    { key: "variableCosts", label: "Variable costs", cost: true, dir: "down", help: "Per-order and % of revenue items (Costs tab)." },
    {
      key: "contributionBeforeAds",
      label: "Contribution before ads",
      total: true,
      dir: "up",
      margin: true,
      help: "Gross profit − shipping − fees − variable costs.",
    },
    ...platforms.map((p) => ({
      key: `ad:${p}`,
      label: `${PLATFORM_LABEL[p] ?? p} ad spend`,
      cost: true,
      dir: "neutral" as const,
      help: `Spend on ${PLATFORM_LABEL[p] ?? p}, converted to the reporting currency.`,
    })),
    {
      key: "contributionMargin",
      label: "Contribution margin",
      total: true,
      dir: "up",
      margin: true,
      help: "Contribution before ads − ad spend.",
    },
    { key: "fixedCosts", label: "Fixed costs", cost: true, dir: "down", help: "Monthly fixed costs spread per day (Costs tab)." },
    { key: "netProfit", label: "Net profit", total: true, dir: "up", margin: true, help: "Contribution margin − fixed costs." },
  ];
}

function val(l: PnlLines, key: string): number {
  if (key.startsWith("ad:")) return l.adSpend[key.slice(3)] ?? 0;
  return (l as unknown as Record<string, number>)[key] ?? 0;
}

export function PnlView({ model, threshold, compareLabel }: { model: PnlModel; threshold: number; compareLabel: string | null }) {
  const cur = model.currency;
  const t = model.total;
  const c = model.totalCompare;
  const rows = lines(model.platforms);
  const fmt = (v: number, compact = false) => formatMetricValue(v, "currency", cur, { compact });

  const kpis: { label: string; key: string; dir: MetricDirection; margin?: boolean }[] = [
    { label: "Total revenue", key: "totalRevenue", dir: "up" },
    { label: "Gross profit", key: "grossProfit", dir: "up", margin: true },
    { label: "Ad spend", key: "adSpendTotal", dir: "neutral" },
    { label: "Contribution margin", key: "contributionMargin", dir: "up", margin: true },
    { label: "Net profit", key: "netProfit", dir: "up", margin: true },
  ];

  // waterfall: running total from revenue down to net profit
  const steps: { name: string; from: number; to: number; kind: "total" | "cost" }[] = [];
  let run = t.totalRevenue;
  steps.push({ name: "Revenue", from: 0, to: run, kind: "total" });
  const deduct = (name: string, v: number) => {
    steps.push({ name, from: run, to: run - v, kind: "cost" });
    run -= v;
  };
  deduct("COGS", t.cogs);
  deduct("Shipping", t.shippingCost);
  deduct("Fees", t.paymentFees);
  if (t.variableCosts) deduct("Variable", t.variableCosts);
  for (const p of model.platforms) deduct(PLATFORM_LABEL[p] ?? p, t.adSpend[p] ?? 0);
  steps.push({ name: "Contribution", from: 0, to: t.contributionMargin, kind: "total" });
  run = t.contributionMargin;
  if (t.fixedCosts) deduct("Fixed", t.fixedCosts);
  steps.push({ name: "Net profit", from: 0, to: t.netProfit, kind: "total" });
  const wf = steps.map((s) => ({
    ...s,
    base: Math.min(s.from, s.to),
    height: Math.abs(s.to - s.from),
    signed: s.kind === "cost" ? -(s.from - s.to) : s.to,
  }));

  return (
    <div className="flex flex-col gap-4">
      {model.missingCogsOrders > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-border bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {model.missingCogsOrders.toLocaleString()} orders contain products without a unit cost in Shopify — their COGS uses the default
          margin. Set costs in the Costs tab for an exact P&amp;L.
        </div>
      )}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="pnl-kpis">
        {kpis.map((k) => {
          const v = (t as unknown as Record<string, number>)[k.key];
          const p = c ? (c as unknown as Record<string, number>)[k.key] : null;
          const cmp = compareValues(k.dir, v, p, threshold);
          return (
            <Card key={k.key} className="px-3.5 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{k.label}</div>
              <div className={cn("num mt-1 text-[21px] font-semibold", v < 0 && "text-bad")}>{fmt(v)}</div>
              <div className="num flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                <Delta c={cmp} currency={cur} />
                {k.margin && <span>{formatMetricValue(pct(v, t.totalRevenue), "percent", cur)} of revenue</span>}
              </div>
            </Card>
          );
        })}
      </section>

      <Card className="p-4" data-testid="pnl-waterfall">
        <div className="mb-2 flex items-center gap-4 text-[13px]">
          <h2 className="font-semibold">From revenue to profit</h2>
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <span className="size-2.5 rounded-sm" style={{ background: "var(--series-1)" }} /> Totals
          </span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <span className="size-2.5 rounded-sm" style={{ background: "var(--bad)", opacity: 0.7 }} /> Costs
          </span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={wf} margin={{ top: 20, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: "var(--muted)" }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              interval={0}
            />
            <YAxis
              width={76}
              tick={{ fontSize: 11, fill: "var(--muted)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmt(v, true)}
            />
            <Tooltip
              cursor={{ fill: "var(--accent)" }}
              contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              formatter={(_v, _n, item) => [fmt((item.payload as { signed: number }).signed), (item.payload as { name: string }).name]}
            />
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="height" stackId="w" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {wf.map((s, i) => (
                <Cell key={i} fill={s.kind === "total" ? "var(--series-1)" : "var(--bad)"} fillOpacity={s.kind === "total" ? 1 : 0.7} />
              ))}
              <LabelList
                dataKey="signed"
                position="top"
                style={{ fontSize: 10.5, fill: "var(--muted)" }}
                formatter={(v: unknown) => (typeof v === "number" ? fmt(v, true) : "")}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card className="overflow-hidden">
        <div className="scroll-thin overflow-x-auto">
          <table className="num w-full border-separate border-spacing-0 text-[12.5px]" data-testid="pnl-table">
            <thead>
              <tr className="text-[10.5px] uppercase tracking-wide text-subtle">
                <th className="sticky left-0 z-10 min-w-[200px] border-b border-border bg-surface px-4 py-2 text-left font-medium">Line</th>
                {model.periods.length > 1 &&
                  model.periods.map((p) => (
                    <th key={p.bucket} className="whitespace-nowrap border-b border-border px-3 py-2 text-right font-medium">
                      {p.label}
                    </th>
                  ))}
                <th className="whitespace-nowrap border-b border-l border-border bg-surface-2 px-3 py-2 text-right font-medium">Total</th>
                {c && (
                  <th className="whitespace-nowrap border-b border-border bg-surface-2 px-3 py-2 text-right font-medium">
                    {compareLabel ?? "Comparison"}
                  </th>
                )}
                {c && <th className="border-b border-border bg-surface-2 px-3 py-2 text-right font-medium">Δ</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tv = val(t, r.key);
                const cv = c ? val(c, r.key) : null;
                const cmp = compareValues(r.dir, tv, cv, threshold);
                const show = (v: number) => (r.cost ? (v === 0 ? fmt(0) : `−${fmt(Math.abs(v))}`) : fmt(v));
                return (
                  <tr key={r.key} className={cn(r.total && "font-semibold", r.key === "netProfit" && "bg-surface-2")}>
                    <td
                      className={cn(
                        "sticky left-0 z-10 border-b border-border bg-surface px-4 py-2 text-left",
                        r.cost && "pl-7 font-normal text-zinc-600 dark:text-zinc-400",
                        r.key === "netProfit" && "bg-surface-2",
                      )}
                    >
                      <Tip content={r.help}>
                        <span className="cursor-help">{r.label}</span>
                      </Tip>
                      {r.margin && (
                        <span className="ml-1.5 text-[11px] font-normal text-subtle">
                          {formatMetricValue(pct(tv, t.totalRevenue), "percent", cur)}
                        </span>
                      )}
                    </td>
                    {model.periods.length > 1 &&
                      model.periods.map((p) => {
                        const v = val(p.lines, r.key);
                        return (
                          <td
                            key={p.bucket}
                            className={cn("whitespace-nowrap border-b border-border px-3 py-2 text-right", r.total && v < 0 && "text-bad")}
                          >
                            {show(v)}
                          </td>
                        );
                      })}
                    <td
                      className={cn(
                        "whitespace-nowrap border-b border-l border-border bg-surface-2 px-3 py-2 text-right",
                        r.total && tv < 0 && "text-bad",
                      )}
                    >
                      {show(tv)}
                    </td>
                    {c && (
                      <td className="whitespace-nowrap border-b border-border bg-surface-2 px-3 py-2 text-right text-muted">
                        {cv === null ? EMPTY : show(cv)}
                      </td>
                    )}
                    {c && (
                      <td className="border-b border-border bg-surface-2 px-3 py-2 text-right">
                        <Delta c={cmp} currency={cur} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
