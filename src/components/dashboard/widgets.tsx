"use client";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { computeMetric, getMetric, type Totals } from "@/lib/metrics";
import { EMPTY, formatMetricValue } from "@/lib/format";
import { formatShortDay, type Granularity } from "@/lib/periods";
import { STATUS_LABEL } from "@/lib/pacing";
import { PlatformDot, PLATFORM_LABEL } from "@/components/shell/platform";
import { Delta, cmp, VerdictBadge } from "@/components/data/cells";
import type { DashboardModel } from "@/server/data/dashboard";
import { cn } from "@/lib/utils";

const tooltipStyle = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 };
const axisTick = { fontSize: 11, fill: "var(--muted)" };

function tickFor(gran: Granularity) {
  return (v: string) => (gran === "day" || gran === "week" ? formatShortDay(v) : gran === "month" ? v.slice(0, 7) : v.slice(0, 4));
}

export function SpendByPlatform({ m }: { m: DashboardModel }) {
  const fmt = (v: number) => formatMetricValue(v, "currency", m.currency, { compact: true });
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={m.spendByPlatform} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="bucket"
          tickFormatter={tickFor(m.gran)}
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          minTickGap={24}
        />
        <YAxis width={76} tick={axisTick} tickLine={false} axisLine={false} tickFormatter={fmt} />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--accent)" }}
          labelFormatter={(l) => String(l)}
          formatter={(v, n) => [formatMetricValue(Number(v), "currency", m.currency), PLATFORM_LABEL[String(n)] ?? n]}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} formatter={(v) => PLATFORM_LABEL[String(v)] ?? v} />
        <Bar dataKey="META" stackId="s" fill="var(--series-1)" stroke="var(--surface)" strokeWidth={1} isAnimationActive={false} />
        <Bar
          dataKey="GOOGLE"
          stackId="s"
          fill="var(--series-2)"
          stroke="var(--surface)"
          strokeWidth={1}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

const CHANNEL_COLOR: Record<string, string> = {
  META: "var(--series-1)",
  GOOGLE: "var(--series-2)",
  EMAIL: "var(--series-3)",
  ORGANIC: "var(--series-4)",
  DIRECT: "var(--series-5)",
  OTHER: "var(--series-7)",
};

