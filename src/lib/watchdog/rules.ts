/**
 * Watchdog rules. Each rule is a pure function over a data snapshot of one client, with editable params.
 * The runner (src/server/watchdog) builds the snapshot from the single reporting database, evaluates
 * every enabled rule, de-duplicates by fingerprint, auto-resolves alerts whose condition cleared, and notifies.
 */
import { classifyCreative } from "../rules/creative-status";
import { formatMetricValue } from "../format";
import { addDays } from "../periods";

export type Severity = "CRITICAL" | "WARNING" | "INFO";
export type AdPlatform = "META" | "GOOGLE";

export interface DayAd {
  date: string;
  spend: number;
  purchases: number;
  value: number;
  clicks: number;
  impressions: number;
  addToCart: number | null;
}

export interface WatchdogInput {
  /** today in the client's reporting timezone; "yesterday" is the last complete day */
  today: string;
  currency: string;
  /** daily per ad platform, complete days only (≤ yesterday), oldest first */
  platformDaily: Partial<Record<AdPlatform, DayAd[]>>;
  /** daily blended totals (ads + Shopify + other revenue), complete days only */
  blendedDaily: { date: string; spend: number; totalRevenue: number; orders: number; netSales: number; platformRevenue: number }[];
  hasShopify: boolean;
  connections: {
    id: string;
    name: string;
    platform: string;
    status: string;
    isDemo: boolean;
    lastError: string | null;
    lastSuccessAt: string | null;
    tokenExpiresAt: string | null;
    accountStatus: string | null;
    /** spend per day (complete days), oldest first */
    dailySpend: { date: string; spend: number }[];
  }[];
  /** current month targets */
  targets: {
    META: { cpa?: number | null; roas?: number | null; spend?: number | null };
    GOOGLE: { cpa?: number | null; roas?: number | null; spend?: number | null };
    CLIENT: { mer?: number | null; spend?: number | null };
  };
  /** month to date (complete days) */
  monthToDate: { daysElapsed: number; daysInMonth: number; spend: { META: number; GOOGLE: number; CLIENT: number } };
  rejectedAds: { connectionId: string; platform: string; adId: string; name: string; review: string; spend7d: number }[];
  /** Meta prospecting campaigns, last 7 days */
  prospecting: { connectionId: string; campaignId: string; name: string; impressions: number; reach: number | null; spend: number }[];
  /** ads aggregated over the creative window (see ad_to_cut / ad_winner windowDays) */
  ads: { platform: AdPlatform; connectionId: string; adId: string; name: string; spend: number; purchases: number; value: number }[];
  /** total ad spend per platform over the same window */
  adsAccountSpend: Partial<Record<AdPlatform, number>>;
}

export interface LinkSpec {
  platform?: "all" | "meta" | "google" | "shopify";
  tab?: string;
  preset?: string;
  accounts?: string;
}

export interface Candidate {
  ruleKey: string;
  severity: Severity;
  title: string;
  message: string;
  /** stable identity of the condition, used to de-duplicate and auto-resolve */
  fingerprint: string;
  connectionId?: string;
  entityId?: string;
  link?: LinkSpec;
  data?: Record<string, number | string | null>;
}

export interface ParamSpec {
  key: string;
  label: string;
  unit: "%" | "x" | "currency" | "days" | "number";
  default: number;
  min?: number;
  max?: number;
}

export interface RuleDef {
  key: string;
  label: string;
  description: string;
  params: ParamSpec[];
  evaluate: (input: WatchdogInput, p: Record<string, number>) => Candidate[];
}

// ───────────────────────── helpers ─────────────────────────

const PLATFORMS: AdPlatform[] = ["META", "GOOGLE"];
const NAME: Record<string, string> = { META: "Meta", GOOGLE: "Google" };
const SLUG: Record<AdPlatform, "meta" | "google"> = { META: "meta", GOOGLE: "google" };

