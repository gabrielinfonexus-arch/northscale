import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { computeMetric, sumTotals, type Totals } from "@/lib/metrics";
import {
  bucketLabel,
  bucketsInRange,
  DOW_LABELS,
  eachDay,
  endOfMonth,
  formatRange,
  isoDow,
  type DateRange,
  type Granularity,
} from "@/lib/periods";
import { classifyCreative } from "@/lib/rules/creative-status";
import type { DataPlatform } from "@/lib/data-tabs";
import type { ColumnSpec, DataRow, DataTableModel, Notice } from "./types";
import * as S from "./sql";
import { formatMetricValue } from "@/lib/format";

export interface DataArgs {
  clientId: string;
  currency: string;
  newAudienceMinPct: number;
  conn: string[] | null;
  /** id → {name, platform} for labelling children */
  connections: Record<string, { name: string; platform: string }>;
  range: DateRange;
  compareRange: DateRange | null;
  gran: Granularity;
  platform: DataPlatform;
  tab: string;
  campaign: string | null;
}

// ───────────────────────── column presets ─────────────────────────
const m = (metric: string, header?: string): ColumnSpec => ({ id: metric, kind: "metric", metric, header });
const share = (of: string, header = "% of Spend"): ColumnSpec => ({ id: `share_${of}`, kind: "share", metric: of, shareOf: of, header });
const text = (id: string, header: string): ColumnSpec => ({ id, kind: "text", header });

const AD_ALL = [
  "spend",
  "purchaseValue",
  "clicks",
  "impressions",
  "purchases",
  "addToCart",
  "initiateCheckout",
  "results",
  "resultsValue",
  "roas",
  "cpa",
  "ctr",
  "cpc",
  "cpm",
  "cvr",
  "aovPlatform",
  "reach",
  "frequency",
  "linkClicks",
  "leads",
  "cpl",
  "costPerResult",
  "costPerAtc",
  "costPerIc",
  "clickToAtc",
  "atcToIc",
  "icToPurchase",
  "hookRate",
  "holdRate",
  "videoViews3s",
  "thruPlays",
];
const AD_CORE_META = [
  "spend",
  "purchaseValue",
  "clicks",
  "impressions",
  "purchases",
  "addToCart",
  "initiateCheckout",
  "results",
  "resultsValue",
];
const AD_CORE_GOOGLE = [
  "spend",
  "purchaseValue",
  "clicks",
  "impressions",
  "purchases",
  "roas",
  "cpa",
  "ctr",
  "cpc",
  "addToCart",
  "initiateCheckout",
];
const AD_SEGMENT = ["spend", "share_spend", "purchaseValue", "roas", "purchases", "cpa", "clicks", "ctr", "cpc", "cpm", "impressions"];
const BREAKDOWN_ALL = AD_ALL.filter((k) => !["hookRate", "holdRate", "videoViews3s", "thruPlays"].includes(k));

const SHOP_ALL = [
  "orders",
  "grossSales",
  "discounts",
  "refunds",
  "netSales",
  "aov",
  "newCustomers",
  "returningOrders",
  "newCustomerRevenue",
  "returningCustomerRevenue",
  "newCustomerPct",
  "cogs",
  "grossMarginPct",
  "shipping",
  "taxes",
  "refundRate",
];
const ALL_PLATFORMS = [
  "spend",
  "platformRevenue",
  "totalRevenue",
  "mer",
  "amer",
  "ncac",
  "orders",
  "aov",
  "newCustomers",
  "netSales",
  "otherRevenue",
  "roas",
  "attributionDiscrepancy",
  "contributionMargin",
  "purchases",
  "cpa",
  "newCustomerRevenue",
  "grossMarginPct",
  "breakevenRoas",
  "breakevenCpa",
];

// ───────────────────────── helpers ─────────────────────────
const metricCols = (keys: string[]) => keys.map((k) => (k.startsWith("share_") ? share(k.slice(6)) : m(k)));

function emptyTotals(): Totals {
  return {};
}

function groupSum<T>(rows: T[], key: (r: T) => string, totals: (r: T) => Totals): Map<string, Totals> {
  const acc = new Map<string, Totals[]>();
  for (const r of rows) {
    const k = key(r);
    const list = acc.get(k) ?? [];
    list.push(totals(r));
    acc.set(k, list);
  }
  return new Map([...acc].map(([k, v]) => [k, sumTotals(v)]));
}

function unavailableFor(platform: DataPlatform, breakdown: boolean): Record<string, string> {
  const u: Record<string, string> = {};
  if (platform === "google") {
    for (const k of ["reach", "frequency", "linkClicks"]) u[k] = "Google Ads does not report this metric.";
    for (const k of ["addToCart", "initiateCheckout", "costPerAtc", "costPerIc", "clickToAtc", "atcToIc", "icToPurchase"])
      u[k] = "No 'Add to cart' / 'Begin checkout' conversion action is set up in this Google Ads account.";
  }
  for (const k of ["hookRate", "holdRate", "videoViews3s", "thruPlays"])
    u[k] = breakdown ? "Video metrics are not available per breakdown." : "No video ads in these rows.";
  if (platform === "meta" || platform === "google") {
    u.leads = "No lead campaigns in these rows.";
    u.cpl = u.leads;
  }
  u.cogs = "Unit cost missing in Shopify for some products — add a manual override on the P&L page.";
  u.grossMarginPct = u.cogs;
  return u;
}