export function RevenueByChannel({ m }: { m: DashboardModel }) {
  const total = m.revenueByChannel.reduce((s, c) => s + c.revenue, 0);
  if (!total) return <Empty text="Connect Shopify to see revenue by channel." />;
  return (
    <div className="flex h-full items-center gap-4">
      <div className="h-full min-h-[140px] w-[44%] min-w-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={m.revenueByChannel}
              dataKey="revenue"
              nameKey="label"
              innerRadius="58%"
              outerRadius="92%"
              paddingAngle={1}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {m.revenueByChannel.map((c) => (
                <Cell key={c.channel} fill={CHANNEL_COLOR[c.channel]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v, n) => [
                `${formatMetricValue(Number(v), "currency", m.currency)} (${formatMetricValue(Number(v) / total, "percent", m.currency)})`,
                n,
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="num flex flex-1 flex-col gap-1.5 text-[12.5px]">
        {m.revenueByChannel.map((c) => (
          <li key={c.channel} className="flex items-center gap-2">
            <span className="size-2.5 rounded-sm" style={{ background: CHANNEL_COLOR[c.channel] }} aria-hidden />
            <span className="flex-1">{c.label}</span>
            <span className="text-muted">{formatMetricValue(c.revenue / total, "percent", m.currency)}</span>
            <span className="w-24 text-right">{formatMetricValue(c.revenue, "currency", m.currency, { compact: true })}</span>
          </li>
        ))}
        <li className="mt-1 text-[11px] text-subtle">Shopify last-click attribution (UTMs / referrer)</li>
      </ul>
    </div>
  );
}

export function PlatformVsShopify({ m, threshold }: { m: DashboardModel; threshold: number }) {
  const gap = computeMetric("attributionDiscrepancy", m.total);
  const c = cmp("attributionDiscrepancy", m.total, m.totalCompare, threshold);
  const fmt = (v: number) => formatMetricValue(v, "currency", m.currency, { compact: true });
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="num flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]">
        <span>
          Platforms report <b>{formatMetricValue(m.total.platformRevenue ?? null, "currency", m.currency)}</b>
        </span>
        <span>
          Shopify net sales <b>{formatMetricValue(m.total.netSales ?? null, "currency", m.currency)}</b>
        </span>
        <span className={cn("font-medium", gap !== null && gap > 0.25 ? "text-warn" : "text-muted")}>
          Gap {gap === null ? EMPTY : `${gap > 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`} <Delta c={c} currency={m.currency} />
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={m.platformVsShopify} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="bucket"
              tickFormatter={tickFor(m.gran)}
              tick={axisTick}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              minTickGap={24}
            />
            <YAxis width={76} tick={axisTick} tickLine={false} axisLine={false} tickFormatter={fmt} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v, n) => [
                formatMetricValue(Number(v), "currency", m.currency),
                n === "platform" ? "Platform-reported" : "Shopify net sales",
              ]}
            />
            <Legend
              iconType="plainline"
              wrapperStyle={{ fontSize: 12 }}
              formatter={(v) => (v === "platform" ? "Platform-reported (Meta + Google)" : "Shopify net sales")}
            />
            <Line dataKey="platform" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="shopify" stroke="var(--series-3)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const FUNNEL_STEPS: { key: keyof Totals; label: string; rate?: string; cost?: string }[] = [
  { key: "impressions", label: "Impressions", cost: "cpm" },
  { key: "clicks", label: "Clicks", rate: "ctr", cost: "cpc" },
  { key: "addToCart", label: "Add to cart", rate: "clickToAtc", cost: "costPerAtc" },
  { key: "initiateCheckout", label: "Checkout", rate: "atcToIc", cost: "costPerIc" },
  { key: "purchases", label: "Purchases", rate: "icToPurchase", cost: "cpa" },
];

export function Funnel({ m, threshold }: { m: DashboardModel; threshold: number }) {
  const t = m.funnel.totals;
  const top = t.impressions ?? 0;
  if (!top) return <Empty text="No ad data with funnel events in this period." />;
  return (
    <div className="flex h-full flex-col gap-1.5" data-testid="funnel">
      {FUNNEL_STEPS.map((s, i) => {
        const v = t[s.key] ?? null;
        const width = v ? Math.max(4, Math.sqrt(v / top) * 100) : 0; // sqrt so later steps stay visible
        const rate = s.rate ? computeMetric(s.rate, t) : null;
        const cost = s.cost ? computeMetric(s.cost, t) : null;
        const rc = s.rate ? cmp(s.rate, t, m.funnel.compare, threshold) : null;
        const cc = s.cost ? cmp(s.cost, t, m.funnel.compare, threshold) : null;
        return (
          <div key={s.key} className="grid grid-cols-[88px_56px_1fr_150px] items-center gap-3 text-[12.5px]">
            <span className="text-muted">{s.label}</span>
            <span className="num text-right font-medium">{formatMetricValue(v, "number", m.currency, { compact: true })}</span>
            <div className="h-5 rounded bg-accent">
              <div className="h-full rounded" style={{ width: `${width}%`, background: "var(--series-1)", opacity: 1 - i * 0.12 }} />
            </div>
            <div className="num flex flex-col items-end leading-tight">
              {s.rate ? (
                <span>
                  {formatMetricValue(rate, "percent", m.currency)} {rc && <Delta c={rc} currency={m.currency} />}
                </span>
              ) : (
                <span className="text-subtle">&nbsp;</span>
              )}
              {s.cost && (
                <span className="text-[11px] text-muted">
                  {getMetric(s.cost).short} {formatMetricValue(cost, "currency", m.currency)} {cc && <Delta c={cc} currency={m.currency} />}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {m.funnel.accounts < m.funnel.accountsTotal && (
        <p className="mt-1 text-[11px] text-subtle">
          Based on {m.funnel.accounts} of {m.funnel.accountsTotal} ad accounts — the others don&apos;t report add-to-cart / checkout events.
        </p>
      )}
    </div>
  );
}

export function TopCampaigns({ m, dataHref }: { m: DashboardModel; dataHref: string }) {
  if (!m.topCampaigns.length) return <Empty text="No campaign data in this period." />;
  return (
    <MiniTable
      head={["Campaign", "Spend", "ROAS", "CPA"]}
      rows={m.topCampaigns.map((c) => [
        <span key="n" className="flex min-w-0 items-center gap-1.5">
          <PlatformDot platform={c.platform} />
          <span className="truncate" title={`${c.name} · ${c.account}`}>
            {c.name}
          </span>
        </span>,
        formatMetricValue(c.totals.spend ?? null, "currency", m.currency, { compact: true }),
        formatMetricValue(computeMetric("roas", c.totals), "ratio", m.currency),
        formatMetricValue(computeMetric("cpa", c.totals), "currency", m.currency),
      ])}
      footer={
        <Link href={dataHref} className="text-[11.5px] text-muted hover:text-foreground">
          All campaigns →
        </Link>
      }
    />
  );
}

export function TopCreatives({ m, dataHref }: { m: DashboardModel; dataHref: string }) {
  if (!m.topCreatives.length) return <Empty text="No creatives in this period." />;
  return (
    <MiniTable
      head={["Creative", "Spend", "ROAS", ""]}
      rows={m.topCreatives.map((c) => [
        <span key="n" className="flex min-w-0 items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- ad-platform CDN thumbnails */}
          {c.thumb ? <img src={c.thumb} alt="" className="size-7 shrink-0 rounded object-cover" loading="lazy" /> : null}
          <span className="truncate" title={c.name}>
            {c.name}
          </span>
        </span>,
        formatMetricValue(c.totals.spend ?? null, "currency", m.currency, { compact: true }),
        formatMetricValue(computeMetric("roas", c.totals), "ratio", m.currency),
        <VerdictBadge key="b" badge={c.badge} />,
      ])}
      footer={
        <Link href={dataHref} className="text-[11.5px] text-muted hover:text-foreground">
          All creatives →
        </Link>
      }
    />
  );
}

export function TopProducts({ m, dataHref }: { m: DashboardModel; dataHref: string }) {
  if (!m.topProducts.length) return <Empty text="Connect Shopify to see products." />;
  const total = m.topProducts.reduce((s, p) => s + p.revenue, 0);
  return (
    <MiniTable
      head={["Product", "Units", "Sales", "Share"]}
      rows={m.topProducts.map((p) => [
        <span key="n" className="truncate" title={p.title}>
          {p.title}
        </span>,
        formatMetricValue(p.units, "number", m.currency),
        formatMetricValue(p.revenue, "currency", m.currency, { compact: true }),
        formatMetricValue(total ? p.revenue / total : null, "percent", m.currency),
      ])}
      footer={
        <Link href={dataHref} className="text-[11.5px] text-muted hover:text-foreground">
          All products →
        </Link>
      }
    />
  );
}

export function PacingCard({ m, targetsHref }: { m: DashboardModel; targetsHref: string }) {
  const p = m.pacing;
  const items = p.groups.flatMap((g) => g.items.map((i) => ({ ...i, scope: g.scope })));
  if (!items.length)
    return (
      <Empty
        text={
          <>
            No targets for this month.{" "}
            <Link href={targetsHref} className="underline">
              Set targets
            </Link>
          </>
        }
      />
    );
  return (
    <div className="flex h-full flex-col gap-2.5" data-testid="pacing">
      <div className="text-[11.5px] text-muted">
        {p.daysElapsed} of {p.daysInMonth} days{p.through ? ` · through ${formatShortDay(p.through)}` : ""}
      </div>
      <ul className="scroll-thin flex flex-1 flex-col gap-2.5 overflow-auto pr-1">
        {items.slice(0, 8).map((i) => (
          <PaceRow key={`${i.scope}.${i.field}`} item={i} currency={m.currency} label={i.scope === "CLIENT" ? i.label : i.label} />
        ))}
      </ul>
      <Link href={targetsHref} className="text-[11.5px] text-muted hover:text-foreground">
        All targets →
      </Link>
    </div>
  );
}

export function PaceRow({
  item,
  currency,
  label,
}: {
  item: DashboardModel["pacing"]["groups"][number]["items"][number];
  currency: string;
  label: string;
}) {
  const def = getMetric(item.metric);
  const toneCls = { good: "text-good", bad: "text-bad", warn: "text-warn", neutral: "text-muted" }[item.tone];
  const barCls = { good: "bg-good", bad: "bg-bad", warn: "bg-warn", neutral: "bg-subtle" }[item.tone];
  const progress = item.progress ?? (item.actual !== null && item.target ? item.actual / item.target : null);
  const expectedPct = item.expectedToDate !== null ? Math.min(100, (item.expectedToDate / item.target) * 100) : null;
  return (
    <li className="flex flex-col gap-1 text-[12.5px]">
      <div className="flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className={cn("text-[11px] font-medium", toneCls)}>{STATUS_LABEL[item.status]}</span>
      </div>
      <div
        className="relative h-1.5 rounded-full bg-accent"
        role="progressbar"
        aria-valuenow={Math.round((progress ?? 0) * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={cn("h-full rounded-full", barCls)} style={{ width: `${Math.min(100, (progress ?? 0) * 100)}%` }} />
        {expectedPct !== null && (
          <span
            className="absolute -top-0.5 h-2.5 w-px bg-foreground/60"
            style={{ left: `${expectedPct}%` }}
            title="Where you should be today"
          />
        )}
      </div>
      <div className="num flex justify-between text-[11px] text-muted">
        <span>
          {formatMetricValue(item.actual, def.format, currency)} {item.progress !== null ? "so far" : "MTD"}
        </span>
        <span>
          {item.projection !== null && item.progress !== null
            ? `→ ${formatMetricValue(item.projection, def.format, currency, { compact: true })} · `
            : ""}
          target {formatMetricValue(item.target, def.format, currency, { compact: def.format === "currency" && item.target >= 10_000 })}
        </span>
      </div>
    </li>
  );
}

function MiniTable({ head, rows, footer }: { head: string[]; rows: React.ReactNode[][]; footer?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <table className="num w-full table-fixed text-[12.5px]">
        <thead>
          <tr className="text-[10.5px] uppercase tracking-wide text-subtle">
            {head.map((h, i) => (
              <th key={i} className={cn("pb-1.5 font-medium", i === 0 ? "w-[52%] text-left" : "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {r.map((c, j) => (
                <td key={j} className={cn("h-9 overflow-hidden", j === 0 ? "pr-2" : "text-right")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer && <div className="mt-auto pt-2">{footer}</div>}
    </div>
  );
}

function Empty({ text }: { text: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-center text-[12.5px] text-muted">{text}</div>;
}
