/**
 * Pure mapping from Google Ads API (REST, camelCase JSON) rows to NorthScale's normalized rows.
 * int64 fields arrive as strings, money is in micros (÷ 1,000,000).
 */

export interface GaqlRow {
  customer?: {
    id?: string;
    descriptiveName?: string;
    currencyCode?: string;
    timeZone?: string;
    manager?: boolean;
    status?: string;
    testAccount?: boolean;
  };
  customerClient?: {
    id?: string;
    descriptiveName?: string;
    currencyCode?: string;
    timeZone?: string;
    manager?: boolean;
    status?: string;
    level?: string;
    clientCustomer?: string;
  };
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
    advertisingChannelSubType?: string;
    biddingStrategyType?: string;
  };
  campaignBudget?: { amountMicros?: string };
  adGroup?: { id?: string; name?: string; status?: string };
  adGroupAd?: {
    status?: string;
    ad?: {
      id?: string;
      name?: string;
      type?: string;
      finalUrls?: string[];
      responsiveSearchAd?: { headlines?: { text?: string }[]; descriptions?: { text?: string }[] };
    };
    policySummary?: { approvalStatus?: string; reviewStatus?: string; policyTopicEntries?: { topic?: string; type?: string }[] };
  };
  adGroupCriterion?: {
    criterionId?: string;
    status?: string;
    keyword?: { text?: string; matchType?: string };
    ageRange?: { type?: string };
    gender?: { type?: string };
  };
  searchTermView?: { searchTerm?: string; status?: string };
  geographicView?: { countryCriterionId?: string; locationType?: string };
  geoTargetConstant?: { id?: string; countryCode?: string };
  segments?: { date?: string; hour?: number; device?: string; conversionActionCategory?: string; dayOfWeek?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number;
    conversionsValue?: number;
    allConversions?: number;
    allConversionsValue?: number;
    viewThroughConversions?: string;
    searchImpressionShare?: number;
    videoTrueviewViews?: string;
  };
}

const n = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
export const micros = (v: unknown): number => Math.round(((n(v) ?? 0) / 1_000_000) * 1_000_000) / 1_000_000;

export interface GoogleMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  allConversions: number | null;
  viewThroughConv: number | null;
  searchImprShare: number | null;
  results: number;
  resultsValue: number;
  /** Google Ads reports neither reach nor link clicks */
  reach: null;
  linkClicks: null;
}

/** "Conv." = Google's primary conversions (what the account optimises for); value = conversions_value. */
export function mapMetrics(r: GaqlRow): GoogleMetrics {
  const m = r.metrics ?? {};
  const purchases = n(m.conversions) ?? 0;
  const value = n(m.conversionsValue) ?? 0;
  return {
    spend: micros(m.costMicros),
    impressions: n(m.impressions) ?? 0,
    clicks: n(m.clicks) ?? 0,
    purchases,
    purchaseValue: value,
    allConversions: n(m.allConversions),
    viewThroughConv: n(m.viewThroughConversions),
    searchImprShare: n(m.searchImpressionShare),
    results: purchases,
    resultsValue: value,
    reach: null,
    linkClicks: null,
  };
}

/**
 * Conversion action categories → funnel columns. Counted with all_conversions so secondary actions
 * (add to cart and checkout are usually not "primary") are still visible.
 */
export const CATEGORY_TO_FIELD: Record<string, "addToCart" | "initiateCheckout" | "leads" | "purchaseCategory"> = {
  ADD_TO_CART: "addToCart",
  BEGIN_CHECKOUT: "initiateCheckout",
  SUBMIT_LEAD_FORM: "leads",
  IMPORTED_LEAD: "leads",
  QUALIFIED_LEAD: "leads",
  CONVERTED_LEAD: "leads",
  CONTACT: "leads",
  REQUEST_QUOTE: "leads",
  BOOK_APPOINTMENT: "leads",
  SIGNUP: "leads",
  PURCHASE: "purchaseCategory",
};

export interface CategoryTotals {
  addToCart: number | null;
  initiateCheckout: number | null;
  leads: number | null;
  byCategory: Record<string, { conversions: number; value: number }>;
}