/** Monthly targets → per-row targets. Additive metrics are prorated by day; ratio metrics use the month's value. */
type TargetRow = Awaited<ReturnType<typeof S.targetsFor>>[number];
function makeTargetFn(targets: TargetRow[], platform: DataPlatform) {
  const plat = platform === "meta" ? "META" : platform === "google" ? "GOOGLE" : null;
  const byMonth = new Map<string, TargetRow>();
  for (const t of targets) if ((t.platform ?? null) === plat) byMonth.set(t.month.toISOString().slice(0, 7), t);
  if (byMonth.size === 0) return null;
  const additive: Record<string, keyof TargetRow> = plat
    ? { spend: "spend" }
    : platform === "shopify"
      ? { orders: "orders", newCustomers: "newCustomers" }
      : { spend: "spend", totalRevenue: "revenue", orders: "orders", newCustomers: "newCustomers" };
  const ratio: Record<string, keyof TargetRow> = plat
    ? { roas: "roas", cpa: "cpa" }
    : platform === "shopify"
      ? {}
      : { mer: "mer", ncac: "ncac" };

  return (days: string[] | null, monthOf: string): Record<string, number> => {
    const out: Record<string, number> = {};
    const mt = byMonth.get(monthOf.slice(0, 7));
    for (const [metric, field] of Object.entries(ratio)) {
      const v = mt?.[field];
      if (typeof v === "number") out[metric] = v;
    }
    if (days) {
      for (const [metric, field] of Object.entries(additive)) {
        let sum = 0;
        let any = false;
        for (const d of days) {
          const t = byMonth.get(d.slice(0, 7));
          const v = t?.[field];
          if (typeof v === "number") {
            any = true;
            sum += v / Number(endOfMonth(d).slice(8, 10));
          }
        }
        if (any) out[metric] = sum;
      }
    }
    return out;
  };
}