type Agg = { spend: number; purchases: number; value: number; clicks: number; impressions: number; addToCart: number | null; days: number };
function agg(days: DayAd[]): Agg {
  const a: Agg = { spend: 0, purchases: 0, value: 0, clicks: 0, impressions: 0, addToCart: null, days: days.length };
  for (const d of days) {
    a.spend += d.spend;
    a.purchases += d.purchases;
    a.value += d.value;
    a.clicks += d.clicks;
    a.impressions += d.impressions;
    if (d.addToCart !== null) a.addToCart = (a.addToCart ?? 0) + d.addToCart;
  }
  return a;
}

/** Last `n` complete days (ending yesterday) and the `m` days before them. */
function windows<T extends { date: string }>(rows: T[], today: string, n: number, m: number): { recent: T[]; prior: T[] } {
  const y = addDays(today, -1);
  const rStart = addDays(y, -(n - 1));
  const pEnd = addDays(rStart, -1);
  const pStart = addDays(pEnd, -(m - 1));
  return { recent: rows.filter((r) => r.date >= rStart && r.date <= y), prior: rows.filter((r) => r.date >= pStart && r.date <= pEnd) };
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const change = (now: number | null, before: number | null) =>
  now === null || before === null || before === 0 ? null : (now - before) / Math.abs(before);
const pct = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(0)}%`);

// ───────────────────────── rules ─────────────────────────

export const RULES: RuleDef[] = [
  {
    key: "cpa_above_target",
    label: "CPA above target",
    description: "Platform CPA over the last days is above the monthly CPA target by more than the threshold.",
    params: [
      { key: "pct", label: "Above target by", unit: "%", default: 20, min: 0 },
      { key: "days", label: "Look-back", unit: "days", default: 3, min: 1, max: 14 },
      { key: "minSpend", label: "Minimum spend in the window", unit: "currency", default: 100, min: 0 },
    ],
    evaluate(i, p) {
      const out: Candidate[] = [];
      for (const pl of PLATFORMS) {
        const target = i.targets[pl].cpa;
        const days = i.platformDaily[pl];
        if (!target || !days) continue;
        const a = agg(windows(days, i.today, p.days, 0).recent);
        if (a.spend < p.minSpend) continue;
        const cpa = a.purchases > 0 ? a.spend / a.purchases : Infinity;
        if (cpa <= target * (1 + p.pct / 100)) continue;
        const over = cpa === Infinity ? null : cpa / target - 1;
        out.push({
          ruleKey: "cpa_above_target",
          severity: cpa >= target * 1.5 ? "CRITICAL" : "WARNING",
          title: `${NAME[pl]} CPA ${cpa === Infinity ? "with no conversions" : `${pct(over)} vs target`}`,
          message: `Last ${p.days} days: CPA ${cpa === Infinity ? "∞ (0 conversions)" : formatMetricValue(cpa, "currency", i.currency)} vs target ${formatMetricValue(target, "currency", i.currency)} on ${formatMetricValue(a.spend, "currency", i.currency)} spend.`,
          fingerprint: `cpa_above_target:${pl}`,
          link: { platform: SLUG[pl], tab: "campaigns", preset: "last_7" },
          data: { cpa: cpa === Infinity ? null : cpa, target, spend: a.spend, purchases: a.purchases },
        });
      }
      return out;
    },
  },
  {
    key: "roas_drop",
    label: "ROAS / MER below target or dropping",
    description: "Platform ROAS (and blended MER) below the monthly target, or down more than the threshold vs the previous 7-day average.",
    params: [
      { key: "dropPct", label: "Drop vs previous 7-day average", unit: "%", default: 20, min: 0 },
      { key: "days", label: "Recent window", unit: "days", default: 3, min: 1, max: 7 },
      { key: "minSpend", label: "Minimum spend in the window", unit: "currency", default: 100, min: 0 },
    ],
    evaluate(i, p) {
      const out: Candidate[] = [];
      const check = (
        scope: string,
        label: string,
        recentV: number | null,
        priorV: number | null,
        target: number | null | undefined,
        spend: number,
        link: LinkSpec,
      ) => {
        if (recentV === null || spend < p.minSpend) return;
        const d = change(recentV, priorV);
        const below = !!target && recentV < target;
        const dropped = d !== null && d <= -p.dropPct / 100;
        if (!below && !dropped) return;
        out.push({
          ruleKey: "roas_drop",
          severity: below && dropped ? "CRITICAL" : "WARNING",
          title: `${label} ${recentV.toFixed(2)}x${below ? ` below target ${target!.toFixed(2)}x` : ""}${dropped ? ` (${pct(d)} vs 7-day avg)` : ""}`,
          message: `Last ${p.days} days ${label} ${recentV.toFixed(2)}x · previous 7 days ${priorV === null ? "—" : `${priorV.toFixed(2)}x`}${target ? ` · target ${target.toFixed(2)}x` : ""}.`,
          fingerprint: `roas_drop:${scope}`,
          link,
          data: { value: recentV, prior: priorV, target: target ?? null, change: d },
        });
      };
      for (const pl of PLATFORMS) {
        const days = i.platformDaily[pl];
        if (!days) continue;
        const w = windows(days, i.today, p.days, 7);
        const r = agg(w.recent),
          q = agg(w.prior);
        check(pl, `${NAME[pl]} ROAS`, ratio(r.value, r.spend), ratio(q.value, q.spend), i.targets[pl].roas, r.spend, {
          platform: SLUG[pl],
          preset: "last_14",
        });
      }
      if (i.hasShopify) {
        const w = windows(i.blendedDaily, i.today, p.days, 7);
        const sum = (rows: typeof w.recent) =>
          rows.reduce((s, x) => ({ rev: s.rev + x.totalRevenue, spend: s.spend + x.spend }), { rev: 0, spend: 0 });
        const r = sum(w.recent),
          q = sum(w.prior);
        check("CLIENT", "MER", ratio(r.rev, r.spend), ratio(q.rev, q.spend), i.targets.CLIENT.mer, r.spend, {
          platform: "all",
          preset: "last_14",
        });
      }
      return out;
    },
  },
  {
    key: "spend_pacing",
    label: "Spend pacing vs monthly budget",
    description: "At the current pace, spend will end the month above or below the budget (spend target) by more than the tolerance.",
    params: [
      { key: "tolerancePct", label: "Tolerance", unit: "%", default: 10, min: 0 },
      { key: "minDays", label: "Start checking after", unit: "days", default: 3, min: 1, max: 15 },
    ],
    evaluate(i, p) {
      const out: Candidate[] = [];
      const { daysElapsed, daysInMonth } = i.monthToDate;
      if (daysElapsed < p.minDays) return out;
      const scopes: [string, string, number | null | undefined, number, LinkSpec][] = [
        ["CLIENT", "Total ad spend", i.targets.CLIENT.spend, i.monthToDate.spend.CLIENT, { platform: "all", preset: "this_month" }],
        ["META", "Meta spend", i.targets.META.spend, i.monthToDate.spend.META, { platform: "meta", preset: "this_month" }],
        ["GOOGLE", "Google spend", i.targets.GOOGLE.spend, i.monthToDate.spend.GOOGLE, { platform: "google", preset: "this_month" }],
      ];
      for (const [scope, label, budget, mtd, link] of scopes) {
        if (!budget) continue;
        const projection = (mtd / daysElapsed) * daysInMonth;
        const gap = projection / budget - 1;
        if (Math.abs(gap) * 100 < p.tolerancePct) continue;
        const over = gap > 0;
        out.push({
          ruleKey: "spend_pacing",
          severity: over && gap > 0.25 ? "CRITICAL" : "WARNING",
          title: `${label} pacing ${over ? "over" : "under"} budget (${pct(gap)})`,
          message: `${formatMetricValue(mtd, "currency", i.currency)} in ${daysElapsed} days → projected ${formatMetricValue(projection, "currency", i.currency)} vs budget ${formatMetricValue(budget, "currency", i.currency)}. ${over ? "Reduce" : "Increase"} daily spend to about ${formatMetricValue(Math.max(0, budget - mtd) / Math.max(1, daysInMonth - daysElapsed), "currency", i.currency)}/day to land on budget.`,
          fingerprint: `spend_pacing:${scope}:${over ? "over" : "under"}`,
          link,
          data: { mtd, projection, budget, gap },
        });
      }
      return out;
    },
  },
  {
    key: "zero_spend",
    label: "Account stopped spending / account problem",
    description:
      "An ad account that normally spends had (almost) no spend yesterday — card declined, account disabled, campaigns paused — or the platform reports the account as not active.",
    params: [
      { key: "minAvgDaily", label: "Normally spends at least (daily avg, prev. 7 days)", unit: "currency", default: 50, min: 0 },
      { key: "dropToPct", label: "Yesterday below % of normal", unit: "%", default: 10, min: 0, max: 100 },
    ],
    evaluate(i, p) {
      const out: Candidate[] = [];
      for (const c of i.connections) {
        if (c.platform !== "META" && c.platform !== "GOOGLE") continue;
        if (c.accountStatus && !/^active$/i.test(c.accountStatus) && !/grace/i.test(c.accountStatus))
          out.push({
            ruleKey: "zero_spend",
            severity: "CRITICAL",
            title: `${c.name}: account ${c.accountStatus.toLowerCase()}`,
            message: `${NAME[c.platform]} reports this ad account as “${c.accountStatus}”. Ads may not be delivering — check billing and account quality.`,
            fingerprint: `account_status:${c.id}`,
            connectionId: c.id,
            link: { platform: SLUG[c.platform as AdPlatform], accounts: c.id, preset: "last_7" },
          });
        const w = windows(c.dailySpend, i.today, 1, 7);
        const y = w.recent[0]?.spend ?? 0;
        const avg = w.prior.length ? w.prior.reduce((s, d) => s + d.spend, 0) / 7 : 0;
        if (avg >= p.minAvgDaily && y < (avg * p.dropToPct) / 100)
          out.push({
            ruleKey: "zero_spend",
            severity: "CRITICAL",
            title: `${c.name} ${y === 0 ? "had no spend" : "almost stopped spending"} yesterday`,
            message: `Yesterday ${formatMetricValue(y, "currency", i.currency)} vs ${formatMetricValue(avg, "currency", i.currency)}/day average. Possible declined card, disabled account, paused campaigns or a spending limit.`,
            fingerprint: `zero_spend:${c.id}`,
            connectionId: c.id,
            link: { platform: SLUG[c.platform as AdPlatform], accounts: c.id, preset: "last_14" },
            data: { yesterday: y, average: avg },
          });
      }
      return out;
    },
  },
  {
    key: "ad_rejected",
    label: "Rejected ad",
    description: "An ad is disapproved (or limited) by the platform.",
    params: [{ key: "minSpend7d", label: "Only if it spent in the last 7 days at least", unit: "currency", default: 0, min: 0 }],
    evaluate(i, p) {
      return i.rejectedAds
        .filter((a) => a.spend7d >= p.minSpend7d)
        .map((a) => ({
          ruleKey: "ad_rejected",
          severity: "WARNING" as const,
          title: `Ad rejected: ${a.name}`,
          message: `${a.review}${a.spend7d ? ` · spent ${formatMetricValue(a.spend7d, "currency", i.currency)} in the last 7 days` : ""}. Edit or replace it to restore delivery.`,
          fingerprint: `ad_rejected:${a.connectionId}:${a.adId}`,
          connectionId: a.connectionId,
          entityId: a.adId,
          link: { platform: SLUG[a.platform as AdPlatform] ?? "meta", tab: "ads", preset: "last_90", accounts: a.connectionId },
        }));
    },
  },
  {
    key: "high_frequency",
    label: "High frequency in prospecting",
    description: "A Meta prospecting campaign shows the same people the ads too often (last 7 days).",
    params: [
      { key: "maxFrequency", label: "Frequency above", unit: "x", default: 2.5, min: 1 },
      { key: "minSpend", label: "Minimum spend (7 days)", unit: "currency", default: 100, min: 0 },
    ],
    evaluate(i, p) {
      return i.prospecting
        .filter((c) => c.reach && c.spend >= p.minSpend && c.impressions / c.reach > p.maxFrequency)
        .map((c) => {
          const f = c.impressions / c.reach!;
          return {
            ruleKey: "high_frequency",
            severity: f > p.maxFrequency * 1.5 ? ("CRITICAL" as const) : ("WARNING" as const),
            title: `Frequency ${f.toFixed(1)}x on ${c.name}`,
            message: `Prospecting campaign reached people ${f.toFixed(1)} times on average in 7 days (limit ${p.maxFrequency}x). Refresh creatives or broaden the audience.`,
            fingerprint: `high_frequency:${c.connectionId}:${c.campaignId}`,
            connectionId: c.connectionId,
            entityId: c.campaignId,
            link: { platform: "meta" as const, tab: "campaigns", preset: "last_7", accounts: c.connectionId },
            data: { frequency: f, spend: c.spend },
          };
        });
    },
  },
  {
    key: "tracking_broken",
    label: "Tracking looks broken",
    description:
      "Platform-reported purchases dropped sharply while Shopify orders didn't (or the opposite), or the attribution gap is far from normal.",
    params: [
      { key: "dropPct", label: "Drop that counts as sharp", unit: "%", default: 50, min: 10, max: 100 },
      { key: "gapPp", label: "Attribution gap change (points)", unit: "%", default: 30, min: 5 },
    ],
    evaluate(i, p) {
      const out: Candidate[] = [];
      if (!i.hasShopify) return out;
      const ow = windows(i.blendedDaily, i.today, 2, 7);
      const ordersNow = ow.recent.reduce((s, d) => s + d.orders, 0) / Math.max(1, ow.recent.length);
      const ordersBefore = ow.prior.reduce((s, d) => s + d.orders, 0) / Math.max(1, ow.prior.length);
      const ordersChange = change(ordersNow, ordersBefore);
      for (const pl of PLATFORMS) {
        const days = i.platformDaily[pl];
        if (!days) continue;
        const w = windows(days, i.today, 2, 7);
        const now = agg(w.recent).purchases / Math.max(1, w.recent.length);
        const before = agg(w.prior).purchases / Math.max(1, w.prior.length);
        const c = change(now, before);
        if (c === null || ordersChange === null || before < 3) continue;
        if (c <= -p.dropPct / 100 && ordersChange > -p.dropPct / 200)
          out.push({
            ruleKey: "tracking_broken",
            severity: "CRITICAL",
            title: `${NAME[pl]} conversions ${pct(c)} while Shopify orders ${pct(ordersChange)}`,
            message: `${NAME[pl]} reports ${now.toFixed(1)} purchases/day (last 2 days) vs ${before.toFixed(1)} before, but Shopify orders barely moved. Check the pixel / Conversions API, checkout changes and the conversion action.`,
            fingerprint: `tracking_broken:${pl}`,
            link: { platform: SLUG[pl], preset: "last_14" },
            data: { platformChange: c, ordersChange },
          });
      }
      if (ordersChange !== null && ordersChange <= -p.dropPct / 100) {
        const platformNow = PLATFORMS.reduce((s, pl) => s + agg(windows(i.platformDaily[pl] ?? [], i.today, 2, 7).recent).purchases / 2, 0);
        const platformBefore = PLATFORMS.reduce(
          (s, pl) => s + agg(windows(i.platformDaily[pl] ?? [], i.today, 2, 7).prior).purchases / 7,
          0,
        );
        const pc = change(platformNow, platformBefore);
        if (pc !== null && pc > -p.dropPct / 200)
          out.push({
            ruleKey: "tracking_broken",
            severity: "WARNING",
            title: `Shopify orders ${pct(ordersChange)} but ad platforms ${pct(pc)}`,
            message:
              "Orders in Shopify dropped while the platforms still report conversions. Check the store/checkout, payment gateway, and the Shopify sync on Sync Status.",
            fingerprint: "tracking_broken:SHOPIFY",
            link: { platform: "shopify", preset: "last_14" },
            data: { ordersChange, platformChange: pc },
          });
      }
      // attribution gap vs its 28-day normal
      const gw = windows(i.blendedDaily, i.today, 3, 28);
      const gap = (rows: typeof gw.recent) => {
        const ns = rows.reduce((s, d) => s + d.netSales, 0);
        const pr = rows.reduce((s, d) => s + d.platformRevenue, 0);
        return ns > 0 ? (pr - ns) / ns : null;
      };
      const gNow = gap(gw.recent),
        gNormal = gap(gw.prior);
      if (gNow !== null && gNormal !== null && Math.abs(gNow - gNormal) * 100 >= p.gapPp)
        out.push({
          ruleKey: "tracking_broken",
          severity: "WARNING",
          title: `Attribution gap ${pct(gNow)} (normal ${pct(gNormal)})`,
          message:
            "Platform-reported revenue vs Shopify net sales moved far from its 28-day normal — a sign of double counting, a broken pixel or missing orders.",
          fingerprint: "tracking_broken:GAP",
          link: { platform: "all", preset: "last_30" },
          data: { gap: gNow, normal: gNormal },
        });
      return out;
    },
  },
  {
    key: "funnel_diagnosis",
    label: "Funnel diagnosis when CPA rises",
    description:
      "When CPA rises, check the top of the funnel: if CPC and cost per add-to-cart rose too, traffic got more expensive and the funnel isn't absorbing it; if they are stable, hold — purchases usually catch up.",
    params: [
      { key: "cpaRisePct", label: "CPA rise (last 3 days vs previous 7)", unit: "%", default: 20, min: 5 },
      { key: "stablePct", label: "CPC / Cost per ATC counted as stable within", unit: "%", default: 10, min: 1 },
      { key: "minSpend", label: "Minimum spend (3 days)", unit: "currency", default: 100, min: 0 },
    ],
    evaluate(i, p) {
      const out: Candidate[] = [];
      for (const pl of PLATFORMS) {
        const days = i.platformDaily[pl];
        if (!days) continue;
        const w = windows(days, i.today, 3, 7);
        const r = agg(w.recent),
          q = agg(w.prior);
        if (r.spend < p.minSpend || !r.purchases || !q.purchases) continue;
        const cpaC = change(r.spend / r.purchases, q.spend / q.purchases);
        if (cpaC === null || cpaC < p.cpaRisePct / 100) continue;
        const cpcC = change(ratio(r.spend, r.clicks), ratio(q.spend, q.clicks));
        const atcC = r.addToCart && q.addToCart ? change(r.spend / r.addToCart, q.spend / q.addToCart) : null;
        const s = p.stablePct / 100;
        const topUp = (cpcC ?? 0) > s && (atcC === null || atcC > s);
        const topStable = cpcC !== null && Math.abs(cpcC) <= s && (atcC === null || Math.abs(atcC) <= s);
        if (!topUp && !topStable) continue;
        out.push({
          ruleKey: "funnel_diagnosis",
          severity: topUp ? "WARNING" : "INFO",
          title: topUp
            ? `${NAME[pl]} CPA ${pct(cpaC)}: traffic got more expensive`
            : `${NAME[pl]} CPA ${pct(cpaC)} with a stable funnel top — hold`,
          message: topUp
            ? `CPC ${pct(cpcC)}${atcC !== null ? ` and cost per ATC ${pct(atcC)}` : ""} rose with CPA: the funnel isn't absorbing the traffic. Review audiences, creatives fatigue and bids.`
            : `CPC ${pct(cpcC)}${atcC !== null ? ` and cost per ATC ${pct(atcC)}` : ""} are stable, so the rise is at the bottom of the funnel. Avoid big changes for now — purchases should catch up (attribution lag).`,
          fingerprint: `funnel_diagnosis:${pl}`,
          link: { platform: SLUG[pl], preset: "last_14" },
          data: { cpaChange: cpaC, cpcChange: cpcC, costPerAtcChange: atcC },
        });
      }
      return out;
    },
  },
  {
    key: "ad_to_cut",
    label: "Ad to cut",
    description: "Ad with CPA well above target after spending enough to judge it.",
    params: [
      { key: "windowDays", label: "Window", unit: "days", default: 14, min: 3, max: 30 },
      { key: "cpaMult", label: "CPA at least × target", unit: "x", default: 2, min: 1 },
      { key: "spendMult", label: "Spent at least × target CPA", unit: "x", default: 2, min: 1 },
    ],
    evaluate(i, p) {
      return i.ads
        .filter((a) => {
          const t = i.targets[a.platform];
          return (
            !!t.cpa &&
            classifyCreative(
              {
                spend: a.spend,
                purchases: a.purchases,
                purchaseValue: a.value,
                accountSpend: i.adsAccountSpend[a.platform] ?? 0,
                targetCpa: t.cpa,
                targetRoas: t.roas,
              },
              { cutCpaMult: p.cpaMult, cutSpendMult: p.spendMult, winnerSpendShare: 1 },
            ) === "cut"
          );
        })
        .map((a) => {
          const cpa = a.purchases ? a.spend / a.purchases : null;
          return {
            ruleKey: "ad_to_cut",
            severity: "WARNING" as const,
            title: `Cut candidate: ${a.name}`,
            message: `Last ${p.windowDays} days: spent ${formatMetricValue(a.spend, "currency", i.currency)} with CPA ${cpa === null ? "∞ (0 conversions)" : formatMetricValue(cpa, "currency", i.currency)} vs target ${formatMetricValue(i.targets[a.platform].cpa!, "currency", i.currency)}.`,
            fingerprint: `ad_to_cut:${a.connectionId}:${a.adId}`,
            connectionId: a.connectionId,
            entityId: a.adId,
            link: {
              platform: SLUG[a.platform],
              tab: a.platform === "META" ? "creatives" : "ads",
              preset: "last_14",
              accounts: a.connectionId,
            },
            data: { spend: a.spend, cpa },
          };
        });
    },
  },
  {
    key: "ad_winner",
    label: "Winning ad",
    description: "Ad taking a meaningful share of spend while beating the ROAS target — consider scaling it.",
    params: [
      { key: "windowDays", label: "Window", unit: "days", default: 14, min: 7, max: 30 },
      { key: "spendSharePct", label: "Share of account spend at least", unit: "%", default: 5, min: 1, max: 100 },
    ],
    evaluate(i, p) {
      return i.ads
        .filter((a) => {
          const t = i.targets[a.platform];
          if (!t.roas && !t.cpa) return false;
          return (
            classifyCreative(
              {
                spend: a.spend,
                purchases: a.purchases,
                purchaseValue: a.value,
                accountSpend: i.adsAccountSpend[a.platform] ?? 0,
                targetCpa: t.cpa,
                targetRoas: t.roas,
              },
              { cutCpaMult: Infinity, cutSpendMult: Infinity, winnerSpendShare: p.spendSharePct / 100 },
            ) === "winner"
          );
        })
        .map((a) => ({
          ruleKey: "ad_winner",
          severity: "INFO" as const,
          title: `Winner: ${a.name}`,
          message: `Last ${p.windowDays} days: ${formatMetricValue(a.spend / (i.adsAccountSpend[a.platform] || 1), "percent", i.currency)} of ${NAME[a.platform]} spend at ROAS ${(a.value / a.spend).toFixed(2)}x${i.targets[a.platform].roas ? ` (target ${i.targets[a.platform].roas!.toFixed(2)}x)` : ""}. Consider giving it more budget or iterating on it.`,
          fingerprint: `ad_winner:${a.connectionId}:${a.adId}`,
          connectionId: a.connectionId,
          entityId: a.adId,
          link: {
            platform: SLUG[a.platform],
            tab: a.platform === "META" ? "creatives" : "ads",
            preset: "last_14",
            accounts: a.connectionId,
          },
          data: { spend: a.spend, roas: a.value / a.spend },
        }));
    },
  },
  {
    key: "sync_issue",
    label: "Sync failed / token expiring",
    description: "A connection failed to sync, its token expired or will expire soon.",
    params: [
      { key: "tokenExpiryDays", label: "Warn before token expiry", unit: "days", default: 7, min: 1, max: 30 },
      { key: "staleHours", label: "Critical if no successful sync for", unit: "number", default: 24, min: 1 },
    ],
    evaluate(i, p) {
      const out: Candidate[] = [];
      const now = Date.parse(i.today + "T12:00:00Z");
      for (const c of i.connections) {
        if (c.isDemo) continue;
        if (c.status === "TOKEN_EXPIRED")
          out.push({
            ruleKey: "sync_issue",
            severity: "CRITICAL",
            title: `${c.name}: token expired`,
            message: `${c.lastError ?? "The platform rejected the credentials."} Reconnect it on Sync Status — data is not updating.`,
            fingerprint: `sync_issue:token:${c.id}`,
            connectionId: c.id,
          });
        else if (c.status === "ERROR") {
          const stale = !c.lastSuccessAt || now - Date.parse(c.lastSuccessAt) > p.staleHours * 3_600_000;
          out.push({
            ruleKey: "sync_issue",
            severity: stale ? "CRITICAL" : "WARNING",
            title: `${c.name}: sync failed`,
            message: c.lastError ?? "The last sync failed.",
            fingerprint: `sync_issue:error:${c.id}`,
            connectionId: c.id,
          });
        }
        if (c.tokenExpiresAt && c.status !== "TOKEN_EXPIRED") {
          const days = (Date.parse(c.tokenExpiresAt) - now) / 86_400_000;
          if (days <= p.tokenExpiryDays)
            out.push({
              ruleKey: "sync_issue",
              severity: "WARNING",
              title: `${c.name}: token expires in ${Math.max(0, Math.round(days))} day(s)`,
              message: "Reconnect it on Sync Status to avoid a gap in the data.",
              fingerprint: `sync_issue:expiry:${c.id}`,
              connectionId: c.id,
            });
        }
      }
      return out;
    },
  },
];

export const RULE_MAP = Object.fromEntries(RULES.map((r) => [r.key, r])) as Record<string, RuleDef>;

export function defaultParams(rule: RuleDef): Record<string, number> {
  return Object.fromEntries(rule.params.map((x) => [x.key, x.default]));
}

/** Evaluate every enabled rule; params override defaults. */
export function evaluateRules(
  input: WatchdogInput,
  config: Record<string, { enabled: boolean; params: Record<string, number> } | undefined> = {},
): Candidate[] {
  const out: Candidate[] = [];
  for (const r of RULES) {
    const cfg = config[r.key];
    if (cfg && !cfg.enabled) continue;
    out.push(...r.evaluate(input, { ...defaultParams(r), ...(cfg?.params ?? {}) }));
  }
  return out;
}