/** Fold per-category rows (same key) into funnel columns; a column stays null if the account has no such action. */
export function foldCategories(rows: GaqlRow[], present: Set<string>): CategoryTotals {
  const out: CategoryTotals = {
    addToCart: present.has("addToCart") ? 0 : null,
    initiateCheckout: present.has("initiateCheckout") ? 0 : null,
    leads: present.has("leads") ? 0 : null,
    byCategory: {},
  };
  for (const r of rows) {
    const cat = r.segments?.conversionActionCategory ?? "DEFAULT";
    const conv = n(r.metrics?.allConversions) ?? 0;
    const val = n(r.metrics?.allConversionsValue) ?? 0;
    const prev = out.byCategory[cat] ?? { conversions: 0, value: 0 };
    out.byCategory[cat] = { conversions: prev.conversions + conv, value: prev.value + val };
    const f = CATEGORY_TO_FIELD[cat];
    if (f && f !== "purchaseCategory") out[f] = (out[f] ?? 0) + conv;
  }
  return out;
}

// ───────────────────────── labels ─────────────────────────

export function campaignType(c: GaqlRow["campaign"]): string {
  const t = c?.advertisingChannelType ?? "UNKNOWN";
  if (t === "VIDEO") return "VIDEO";
  if (t === "MULTI_CHANNEL") return c?.advertisingChannelSubType?.includes("APP") ? "APP" : "MULTI_CHANNEL";
  return t; // SEARCH, DISPLAY, SHOPPING, PERFORMANCE_MAX, DEMAND_GEN, LOCAL, SMART, …
}

export function ageLabel(type: string | undefined): string {
  if (!type || type === "AGE_RANGE_UNDETERMINED") return "Undetermined";
  const m = /AGE_RANGE_(\d+)_(\d+|UP)/.exec(type);
  if (!m) return type;
  return m[2] === "UP" ? `${m[1]}+` : `${m[1]}-${m[2]}`;
}

export function genderLabel(type: string | undefined): string {
  return type === "MALE" ? "Male" : type === "FEMALE" ? "Female" : "Undetermined";
}

export function hourLabel(h: number | undefined): string {
  return h === undefined || h === null ? "unknown" : String(h).padStart(2, "0");
}

/** Country criterion ids (geo_target_constants) for the most common markets; others are looked up via the API. */
export const COUNTRY_BY_CRITERION: Record<string, string> = {
  "2840": "US",
  "2076": "BR",
  "2124": "CA",
  "2826": "GB",
  "2036": "AU",
  "2484": "MX",
  "2032": "AR",
  "2152": "CL",
  "2170": "CO",
  "2604": "PE",
  "2276": "DE",
  "2250": "FR",
  "2724": "ES",
  "2380": "IT",
  "2620": "PT",
  "2528": "NL",
  "2356": "IN",
  "2392": "JP",
  "2554": "NZ",
  "2372": "IE",
};

export function adName(r: GaqlRow): string {
  const ad = r.adGroupAd?.ad;
  if (ad?.name) return ad.name;
  const h = ad?.responsiveSearchAd?.headlines?.[0]?.text;
  const type = (ad?.type ?? "AD")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
  return h ? `${type} · ${h}` : `${type} ${ad?.id ?? ""}`.trim();
}

/** Disapproved / limited ads → message for the Watchdog and Data page notice. */
export function policyIssue(r: GaqlRow): string | null {
  const p = r.adGroupAd?.policySummary;
  if (!p || !p.approvalStatus || p.approvalStatus === "APPROVED") return null;
  if (p.approvalStatus !== "DISAPPROVED" && p.approvalStatus !== "APPROVED_LIMITED" && p.approvalStatus !== "AREA_OF_INTEREST_ONLY")
    return null;
  const topics = (p.policyTopicEntries ?? []).map((t) => t.topic).filter(Boolean);
  const label = p.approvalStatus === "DISAPPROVED" ? "Disapproved" : "Limited";
  return topics.length ? `${label}: ${topics.join(", ")}` : label;
}

export const CUSTOMER_STATUS_OK = new Set(["ENABLED"]);