function daysOfBucket(bucket: string, g: Granularity, range: DateRange): string[] {
  const all = eachDay(range);
  if (g === "day") return [bucket];
  return all.filter((d) =>
    g === "week"
      ? d >= bucket && d < addDaysIso(bucket, 7)
      : g === "month"
        ? d.slice(0, 7) === bucket.slice(0, 7)
        : d.slice(0, 4) === bucket.slice(0, 4),
  );
}
function addDaysIso(s: string, n: number) {
  return new Date(Date.parse(s + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Time-bucket rows. The comparison is computed from a *daily* comparison series:
 * each bucket is compared with exactly the same days shifted by the comparison offset,
 * so partial weeks/months are never compared with full ones.
 */
function timeRows(
  a: DataArgs,
  cur: Map<string, Totals>,
  cmpDaily: Map<string, Totals> | null,
  children?: Map<string, DataRow[]>,
  targetFn?: ReturnType<typeof makeTargetFn>,
): DataRow[] {
  const buckets = bucketsInRange(a.range, a.gran);
  const offset = a.compareRange ? Math.round((Date.parse(a.compareRange.from) - Date.parse(a.range.from)) / 86_400_000) : 0;
  return buckets.map((b) => {
    const kids = children?.get(b) ?? [];
    const days = daysOfBucket(b, a.gran, a.range);
    let compare: Totals | null = null;
    if (cmpDaily) {
      const parts = days.map((d) => cmpDaily.get(addDaysIso(d, offset))).filter((x): x is Totals => !!x);
      compare = parts.length ? sumTotals(parts) : null;
    }
    return {
      id: b,
      label: bucketLabel(b, a.gran),
      sortKey: b,
      totals: cur.get(b) ?? emptyTotals(),
      compare,
      target: targetFn ? targetFn(days, b) : undefined,
      records: kids.length || undefined,
      children: kids.length ? kids : undefined,
    };
  });
}

function scopeOf(a: DataArgs, range: DateRange): S.Scope {
  return { clientId: a.clientId, currency: a.currency, conn: a.conn, from: range.from, to: range.to };
}

function baseModel(
  a: DataArgs,
  partial: Partial<DataTableModel> & Pick<DataTableModel, "columns" | "defaultVisible" | "rows" | "firstColumn">,
): DataTableModel {
  const total = partial.total ?? sumTotals(partial.rows.map((r) => r.totals));
  return {
    key: `${a.platform}.${a.tab}`,
    currency: a.currency,
    compareLabel: a.compareRange ? `vs ${formatRange(a.compareRange)}` : null,
    totalCompare: null,
    defaultSort: { id: "first", desc: false },
    unavailable: unavailableFor(a.platform, false),
    hasTargets: false,
    ...partial,
    total,
  };
}

// ───────────────────────── ad platforms ─────────────────────────

async function adCore(a: DataArgs, plat: S.AdPlatform, leadOnly: boolean): Promise<DataTableModel> {
  const f = { platform: plat, campaignId: a.campaign, leadOnly };
  const [cur, cmp, attributed, attributedCmp, targets] = await Promise.all([
    S.adByBucketCampaign(scopeOf(a, a.range), f, a.gran),
    a.compareRange ? S.adByBucketCampaign(scopeOf(a, a.compareRange), f, "day") : null,
    S.shopByChannel(scopeOf(a, a.range), a.gran),
    a.compareRange ? S.shopByChannel(scopeOf(a, a.compareRange), "day") : null,
    S.targetsFor(a.clientId, a.range.from, a.range.to),
  ]);
  const withAttr = (rows: S.AdRow[], attr: Awaited<ReturnType<typeof S.shopByChannel>> | null) => {
    const sums = groupSum(
      rows,
      (r) => r.bucket,
      (r) => S.pickTotals(r),
    );
    if (attr && !leadOnly && !a.campaign) {
      for (const r of attr)
        if (r.channel === plat) {
          const t = sums.get(r.bucket) ?? {};
          t.attributedRevenue = (t.attributedRevenue ?? 0) + r.revenue;
          sums.set(r.bucket, t);
        }
    }
    return sums;
  };
  const children = new Map<string, DataRow[]>();
  for (const r of cur) {
    const list = children.get(r.bucket) ?? [];
    list.push({
      id: `${r.bucket}:${r.connection_id}:${r.entity_id}`,
      label: r.entity_name,
      sub: a.connections[r.connection_id]?.name ?? null,
      totals: S.pickTotals(r),
    });
    children.set(r.bucket, list);
  }
  for (const list of children.values()) list.sort((x, y) => (y.totals.spend ?? 0) - (x.totals.spend ?? 0));
  const targetFn = leadOnly ? null : makeTargetFn(targets, a.platform);
  const rows = timeRows(a, withAttr(cur, attributed), cmp ? withAttr(cmp, attributedCmp) : null, children, targetFn ?? undefined);
  const visible = leadOnly
    ? ["spend", "leads", "cpl", "clicks", "ctr", "cpc", "cpm", "impressions", "results", "costPerResult"]
    : plat === "META"
      ? AD_CORE_META
      : AD_CORE_GOOGLE;
  const total = sumTotals(rows.map((r) => r.totals));
  return baseModel(a, {
    firstColumn: "Date",
    columns: metricCols([...new Set([...visible, ...AD_ALL, "attributedRevenue"])]),
    defaultVisible: visible,
    rows,
    total,
    totalCompare: a.compareRange ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
    totalTarget: targetFn ? targetFn(eachDay(a.range), a.range.to) : undefined,
    hasTargets: !!targetFn,
    notices:
      leadOnly && !rows.some((r) => (r.totals.leads ?? 0) > 0)
        ? [{ tone: "info", text: "No lead-generation campaigns in this account for the selected period." }]
        : undefined,
  });
}

async function adDayOfWeek(a: DataArgs, plat: S.AdPlatform | null): Promise<DataTableModel> {
  const load = async (range: DateRange) => {
    if (plat) {
      const rows = await S.adDaily(scopeOf(a, range), { platform: plat, campaignId: a.campaign });
      return rows.map((r) => ({ day: r.bucket, totals: S.pickTotals(r) }));
    }
    const daily = await blendedByBucket({ ...a, gran: "day" }, range);
    return [...daily].map(([day, totals]) => ({ day, totals }));
  };
  const [cur, cmp] = await Promise.all([load(a.range), a.compareRange ? load(a.compareRange) : null]);
  const byDow = (rows: { day: string; totals: Totals }[]) =>
    groupSum(
      rows,
      (r) => String(isoDow(r.day)),
      (r) => r.totals,
    );
  const c = byDow(cur),
    p = cmp ? byDow(cmp) : null;
  const rows: DataRow[] = DOW_LABELS.map((label, i) => ({
    id: String(i),
    label,
    sortKey: i,
    totals: c.get(String(i)) ?? {},
    compare: p?.get(String(i)) ?? null,
  }));
  const visible = plat
    ? ["spend", "share_spend", "purchaseValue", "roas", "purchases", "cpa", "ctr", "cvr"]
    : ["spend", "share_spend", "totalRevenue", "mer", "orders", "newCustomers", "ncac", "aov"];
  return baseModel(a, {
    firstColumn: "Day of week",
    columns: metricCols([...new Set([...visible, ...(plat ? AD_ALL : ALL_PLATFORMS)])]),
    defaultVisible: visible,
    rows,
    totalCompare: p ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
    chart: { kind: "segments", items: rows.map((r) => segItem(r, sumTotals(rows.map((x) => x.totals)))) },
  });
}

function segItem(r: DataRow, total: Totals) {
  return {
    label: r.label,
    spendShare: total.spend ? (r.totals.spend ?? 0) / total.spend : null,
    roas: computeMetric(r.totals.totalRevenue !== undefined && r.totals.purchaseValue === undefined ? "mer" : "roas", r.totals),
    cpa: computeMetric("cpa", r.totals),
  };
}

const BREAKDOWN_TAB: Record<string, { type: S.Breakdown; label: string }> = {
  age: { type: "AGE", label: "Age" },
  gender: { type: "GENDER", label: "Gender" },
  placements: { type: "PLACEMENT", label: "Placement" },
  countries: { type: "COUNTRY", label: "Country" },
  audience: { type: "AUDIENCE_TYPE", label: "Audience type" },
  device: { type: "DEVICE", label: "Device" },
  hour: { type: "HOUR", label: "Hour" },
};

const AUDIENCE_ORDER = ["New audience", "Engaged audience", "Existing customers"];
const AGE_ORDER = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+", "Undetermined"];

async function adBreakdownTab(a: DataArgs, plat: S.AdPlatform): Promise<DataTableModel> {
  const def = BREAKDOWN_TAB[a.tab];
  const f = { platform: plat, campaignId: a.campaign };
  const isHour = def.type === "HOUR";
  const [cur, cmp, heat, targets] = await Promise.all([
    S.adBreakdown(scopeOf(a, a.range), f, def.type),
    a.compareRange ? S.adBreakdown(scopeOf(a, a.compareRange), f, def.type) : null,
    isHour ? S.adBreakdown(scopeOf(a, a.range), f, def.type, true) : null,
    S.targetsFor(a.clientId, a.range.from, a.range.to),
  ]);
  const cmpMap = new Map((cmp ?? []).map((r) => [r.entity_id, S.pickTotals(r)]));
  const targetFn = makeTargetFn(targets, a.platform);
  const rowTarget = targetFn ? targetFn(null, a.range.to) : undefined;
  const label = (v: string) =>
    def.type === "HOUR"
      ? `${v}:00`
      : def.type === "GENDER"
        ? v[0].toUpperCase() + v.slice(1)
        : def.type === "DEVICE"
          ? v[0] + v.slice(1).toLowerCase()
          : v;
  const order = (v: string) =>
    def.type === "AUDIENCE_TYPE"
      ? AUDIENCE_ORDER.indexOf(v)
      : def.type === "AGE"
        ? AGE_ORDER.indexOf(v)
        : def.type === "HOUR"
          ? Number(v)
          : v;
  const rows: DataRow[] = cur.map((r) => ({
    id: r.entity_id,
    label: label(r.entity_id),
    sortKey: order(r.entity_id),
    totals: S.pickTotals(r),
    compare: cmp ? (cmpMap.get(r.entity_id) ?? null) : null,
    target: rowTarget,
  }));
  const total = sumTotals(rows.map((r) => r.totals));
  const notices: Notice[] = [];
  if (def.type === "AUDIENCE_TYPE") {
    if (rows.length === 0) {
      notices.push({
        tone: "info",
        text: "This ad account has no audience segments configured. In Meta Ads Manager → Advertising settings → Audience segments, define your 'Engaged audience' and 'Existing customers' (custom audiences / customer lists) to unlock this breakdown.",
      });
    } else {
      const newShare = (rows.find((r) => r.id === "New audience")?.totals.spend ?? 0) / (total.spend || 1);
      if (newShare < a.newAudienceMinPct / 100)
        notices.push({
          tone: "warn",
          text: `Only ${(newShare * 100).toFixed(1)}% of spend reached New audiences (threshold ${a.newAudienceMinPct}%). Prospecting may be cannibalising existing customers.`,
        });
    }
  }
  const hasSort = def.type === "AUDIENCE_TYPE" || def.type === "AGE" || def.type === "HOUR";
  return baseModel(a, {
    firstColumn: def.label,
    columns: metricCols([...new Set([...AD_SEGMENT, ...BREAKDOWN_ALL])]),
    defaultVisible:
      def.type === "AUDIENCE_TYPE" ? ["spend", "share_spend", "purchaseValue", "roas", "purchases", "cpa", "cpm", "ctr"] : AD_SEGMENT,
    rows,
    total,
    totalCompare: cmp ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
    totalTarget: rowTarget,
    hasTargets: !!rowTarget,
    defaultSort: hasSort ? { id: "first", desc: false } : { id: "spend", desc: true },
    unavailable: unavailableFor(a.platform, true),
    notices,
    chart: isHour
      ? { kind: "heatmap", cells: (heat ?? []).map((r) => ({ dow: r.dow ?? 0, hour: Number(r.entity_id), totals: S.pickTotals(r) })) }
      : {
          kind: "segments",
          items: [...rows]
            .sort((x, y) => (hasSort ? Number(x.sortKey) - Number(y.sortKey) : (y.totals.spend ?? 0) - (x.totals.spend ?? 0)))
            .slice(0, 12)
            .map((r) => segItem(r, total)),
        },
  });
}

const ENTITY_TAB: Record<string, { level: S.Level; label: string }> = {
  campaigns: { level: "CAMPAIGN", label: "Campaign" },
  adsets: { level: "ADSET", label: "Ad set" },
  ads: { level: "AD", label: "Ad" },
  keywords: { level: "KEYWORD", label: "Keyword" },
  "search-terms": { level: "SEARCH_TERM", label: "Search term" },
  creatives: { level: "AD", label: "Creative" },
};

const prettyStatus = (s: string | null) =>
  s
    ? s
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/^\w/, (c) => c.toUpperCase())
    : null;
const prettyType = (s: string | null) =>
  s
    ? ((
        {
          ADVANTAGE_PLUS_SHOPPING: "Advantage+ Shopping",
          PERFORMANCE_MAX: "Performance Max",
          DEMAND_GEN: "Demand Gen",
          DISPLAY: "Display",
          APP: "App",
          LOCAL: "Local",
          SMART: "Smart",
          MULTI_CHANNEL: "Multi-channel",
          HOTEL: "Hotel",
          TRAVEL: "Travel",
          VIDEO: "YouTube / Video",
          SEARCH: "Search",
          SHOPPING: "Shopping",
          CATALOG: "Catalog (DPA)",
          MANUAL: "Manual",
        } as Record<string, string>
      )[s] ?? s)
    : null;

async function adEntityTab(a: DataArgs, plat: S.AdPlatform): Promise<DataTableModel> {
  const def = ENTITY_TAB[a.tab];
  const f = { platform: plat, campaignId: a.campaign };
  const isCreatives = a.tab === "creatives";
  const [cur, cmp, accountSpend, targets] = await Promise.all([
    S.adByEntity(scopeOf(a, a.range), f, def.level),
    a.compareRange ? S.adByEntity(scopeOf(a, a.compareRange), f, def.level) : null,
    S.adTotalSpend(scopeOf(a, a.range), f),
    S.targetsFor(a.clientId, a.range.from, a.range.to),
  ]);
  const cmpMap = new Map((cmp ?? []).map((r) => [`${r.connection_id}:${r.entity_id}`, S.pickTotals(r)]));
  const targetFn = makeTargetFn(targets, a.platform);
  const rowTarget = targetFn ? targetFn(null, a.range.to) : undefined;

  let rows: DataRow[] = (isCreatives ? cur.filter((r) => r.thumb) : cur).map((r) => {
    const totals = S.pickTotals(r);
    return {
      id: `${r.connection_id}:${r.entity_id}`,
      label: r.entity_name,
      sub:
        def.level === "CAMPAIGN"
          ? a.connections[r.connection_id]?.name
          : def.level === "ADSET"
            ? r.campaign_name
            : def.level === "AD"
              ? r.adset_name
              : r.campaign_name,
      totals,
      compare: cmp ? (cmpMap.get(`${r.connection_id}:${r.entity_id}`) ?? null) : null,
      target: rowTarget,
      thumb: r.thumb,
      text: {
        status: prettyStatus(r.status),
        type:
          def.level === "CAMPAIGN"
            ? prettyType(r.campaign_type)
            : r.creative_type
              ? r.creative_type[0] + r.creative_type.slice(1).toLowerCase()
              : null,
        campaign: r.campaign_name,
        account: a.connections[r.connection_id]?.name ?? null,
        review: r.review,
        headline: r.headline,
        body: r.body,
        landing: r.landing_url,
        adId: r.entity_id,
      },
      badge:
        def.level === "AD"
          ? classifyCreative({
              spend: totals.spend ?? 0,
              purchases: totals.purchases ?? 0,
              purchaseValue: totals.purchaseValue ?? 0,
              accountSpend,
              targetCpa: rowTarget?.cpa,
              targetRoas: rowTarget?.roas,
            })
          : null,
    };
  });

  // Campaigns expand into their ad sets
  if (def.level === "CAMPAIGN") {
    const sets = await S.adByEntity(scopeOf(a, a.range), f, "ADSET");
    const byCampaign = new Map<string, DataRow[]>();
    for (const s of sets) {
      const k = `${s.connection_id}:${s.campaign_id}`;
      const list = byCampaign.get(k) ?? [];
      list.push({
        id: `${s.connection_id}:${s.entity_id}`,
        label: s.entity_name,
        totals: S.pickTotals(s),
        text: { status: prettyStatus(s.status) },
      });
      byCampaign.set(k, list);
    }
    rows = rows.map((r) => {
      const kids = byCampaign.get(r.id) ?? [];
      return { ...r, children: kids.length ? kids : undefined, records: kids.length || undefined };
    });
  }

  const textCols: ColumnSpec[] =
    def.level === "CAMPAIGN"
      ? [text("status", "Status"), text("type", "Type")]
      : def.level === "AD"
        ? [text("status", "Status"), text("type", "Format")]
        : def.level === "ADSET"
          ? [text("status", "Status")]
          : [];
  const visible = isCreatives
    ? ["thumb", "type", "spend", "share_spend", "roas", "cpa", "ctr", "hookRate", "holdRate", "badge"]
    : def.level === "KEYWORD" || def.level === "SEARCH_TERM"
      ? ["spend", "share_spend", "clicks", "ctr", "cpc", "purchases", "cpa", "purchaseValue", "roas", "impressions"]
      : [
          ...textCols.map((c) => c.id),
          "spend",
          "share_spend",
          "purchaseValue",
          "roas",
          "purchases",
          "cpa",
          "ctr",
          "cpc",
          "cpm",
          ...(def.level === "AD" ? ["badge"] : []),
        ];
  const cols: ColumnSpec[] = [
    ...(def.level === "AD" ? [{ id: "thumb", kind: "thumb" as const, header: "Preview" }] : []),
    ...textCols,
    ...metricCols([...new Set([...AD_SEGMENT, ...AD_ALL])]),
    ...(def.level === "AD" ? [{ id: "badge", kind: "badge" as const, header: "Verdict" }] : []),
  ];
  const notices: Notice[] = [];
  const rejected = rows.filter((r) => r.text?.review);
  if (rejected.length)
    notices.push({
      tone: "warn",
      text: `${rejected.length} ad(s) rejected: ${rejected.map((r) => `“${r.label}” — ${r.text?.review}`).join("; ")}`,
    });
  if (isCreatives && rowTarget)
    notices.push({
      tone: "info",
      text: `Verdicts: Winner = ≥5% of spend and ROAS ≥ target (${formatMetricValue(rowTarget.roas, "ratio", a.currency)}). Cut = CPA ≥ 2× target (${formatMetricValue(rowTarget.cpa, "currency", a.currency)}) after spending ≥ 2× target CPA. Watch = missing target with enough data.`,
    });

  return baseModel(a, {
    firstColumn: def.label,
    columns: cols,
    defaultVisible: visible,
    rows,
    total: { ...sumTotals(rows.map((r) => r.totals)) },
    totalCompare: cmp ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
    totalTarget: rowTarget,
    hasTargets: !!rowTarget,
    defaultSort: { id: "spend", desc: true },
    notices,
    view: isCreatives ? "creatives" : "table",
  });
}

async function adAttributeTab(a: DataArgs, plat: S.AdPlatform, attr: "landing" | "campaignType"): Promise<DataTableModel> {
  const f = { platform: plat, campaignId: a.campaign };
  const [cur, cmp] = await Promise.all([
    S.adByAttribute(scopeOf(a, a.range), f, attr),
    a.compareRange ? S.adByAttribute(scopeOf(a, a.compareRange), f, attr) : null,
  ]);
  const cmpMap = new Map((cmp ?? []).map((r) => [r.entity_id, S.pickTotals(r)]));
  const rows: DataRow[] = cur.map((r) => ({
    id: r.entity_id,
    label: attr === "campaignType" ? (prettyType(r.entity_id) ?? r.entity_id) : r.entity_id.replace(/^https?:\/\//, ""),
    sub: `${r.n} ${attr === "landing" ? "ads" : "campaigns"}`,
    totals: S.pickTotals(r),
    compare: cmp ? (cmpMap.get(r.entity_id) ?? null) : null,
  }));
  const total = sumTotals(rows.map((r) => r.totals));
  return baseModel(a, {
    firstColumn: attr === "landing" ? "Landing page" : "Campaign type",
    columns: metricCols([...new Set([...AD_SEGMENT, ...AD_ALL])]),
    defaultVisible: [...AD_SEGMENT.slice(0, 7), "cvr"],
    rows,
    total,
    totalCompare: cmp ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
    defaultSort: { id: "spend", desc: true },
    chart: attr === "campaignType" ? { kind: "segments", items: rows.map((r) => segItem(r, total)) } : undefined,
  });
}

// ───────────────────────── commerce & blended ─────────────────────────

function shopTotals(r: Record<string, unknown>): Totals {
  return S.pickTotals(r, S.SHOP_COLS);
}

async function shopifyCore(a: DataArgs, mode: "core" | "new-vs-returning"): Promise<DataTableModel> {
  const [cur, cmp, targets] = await Promise.all([
    S.shopByBucket(scopeOf(a, a.range), a.gran),
    a.compareRange ? S.shopByBucket(scopeOf(a, a.compareRange), "day") : null,
    S.targetsFor(a.clientId, a.range.from, a.range.to),
  ]);
  const children = new Map<string, DataRow[]>();
  const stores = new Set(cur.map((r) => r.connection_id));
  if (stores.size > 1 || mode === "core") {
    for (const r of cur) {
      const list = children.get(r.bucket) ?? [];
      list.push({ id: `${r.bucket}:${r.connection_id}`, label: a.connections[r.connection_id]?.name ?? "Store", totals: shopTotals(r) });
      children.set(r.bucket, list);
    }
  }
  const targetFn = makeTargetFn(targets, "shopify");
  const rows = timeRows(
    a,
    groupSum(cur, (r) => r.bucket, shopTotals),
    cmp ? groupSum(cmp, (r) => r.bucket, shopTotals) : null,
    children,
    targetFn ?? undefined,
  );
  const visible =
    mode === "core"
      ? ["orders", "grossSales", "discounts", "refunds", "netSales", "aov", "newCustomers", "returningOrders", "cogs"]
      : ["orders", "newCustomers", "returningOrders", "newCustomerPct", "newCustomerRevenue", "returningCustomerRevenue", "aov"];
  return baseModel(a, {
    firstColumn: "Date",
    columns: metricCols([...new Set([...visible, ...SHOP_ALL])]),
    defaultVisible: visible,
    rows,
    totalCompare: cmp ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
    totalTarget: targetFn ? targetFn(eachDay(a.range), a.range.to) : undefined,
    hasTargets: !!targetFn,
  });
}

async function shopifyList(a: DataArgs): Promise<DataTableModel> {
  const sc = scopeOf(a, a.range);
  const cc = a.compareRange ? scopeOf(a, a.compareRange) : null;
  if (a.tab === "products") {
    const [cur, cmp] = await Promise.all([S.shopProducts(sc), cc ? S.shopProducts(cc) : null]);
    const t = (r: Awaited<ReturnType<typeof S.shopProducts>>[number]): Totals => ({
      units: r.units,
      orders: r.orders,
      grossSales: r.gross,
      netSales: r.gross,
      cogs: r.missing_cost > 0 ? null : r.cogs,
    });
    const cmpMap = new Map((cmp ?? []).map((r) => [r.id, t(r)]));
    const rows = cur.map((r) => ({ id: r.id, label: r.title, totals: t(r), compare: cc ? (cmpMap.get(r.id) ?? null) : null }));
    return baseModel(a, {
      firstColumn: "Product",
      columns: [...metricCols(["units", "orders", "grossSales", "share_grossSales", "cogs", "grossMarginPct"])].map((c) =>
        c.kind === "share" ? { ...c, header: "% of Sales" } : c,
      ),
      defaultVisible: ["units", "orders", "grossSales", "share_grossSales", "cogs", "grossMarginPct"],
      rows,
      totalCompare: cc ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
      defaultSort: { id: "grossSales", desc: true },
    });
  }
  if (a.tab === "discount-codes") {
    const [cur, cmp] = await Promise.all([S.shopDiscountCodes(sc), cc ? S.shopDiscountCodes(cc) : null]);
    const t = (r: Awaited<ReturnType<typeof S.shopDiscountCodes>>[number]): Totals => ({
      orders: r.orders,
      grossSales: r.gross,
      discounts: r.discounts,
      newCustomers: r.new_customers,
      netSales: r.gross - r.discounts,
    });
    const cmpMap = new Map((cmp ?? []).map((r) => [r.code, t(r)]));
    const rows = cur.map((r) => ({ id: r.code, label: r.code, totals: t(r), compare: cc ? (cmpMap.get(r.code) ?? null) : null }));
    return baseModel(a, {
      firstColumn: "Discount code",
      columns: metricCols(["orders", "share_orders", "grossSales", "discounts", "netSales", "aov", "newCustomers", "newCustomerPct"]).map(
        (c) => (c.kind === "share" ? { ...c, header: "% of Orders" } : c),
      ),
      defaultVisible: ["orders", "share_orders", "grossSales", "discounts", "aov", "newCustomers", "newCustomerPct"],
      rows,
      totalCompare: cc ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
      defaultSort: { id: "orders", desc: true },
    });
  }
  if (a.tab === "channels") {
    const [cur, cmp] = await Promise.all([S.shopByChannel(sc, null), cc ? S.shopByChannel(cc, null) : null]);
    const agg = (rows: Awaited<ReturnType<typeof S.shopByChannel>>) => {
      const mp = new Map<string, Totals & { first: number }>();
      for (const r of rows) {
        const x = mp.get(r.channel) ?? { attributedRevenue: 0, orders: 0, newCustomers: 0, grossSales: 0, discounts: 0, first: 0 };
        x.attributedRevenue! += r.revenue;
        x.orders! += r.orders;
        x.newCustomers! += r.new_customers;
        x.grossSales! += r.gross;
        x.discounts! += r.discounts;
        x.first += r.first_revenue;
        mp.set(r.channel, x);
      }
      return mp;
    };
    const c = agg(cur),
      p = cmp ? agg(cmp) : null;
    const LABEL: Record<string, string> = {
      META: "Meta (paid social)",
      GOOGLE: "Google (cpc)",
      EMAIL: "Email",
      ORGANIC: "Organic search",
      DIRECT: "Direct",
      OTHER: "Other",
    };
    const rows: DataRow[] = [...c].map(([ch, t]) => ({
      id: ch,
      label: LABEL[ch] ?? ch,
      totals: t,
      compare: p?.get(ch) ?? null,
      text: { firstClick: formatMetricValue(t.first, "currency", a.currency) },
    }));
    const total = sumTotals(rows.map((r) => r.totals));
    return baseModel(a, {
      firstColumn: "Channel (last click)",
      columns: [
        ...metricCols(["attributedRevenue", "share_attributedRevenue", "orders", "aov", "newCustomers", "newCustomerPct"]).map((col) =>
          col.kind === "share" ? { ...col, header: "% of Revenue" } : col,
        ),
        text("firstClick", "First-click revenue"),
      ],
      defaultVisible: ["attributedRevenue", "share_attributedRevenue", "firstClick", "orders", "aov", "newCustomers", "newCustomerPct"],
      rows,
      total,
      totalCompare: p ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
      defaultSort: { id: "attributedRevenue", desc: true },
      chart: {
        kind: "segments",
        items: rows.map((r) => ({
          label: r.label,
          spendShare: total.attributedRevenue ? (r.totals.attributedRevenue ?? 0) / total.attributedRevenue : null,
          roas: null,
          cpa: null,
        })),
      },
      notices: [
        {
          tone: "info",
          text: "Attribution from Shopify order UTMs / referrer (last click; first click in its own column). Compare with what each ad platform reports in the Meta and Google tabs.",
        },
      ],
    });
  }
  // refunds
  const [cur, cmp, sales] = await Promise.all([
    S.shopRefundsByBucket(sc, a.gran),
    cc ? S.shopRefundsByBucket(cc, "day") : null,
    S.shopByBucket(sc, a.gran),
  ]);
  const gross = groupSum(
    sales,
    (r) => r.bucket,
    (r) => ({ grossSales: Number(r.grossSales) }),
  );
  const toMap = (rows: Awaited<ReturnType<typeof S.shopRefundsByBucket>>, withGross: boolean) =>
    new Map(
      rows.map((r) => [r.bucket, { refunds: r.refunds, refundCount: r.refund_count, ...(withGross ? gross.get(r.bucket) : {}) } as Totals]),
    );
  const rows = timeRows(a, toMap(cur, true), cmp ? toMap(cmp, false) : null);
  return baseModel(a, {
    firstColumn: "Refund date",
    columns: metricCols(["refunds", "refundCount", "grossSales", "refundRate"]),
    defaultVisible: ["refunds", "refundCount", "refundRate"],
    rows,
    totalCompare: cmp ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
    notices: [{ tone: "info", text: "Refunds are booked on the date the refund was issued, not the order date." }],
  });
}

/** Blended totals per bucket: ads (all platforms) + Shopify + Other revenue. */
async function blendedByBucket(a: DataArgs, range: DateRange): Promise<Map<string, Totals>> {
  const sc = scopeOf(a, range);
  const otherConn = Object.entries(a.connections).find(([, c]) => c.platform === "OTHER_REVENUE")?.[0];
  const includeOther = !a.conn || (!!otherConn && a.conn.includes(otherConn));
  const [ads, shop, other] = await Promise.all([
    S.adsByBucketPlatform(sc, a.gran),
    S.shopByBucket(sc, a.gran),
    S.otherByBucket(sc, a.gran, includeOther),
  ]);
  const out = new Map<string, Totals[]>();
  const push = (b: string, t: Totals) => out.set(b, [...(out.get(b) ?? []), t]);
  for (const r of ads)
    push(r.bucket, {
      ...S.pickTotals(r, ["spend", "purchaseValue", "purchases", "impressions", "clicks", "addToCart", "initiateCheckout", "leads"]),
      platformRevenue: Number(r.purchaseValue),
    });
  for (const r of shop) push(r.bucket, shopTotals(r));
  for (const r of other) push(r.bucket, { otherRevenue: r.revenue, otherOrders: r.orders });
  const res = new Map<string, Totals>();
  for (const [b, list] of out) {
    const t = sumTotals(list);
    t.totalRevenue = (t.netSales ?? 0) + (t.otherRevenue ?? 0);
    res.set(b, t);
  }
  return res;
}

async function allPlatformsCore(a: DataArgs): Promise<DataTableModel> {
  const sc = scopeOf(a, a.range);
  const otherConn = Object.entries(a.connections).find(([, c]) => c.platform === "OTHER_REVENUE")?.[0];
  const includeOther = !a.conn || (!!otherConn && a.conn.includes(otherConn));
  const [cur, cmp, ads, shop, other, targets] = await Promise.all([
    blendedByBucket(a, a.range),
    a.compareRange ? blendedByBucket({ ...a, gran: "day" }, a.compareRange) : null,
    S.adsByBucketPlatform(sc, a.gran),
    S.shopByBucket(sc, a.gran),
    S.otherByBucket(sc, a.gran, includeOther),
    S.targetsFor(a.clientId, a.range.from, a.range.to),
  ]);
  const children = new Map<string, DataRow[]>();
  const add = (b: string, row: DataRow) => children.set(b, [...(children.get(b) ?? []), row]);
  for (const r of ads)
    add(r.bucket, {
      id: `${r.bucket}:${r.platform}`,
      label: r.platform === "META" ? "Meta" : "Google",
      sub: "Ad platform",
      totals: {
        ...S.pickTotals(r, ["spend", "purchaseValue", "purchases", "impressions", "clicks"]),
        platformRevenue: Number(r.purchaseValue),
      },
    });
  for (const [b, t] of groupSum(shop, (r) => r.bucket, shopTotals))
    add(b, { id: `${b}:shopify`, label: "Shopify", sub: "Store", totals: { ...t, totalRevenue: t.netSales } });
  for (const [b, t] of groupSum(
    other,
    (r) => r.bucket,
    (r) => ({ otherRevenue: r.revenue, otherOrders: r.orders }),
  ))
    add(b, { id: `${b}:other`, label: "Other revenue", sub: "Manual / CSV / webhook", totals: { ...t, totalRevenue: t.otherRevenue } });
  const targetFn = makeTargetFn(targets, "all");
  const rows = timeRows(a, cur, cmp, children, targetFn ?? undefined);
  const visible = [
    "spend",
    "platformRevenue",
    "totalRevenue",
    "mer",
    "amer",
    "ncac",
    "orders",
    "aov",
    "newCustomers",
    "attributionDiscrepancy",
  ];
  return baseModel(a, {
    firstColumn: "Date",
    columns: metricCols([...new Set([...visible, ...ALL_PLATFORMS])]),
    defaultVisible: visible,
    rows,
    total: (() => {
      const t = sumTotals(rows.map((r) => r.totals));
      return t;
    })(),
    totalCompare: cmp ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
    totalTarget: targetFn ? targetFn(eachDay(a.range), a.range.to) : undefined,
    hasTargets: !!targetFn,
  });
}

async function otherRevenueTab(a: DataArgs): Promise<DataTableModel> {
  const otherConn = Object.entries(a.connections).find(([, c]) => c.platform === "OTHER_REVENUE")?.[0];
  const include = !a.conn || (!!otherConn && a.conn.includes(otherConn));
  const bySource = a.tab === "sources";
  const [cur, cmp] = await Promise.all([
    S.otherByBucket(scopeOf(a, a.range), bySource ? null : a.gran, include),
    a.compareRange ? S.otherByBucket(scopeOf(a, a.compareRange), bySource ? null : "day", include) : null,
  ]);
  const t = (r: { revenue: number; orders: number }): Totals => ({ otherRevenue: r.revenue, otherOrders: r.orders });
  if (bySource) {
    const c = groupSum(cur, (r) => r.source, t),
      p = cmp ? groupSum(cmp, (r) => r.source, t) : null;
    const rows = [...c].map(([src, tt]) => ({ id: src, label: src, totals: tt, compare: p?.get(src) ?? null }));
    return baseModel(a, {
      firstColumn: "Source",
      columns: metricCols(["otherRevenue", "share_otherRevenue", "otherOrders"]).map((col) =>
        col.kind === "share" ? { ...col, header: "% of Revenue" } : col,
      ),
      defaultVisible: ["otherRevenue", "share_otherRevenue", "otherOrders"],
      rows,
      totalCompare: p ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
      defaultSort: { id: "otherRevenue", desc: true },
    });
  }
  const children = new Map<string, DataRow[]>();
  for (const r of cur)
    children.set(r.bucket, [...(children.get(r.bucket) ?? []), { id: `${r.bucket}:${r.source}`, label: r.source, totals: t(r) }]);
  const rows = timeRows(
    a,
    groupSum(cur, (r) => r.bucket, t),
    cmp ? groupSum(cmp, (r) => r.bucket, t) : null,
    children,
  );
  return baseModel(a, {
    firstColumn: "Date",
    columns: metricCols(["otherRevenue", "otherOrders"]),
    defaultVisible: ["otherRevenue", "otherOrders"],
    rows,
    totalCompare: cmp ? sumTotals(rows.map((r) => r.compare ?? {})) : null,
  });
}

// ───────────────────────── entry point ─────────────────────────

export async function getDataTable(a: DataArgs): Promise<DataTableModel> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`client:${a.clientId}`);

  const plat: S.AdPlatform | null = a.platform === "meta" ? "META" : a.platform === "google" ? "GOOGLE" : null;
  if (plat) {
    if (a.tab === "core") return adCore(a, plat, false);
    if (a.tab === "lead-gen") return adCore(a, plat, true);
    if (a.tab === "day-of-week") return adDayOfWeek(a, plat);
    if (BREAKDOWN_TAB[a.tab]) return adBreakdownTab(a, plat);
    if (ENTITY_TAB[a.tab]) return adEntityTab(a, plat);
    if (a.tab === "landing") return adAttributeTab(a, plat, "landing");
    if (a.tab === "campaign-type") return adAttributeTab(a, plat, "campaignType");
  }
  if (a.platform === "shopify") {
    if (a.tab === "core" || a.tab === "new-vs-returning") return shopifyCore(a, a.tab);
    return shopifyList(a);
  }
  if (a.platform === "other") return otherRevenueTab(a);
  if (a.tab === "day-of-week") return adDayOfWeek(a, null);
  return allPlatformsCore(a);
}

export async function getCampaignOptions(clientId: string, platform: DataPlatform, conn: string[] | null) {
  "use cache";
  cacheLife("minutes");
  cacheTag(`client:${clientId}`);
  if (platform !== "meta" && platform !== "google") return [];
  return S.campaignsFor(clientId, platform === "meta" ? "META" : "GOOGLE", conn);
}
