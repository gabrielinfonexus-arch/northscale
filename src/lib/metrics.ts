/**
 * NorthScale metric registry — the single source of truth for every metric:
 * formula, format, direction (is higher better?) and description.
 * Used by tables, cards, tooltips, comparison colours, the Help glossary and the AI system prompt.
 */

export type MetricFormat = "currency" | "number" | "percent" | "ratio" | "decimal";
/** up = higher is better, down = lower is better, neutral = never coloured */
export type MetricDirection = "up" | "down" | "neutral";
export type Tone = "good" | "bad" | "neutral";

/** Additive base quantities. Every derived metric is computed from sums of these. */
export const BASE_KEYS = [
  // ad platforms
  "spend",
  "impressions",
  "reach",
  "clicks",
  "linkClicks",
  "purchases",
  "purchaseValue",
  "addToCart",
  "initiateCheckout",
  "leads",
  "results",
  "resultsValue",
  "videoViews3s",
  "thruPlays",
  // commerce (Shopify + Other revenue)
  "orders",
  "grossSales",
  "discounts",
  "refunds",
  "netSales",
  "shipping",
  "taxes",
  "cogs",
  "paymentFees",
  "newCustomers",
  "returningOrders",
  "newCustomerRevenue",
  "returningCustomerRevenue",
  "otherRevenue",
  "otherOrders",
  "totalRevenue",
  "platformRevenue",
  "attributedRevenue",
  "units",
  "refundCount",
] as const;

export type BaseKey = (typeof BASE_KEYS)[number];
/** null = the source does not provide this value (render "—"). */
export type Totals = Partial<Record<BaseKey, number | null>>;

export interface MetricDef {
  key: string;
  label: string;
  /** Column header, as in the reference (upper-cased in the UI). */
  short: string;
  description: string;
  formula: string;
  format: MetricFormat;
  direction: MetricDirection;
  /** Returns null when not computable (missing source or zero denominator). */
  compute: (t: Totals) => number | null;
  group: "Delivery" | "Conversions" | "Efficiency" | "Funnel" | "Commerce" | "Blended" | "Video";
}

const v = (t: Totals, k: BaseKey): number | null => {
  const x = t[k];
  return x === undefined || x === null || Number.isNaN(x) ? null : x;
};

/** Safe division: null if either side missing or denominator is 0. */
export function div(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

const base = (
  key: BaseKey,
  label: string,
  short: string,
  format: MetricFormat,
  direction: MetricDirection,
  group: MetricDef["group"],
  description: string,
): MetricDef => ({
  key,
  label,
  short,
  format,
  direction,
  group,
  description,
  formula: description.includes("=") ? description : `Sum of ${label.toLowerCase()}`,
  compute: (t) => v(t, key),
});

const derived = (
  key: string,
  label: string,
  short: string,
  format: MetricFormat,
  direction: MetricDirection,
  group: MetricDef["group"],
  formula: string,
  description: string,
  compute: (t: Totals) => number | null,
): MetricDef => ({ key, label, short, format, direction, group, formula, description, compute });

export const METRICS: MetricDef[] = [
  // ── Delivery ──
  base("spend", "Spend", "Spend", "currency", "neutral", "Delivery", "Amount spent on ads, converted to the client's reporting currency."),
  base("impressions", "Impressions", "Impr.", "number", "neutral", "Delivery", "Number of times ads were shown."),
  base(
    "reach",
    "Reach",
    "Reach",
    "number",
    "neutral",
    "Delivery",
    "Unique people reached (Meta only; summed across days, so it overstates multi-day reach).",
  ),
  derived(
    "frequency",
    "Frequency",
    "Freq.",
    "decimal",
    "neutral",
    "Delivery",
    "Impressions / Reach",
    "Average times each person saw an ad.",
    (t) => div(v(t, "impressions"), v(t, "reach")),
  ),
  base("clicks", "Clicks", "Clicks", "number", "up", "Delivery", "All clicks reported by the platform."),
  base("linkClicks", "Link clicks", "Link Clicks", "number", "up", "Delivery", "Clicks that lead to the destination URL (Meta)."),
  derived("ctr", "CTR", "CTR", "percent", "up", "Efficiency", "Clicks / Impressions", "Click-through rate.", (t) =>
    div(v(t, "clicks"), v(t, "impressions")),
  ),
  derived("cpc", "CPC", "CPC", "currency", "down", "Efficiency", "Spend / Clicks", "Cost per click.", (t) =>
    div(v(t, "spend"), v(t, "clicks")),
  ),
  derived("cpm", "CPM", "CPM", "currency", "down", "Efficiency", "Spend / Impressions × 1000", "Cost per thousand impressions.", (t) => {
    const r = div(v(t, "spend"), v(t, "impressions"));
    return r === null ? null : r * 1000;
  }),

  // ── Conversions (platform-reported) ──
  base(
    "purchases",
    "Conversions",
    "Conv.",
    "number",
    "up",
    "Conversions",
    "Purchases reported by the ad platform (default attribution window).",
  ),
  base(
    "purchaseValue",
    "Ad revenue",
    "Ad Revenue",
    "currency",
    "up",
    "Conversions",
    "Purchase value reported by the ad platform (not real revenue — see Total Revenue).",
  ),
  base("addToCart", "Add to cart", "ATC", "number", "up", "Conversions", "Add-to-cart events reported by the platform."),
  base("initiateCheckout", "Initiate checkout", "IC", "number", "up", "Conversions", "Checkouts initiated, reported by the platform."),
  base("leads", "Leads", "Leads", "number", "up", "Conversions", "Leads reported by the platform (forms + pixel)."),
  base("results", "Results", "Results", "number", "up", "Conversions", "Results for the campaign's optimisation goal."),
  base("resultsValue", "Results value", "Results Val.", "currency", "up", "Conversions", "Value of the results for the optimisation goal."),
  derived(
    "roas",
    "ROAS",
    "ROAS",
    "ratio",
    "up",
    "Efficiency",
    "Ad Revenue / Spend",
    "Return on ad spend as reported by the platform.",
    (t) => div(v(t, "purchaseValue"), v(t, "spend")),
  ),
  derived("cpa", "CPA", "CPA", "currency", "down", "Efficiency", "Spend / Conv.", "Cost per purchase (platform-reported).", (t) =>
    div(v(t, "spend"), v(t, "purchases")),
  ),
  derived("cpl", "Cost per lead", "CPL", "currency", "down", "Efficiency", "Spend / Leads", "Cost per lead.", (t) =>
    div(v(t, "spend"), v(t, "leads")),
  ),
  derived(
    "costPerResult",
    "Cost per result",
    "Cost/Result",
    "currency",
    "down",
    "Efficiency",
    "Spend / Results",
    "Cost per optimisation result.",
    (t) => div(v(t, "spend"), v(t, "results")),
  ),
  derived("cvr", "Conversion rate", "CVR", "percent", "up", "Efficiency", "Conv. / Clicks", "Share of clicks that converted.", (t) =>
    div(v(t, "purchases"), v(t, "clicks")),
  ),
  derived(
    "aovPlatform",
    "AOV (platform)",
    "AOV",
    "currency",
    "up",
    "Efficiency",
    "Ad Revenue / Conv.",
    "Average order value reported by the platform.",
    (t) => div(v(t, "purchaseValue"), v(t, "purchases")),
  ),

  // ── Funnel ──
  derived("costPerAtc", "Cost per ATC", "Cost/ATC", "currency", "down", "Funnel", "Spend / ATC", "Cost per add to cart.", (t) =>
    div(v(t, "spend"), v(t, "addToCart")),
  ),
  derived("costPerIc", "Cost per IC", "Cost/IC", "currency", "down", "Funnel", "Spend / IC", "Cost per initiated checkout.", (t) =>
    div(v(t, "spend"), v(t, "initiateCheckout")),
  ),
  derived("clickToAtc", "Click → ATC", "Click→ATC", "percent", "up", "Funnel", "ATC / Clicks", "Share of clicks that added to cart.", (t) =>
    div(v(t, "addToCart"), v(t, "clicks")),
  ),
  derived("atcToIc", "ATC → IC", "ATC→IC", "percent", "up", "Funnel", "IC / ATC", "Share of add-to-carts that started checkout.", (t) =>
    div(v(t, "initiateCheckout"), v(t, "addToCart")),
  ),
  derived(
    "icToPurchase",
    "IC → Purchase",
    "IC→Purch.",
    "percent",
    "up",
    "Funnel",
    "Conv. / IC",
    "Share of checkouts that purchased.",
    (t) => div(v(t, "purchases"), v(t, "initiateCheckout")),
  ),

  // ── Video ──
  derived(
    "hookRate",
    "Hook rate",
    "Hook",
    "percent",
    "up",
    "Video",
    "3s video views / Impressions",
    "Share of impressions that watched at least 3 seconds.",
    (t) => div(v(t, "videoViews3s"), v(t, "impressions")),
  ),
  derived(
    "holdRate",
    "Hold rate",
    "Hold",
    "percent",
    "up",
    "Video",
    "ThruPlays / 3s video views",
    "Share of 3s viewers that watched to ThruPlay.",
    (t) => div(v(t, "thruPlays"), v(t, "videoViews3s")),
  ),

  // ── Commerce (Shopify) ──
  base("orders", "Orders", "Orders", "number", "up", "Commerce", "Shopify orders (cancelled excluded)."),
  base("grossSales", "Gross sales", "Gross Sales", "currency", "up", "Commerce", "Line items × price, before discounts and refunds."),
  base("discounts", "Discounts", "Discounts", "currency", "neutral", "Commerce", "Discounts applied to orders."),
  base("refunds", "Refunds", "Refunds", "currency", "down", "Commerce", "Refunds, booked on the refund date."),
  base("netSales", "Net sales", "Net Sales", "currency", "up", "Commerce", "Net sales = Gross sales − Discounts − Refunds"),
  base("shipping", "Shipping charged", "Shipping", "currency", "neutral", "Commerce", "Shipping charged to customers."),
  base("taxes", "Taxes", "Taxes", "currency", "neutral", "Commerce", "Taxes collected."),
  base("cogs", "COGS", "COGS", "currency", "down", "Commerce", "Cost of goods sold (Shopify unit cost or manual override)."),
  base("newCustomers", "New customers", "New Cust.", "number", "up", "Commerce", "Orders whose customer had no previous order."),
  base("returningOrders", "Returning orders", "Ret. Orders", "number", "up", "Commerce", "Orders from customers with a previous order."),
  base(
    "newCustomerRevenue",
    "New customer revenue",
    "New Rev.",
    "currency",
    "up",
    "Commerce",
    "Revenue (gross − discounts) from first orders.",
  ),
  base(
    "returningCustomerRevenue",
    "Returning customer revenue",
    "Ret. Rev.",
    "currency",
    "up",
    "Commerce",
    "Revenue (gross − discounts) from repeat orders.",
  ),
  derived(
    "aov",
    "AOV",
    "AOV",
    "currency",
    "up",
    "Commerce",
    "(Gross sales − Discounts) / Orders",
    "Average order value from Shopify.",
    (t) => {
      const g = v(t, "grossSales"),
        d = v(t, "discounts");
      return div(g === null ? null : g - (d ?? 0), v(t, "orders"));
    },
  ),
  derived(
    "refundRate",
    "Refund rate",
    "Refund %",
    "percent",
    "down",
    "Commerce",
    "Refunds / Gross sales",
    "Share of gross sales refunded.",
    (t) => div(v(t, "refunds"), v(t, "grossSales")),
  ),
  base("units", "Units sold", "Units", "number", "up", "Commerce", "Quantity of items sold."),
  base("refundCount", "Refunds (count)", "# Refunds", "number", "down", "Commerce", "Number of refunds issued."),
  base("otherRevenue", "Other revenue", "Other Rev.", "currency", "up", "Commerce", "Revenue from other sources (manual, CSV, webhook)."),
  base("otherOrders", "Other orders", "Other Orders", "number", "up", "Commerce", "Orders from other revenue sources."),
  base(
    "attributedRevenue",
    "Shopify attributed revenue",
    "Shopify Attr. Rev.",
    "currency",
    "up",
    "Commerce",
    "Shopify revenue attributed to the channel by UTM (last click).",
  ),

  // ── Blended (the Northbeam / Triple Whale replacements) ──
  base("totalRevenue", "Total revenue", "Total Revenue", "currency", "up", "Blended", "Total revenue = Shopify net sales + Other revenue"),
  base(
    "platformRevenue",
    "Platform-reported revenue",
    "Platform Rev.",
    "currency",
    "neutral",
    "Blended",
    "Sum of revenue reported by all ad platforms.",
  ),
  derived(
    "mer",
    "MER",
    "MER",
    "ratio",
    "up",
    "Blended",
    "Total Revenue / Total Ad Spend",
    "Marketing efficiency ratio (blended ROAS).",
    (t) => div(v(t, "totalRevenue"), v(t, "spend")),
  ),
  derived(
    "amer",
    "aMER",
    "aMER",
    "ratio",
    "up",
    "Blended",
    "New customer revenue / Total Ad Spend",
    "Acquisition MER — only first-order revenue counts.",
    (t) => div(v(t, "newCustomerRevenue"), v(t, "spend")),
  ),
  derived(
    "ncac",
    "nCAC",
    "nCAC",
    "currency",
    "down",
    "Blended",
    "Total Ad Spend / New customers",
    "Blended cost to acquire a new customer.",
    (t) => div(v(t, "spend"), v(t, "newCustomers")),
  ),
  derived(
    "newCustomerPct",
    "New customer %",
    "New %",
    "percent",
    "up",
    "Blended",
    "New customers / Orders",
    "Share of orders from new customers.",
    (t) => div(v(t, "newCustomers"), v(t, "orders")),
  ),
  derived(
    "contributionMargin",
    "Contribution margin",
    "Contrib. Margin",
    "currency",
    "up",
    "Blended",
    "Net sales + Other revenue − COGS − Shipping cost − Payment fees − Ad spend",
    "What is left after variable costs and ads (detailed in P&L).",
    (t) => {
      const ns = v(t, "netSales");
      if (ns === null) return null;
      return ns + (v(t, "otherRevenue") ?? 0) - (v(t, "cogs") ?? 0) - (v(t, "paymentFees") ?? 0) - (v(t, "spend") ?? 0);
    },
  ),
  derived(
    "grossMarginPct",
    "Gross margin %",
    "GM %",
    "percent",
    "up",
    "Blended",
    "(Net sales − COGS) / Net sales",
    "Product margin after COGS.",
    (t) => {
      const ns = v(t, "netSales"),
        c = v(t, "cogs");
      return ns === null || c === null ? null : div(ns - c, ns);
    },
  ),
  derived(
    "breakevenRoas",
    "Breakeven ROAS",
    "BE ROAS",
    "ratio",
    "neutral",
    "Blended",
    "1 / Gross margin %",
    "ROAS at which first-order profit is zero.",
    (t) => {
      const ns = v(t, "netSales"),
        c = v(t, "cogs");
      if (ns === null || c === null) return null;
      return div(1, div(ns - c, ns));
    },
  ),
  derived(
    "breakevenCpa",
    "Breakeven CPA",
    "BE CPA",
    "currency",
    "neutral",
    "Blended",
    "AOV × Gross margin %",
    "CPA at which first-order profit is zero.",
    (t) => {
      const g = v(t, "grossSales"),
        d = v(t, "discounts"),
        ns = v(t, "netSales"),
        c = v(t, "cogs");
      const aov = div(g === null ? null : g - (d ?? 0), v(t, "orders"));
      const gm = ns === null || c === null ? null : div(ns - c, ns);
      return aov === null || gm === null ? null : aov * gm;
    },
  ),
  derived(
    "attributionDiscrepancy",
    "Attribution discrepancy",
    "Attr. Gap",
    "percent",
    "neutral",
    "Blended",
    "(Platform-reported revenue − Shopify net sales) / Shopify net sales",
    "How much the ad platforms over- (positive) or under-report vs real revenue.",
    (t) => {
      const p = v(t, "platformRevenue"),
        ns = v(t, "netSales");
      return p === null || ns === null ? null : div(p - ns, ns);
    },
  ),
];

export const METRIC_MAP: Record<string, MetricDef> = Object.fromEntries(METRICS.map((m) => [m.key, m]));

export function getMetric(key: string): MetricDef {
  const m = METRIC_MAP[key];
  if (!m) throw new Error(`Unknown metric: ${key}`);
  return m;
}

export function computeMetric(key: string, t: Totals): number | null {
  return getMetric(key).compute(t);
}

/** Sum a list of Totals. A key stays null only if it is null/undefined in every row. */
export function sumTotals(rows: Totals[]): Totals {
  const out: Totals = {};
  for (const k of BASE_KEYS) {
    let seen = false;
    let s = 0;
    for (const r of rows) {
      const x = r[k];
      if (x !== null && x !== undefined && !Number.isNaN(x)) {
        seen = true;
        s += x;
      }
    }
    out[k] = seen ? s : null;
  }
  return out;
}

// ───────────────────────── Comparison colour rule ─────────────────────────

export const DEFAULT_THRESHOLD_PCT = 2;

export interface Comparison {
  current: number | null;
  previous: number | null;
  /** % change; null when previous is missing or 0. */
  deltaPct: number | null;
  arrow: "up" | "down" | null;
  tone: Tone;
}

/**
 * Green when better, red when worse, grey when |Δ| < threshold or the metric is neutral.
 * "Better" depends on the metric's direction.
 */
export function compareValues(
  direction: MetricDirection,
  current: number | null,
  previous: number | null,
  thresholdPct: number = DEFAULT_THRESHOLD_PCT,
): Comparison {
  if (current === null || previous === null || previous === 0) {
    return { current, previous, deltaPct: null, arrow: null, tone: "neutral" };
  }
  const deltaPct = ((current - previous) / Math.abs(previous)) * 100;
  const arrow = deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : null;
  let tone: Tone = "neutral";
  if (direction !== "neutral" && Math.abs(deltaPct) >= thresholdPct) {
    const improved = direction === "up" ? deltaPct > 0 : deltaPct < 0;
    tone = improved ? "good" : "bad";
  }
  return { current, previous, deltaPct, arrow, tone };
}

export function compareMetric(key: string, current: Totals, previous: Totals | null, thresholdPct?: number): Comparison {
  const m = getMetric(key);
  return compareValues(m.direction, m.compute(current), previous ? m.compute(previous) : null, thresholdPct);
}

/** Compare against a target: the target plays the role of "previous". */
export function compareToTarget(key: string, value: number | null, target: number | null | undefined, thresholdPct?: number): Comparison {
  return compareValues(getMetric(key).direction, value, target ?? null, thresholdPct);
}
