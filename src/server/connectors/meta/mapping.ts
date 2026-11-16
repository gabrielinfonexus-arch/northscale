/**
 * Pure mapping from Meta Marketing API payloads to NorthScale's normalized rows.
 * No I/O here — everything is unit-tested with recorded/mocked payloads.
 */

export interface MetaAction {
  action_type: string;
  value?: string;
  [window: string]: string | undefined;
}

export interface MetaInsightRow {
  date_start: string;
  date_stop?: string;
  account_id?: string;
  account_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
  video_thruplay_watched_actions?: MetaAction[];
  results?: unknown;
  // breakdowns
  age?: string;
  gender?: string;
  country?: string;
  publisher_platform?: string;
  platform_position?: string;
  hourly_stats_aggregated_by_advertiser_time_zone?: string;
  user_segment_key?: string;
  [k: string]: unknown;
}

export type MetaLevel = "account" | "campaign" | "adset" | "ad";
export const LEVEL_ENUM = { account: "ACCOUNT", campaign: "CAMPAIGN", adset: "ADSET", ad: "AD" } as const;

/** Action types in order of preference — the first present wins, so the same event is never counted twice. */
export const ACTION_TYPES = {
  purchases: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "onsite_web_app_purchase"],
  addToCart: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"],
  initiateCheckout: ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"],
  leads: ["lead", "onsite_conversion.lead_grouped", "leadgen_grouped", "offsite_conversion.fb_pixel_lead"],
  completeRegistration: ["omni_complete_registration", "complete_registration", "offsite_conversion.fb_pixel_complete_registration"],
  viewContent: ["omni_view_content", "view_content", "offsite_conversion.fb_pixel_view_content"],
  videoViews3s: ["video_view"],
} as const;

/** Windows requested via `action_attribution_windows`; "value" is the account's default setting. */
export const ATTRIBUTION_WINDOWS = ["7d_click", "1d_view", "1d_click"] as const;

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function pickAction(list: MetaAction[] | undefined, types: readonly string[], key = "value"): number | null {
  if (!list) return null;
  for (const t of types) {
    const a = list.find((x) => x.action_type === t);
    if (a) return num(a[key]) ?? 0;
  }
  return 0; // actions reported, none of this type → zero events
}

/** `results` changed shape across versions; accept a number, string, or [{ values: [{ value }] }]. */
export function parseResults(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "string") return num(v);
  if (Array.isArray(v)) {
    let s = 0;
    let seen = false;
    for (const item of v) {
      const vals = (item as { values?: { value?: string }[] })?.values;
      if (Array.isArray(vals))
        for (const x of vals) {
          const n = num(x?.value);
          if (n !== null) {
            s += n;
            seen = true;
          }
        }
    }
    return seen ? s : null;
  }
  return null;
}

export interface MappedMetrics {
  spend: number;
  impressions: number;
  reach: number | null;
  clicks: number;
  linkClicks: number | null;
  purchases: number;
  purchaseValue: number;
  addToCart: number | null;
  initiateCheckout: number | null;
  leads: number | null;
  completeRegistration: number | null;
  viewContent: number | null;
  results: number | null;
  resultsValue: number | null;
  videoViews3s: number | null;
  thruPlays: number | null;
}

export function mapMetrics(r: MetaInsightRow, window: "value" | (typeof ATTRIBUTION_WINDOWS)[number] = "value"): MappedMetrics {
  const purchases = pickAction(r.actions, ACTION_TYPES.purchases, window) ?? 0;
  const purchaseValue = pickAction(r.action_values, ACTION_TYPES.purchases, window) ?? 0;
  const leads = pickAction(r.actions, ACTION_TYPES.leads, window);
  const parsedResults = parseResults(r.results);
  return {
    spend: num(r.spend) ?? 0,
    impressions: num(r.impressions) ?? 0,
    reach: num(r.reach), // being retired by Meta in favour of "views" — null renders as "—"
    clicks: num(r.clicks) ?? 0,
    linkClicks: num(r.inline_link_clicks),
    purchases,
    purchaseValue,
    addToCart: pickAction(r.actions, ACTION_TYPES.addToCart, window),
    initiateCheckout: pickAction(r.actions, ACTION_TYPES.initiateCheckout, window),
    leads,
    completeRegistration: pickAction(r.actions, ACTION_TYPES.completeRegistration, window),
    viewContent: pickAction(r.actions, ACTION_TYPES.viewContent, window),
    results: parsedResults ?? (purchases > 0 ? purchases : (leads ?? 0)),
    resultsValue: purchaseValue,
    videoViews3s: r.actions ? pickAction(r.actions, ACTION_TYPES.videoViews3s) : null,
    thruPlays: r.video_thruplay_watched_actions ? pickAction(r.video_thruplay_watched_actions, ["video_view"]) : null,
  };
}

/** Compact map of every action (kept at account/campaign level for the AI). */
export function actionExtras(r: MetaInsightRow): Record<string, Record<string, number>> | null {
  if (!r.actions && !r.action_values) return null;
  const toMap = (l?: MetaAction[]) => Object.fromEntries((l ?? []).map((a) => [a.action_type, num(a.value) ?? 0]));
  return { actions: toMap(r.actions), values: toMap(r.action_values) };
}

export interface EntityKey {
  entityId: string;
  entityName: string;
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  adId: string | null;
}

export function entityOf(r: MetaInsightRow, level: MetaLevel, accountExternalId: string, accountName: string): EntityKey {
  const base = {
    campaignId: r.campaign_id ?? null,
    campaignName: r.campaign_name ?? null,
    adsetId: r.adset_id ?? null,
    adsetName: r.adset_name ?? null,
    adId: r.ad_id ?? null,
  };
  switch (level) {
    case "account":
      return { ...base, entityId: accountExternalId, entityName: r.account_name ?? accountName };
    case "campaign":
      return { ...base, entityId: r.campaign_id!, entityName: r.campaign_name ?? r.campaign_id! };
    case "adset":
      return { ...base, entityId: r.adset_id!, entityName: r.adset_name ?? r.adset_id! };
    case "ad":
      return { ...base, entityId: r.ad_id!, entityName: r.ad_name ?? r.ad_id! };
  }
}

// ───────────────────────── breakdowns ─────────────────────────

export const BREAKDOWNS = [
  { type: "AGE", fields: ["age"] },
  { type: "GENDER", fields: ["gender"] },
  { type: "PLACEMENT", fields: ["publisher_platform", "platform_position"] },
  { type: "COUNTRY", fields: ["country"] },
  { type: "HOUR", fields: ["hourly_stats_aggregated_by_advertiser_time_zone"] },
  { type: "AUDIENCE_TYPE", fields: ["user_segment_key"] },
] as const;
export type MetaBreakdownType = (typeof BREAKDOWNS)[number]["type"];

const PUBLISHER: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  audience_network: "Audience Network",
  messenger: "Messenger",
  threads: "Threads",
  whatsapp: "WhatsApp",
};
const POSITION: Record<string, string> = {
  feed: "Feed",
  story: "Stories",
  instagram_stories: "Stories",
  facebook_stories: "Stories",
  instagram_reels: "Reels",
  facebook_reels: "Reels",
  facebook_reels_overlay: "Reels overlay",
  marketplace: "Marketplace",
  video_feeds: "Video feeds",
  right_hand_column: "Right column",
  instagram_explore: "Explore",
  instagram_explore_grid_home: "Explore home",
  instagram_profile_feed: "Profile feed",
  profile_feed: "Profile feed",
  messenger_inbox: "Inbox",
  messenger_stories: "Stories",
  search: "Search results",
  instream_video: "In-stream video",
  an_classic: "Native, banner & interstitial",
  rewarded_video: "Rewarded video",
  threads_feed: "Feed",
};
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function breakdownValue(type: MetaBreakdownType, r: MetaInsightRow): string {
  switch (type) {
    case "AGE":
      return r.age ?? "unknown";
    case "GENDER":
      return r.gender ?? "unknown";
    case "COUNTRY":
      return r.country ?? "unknown";
    case "PLACEMENT": {
      const p = r.publisher_platform ?? "unknown";
      const pos = r.platform_position ?? "unknown";
      return `${PUBLISHER[p] ?? titleCase(p)} · ${POSITION[pos] ?? titleCase(pos)}`;
    }
    case "HOUR": {
      const h = r.hourly_stats_aggregated_by_advertiser_time_zone ?? "";
      return /^\d{2}/.test(h) ? h.slice(0, 2) : "unknown";
    }
    case "AUDIENCE_TYPE":
      return audienceLabel(r.user_segment_key);
  }
}

/** Audience segments (New / Engaged / Existing). Raw keys vary, so match loosely. */
export function audienceLabel(key: string | undefined): string {
  const k = (key ?? "").toLowerCase();
  if (k.includes("new")) return "New audience";
  if (k.includes("engag")) return "Engaged audience";
  if (k.includes("exist") || k.includes("customer")) return "Existing customers";
  return key ? titleCase(key) : "Unknown";
}

// ───────────────────────── entities, creatives, account ─────────────────────────

export interface MetaAd {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  adset_id?: string;
  campaign_id?: string;
  ad_review_feedback?: { global?: Record<string, string>; placement_specific?: Record<string, Record<string, string>> };
  creative?: MetaCreative;
}

export interface MetaCreative {
  id?: string;
  name?: string;
  object_type?: string;
  thumbnail_url?: string;
  image_url?: string;
  title?: string;
  body?: string;
  video_id?: string;
  link_url?: string;
  object_story_spec?: {
    link_data?: {
      link?: string;
      message?: string;
      name?: string;
      child_attachments?: unknown[];
      call_to_action?: { value?: { link?: string } };
    };
    video_data?: { title?: string; message?: string; image_url?: string; call_to_action?: { value?: { link?: string } } };
  };
  asset_feed_spec?: {
    titles?: { text?: string }[];
    bodies?: { text?: string }[];
    link_urls?: { website_url?: string }[];
    videos?: unknown[];
  };
}

export function reviewFeedback(ad: MetaAd): string | null {
  const f = ad.ad_review_feedback;
  if (!f) return null;
  const msgs = [...Object.entries(f.global ?? {}).map(([k, v]) => `${k}: ${v}`)];
  for (const [, per] of Object.entries(f.placement_specific ?? {})) for (const [k, v] of Object.entries(per)) msgs.push(`${k}: ${v}`);
  return msgs.length ? msgs.join("; ") : null;
}

export function mapCreative(ad: MetaAd) {
  const c = ad.creative ?? {};
  const link = c.object_story_spec?.link_data;
  const video = c.object_story_spec?.video_data;
  const feed = c.asset_feed_spec;
  const isVideo = c.object_type === "VIDEO" || !!c.video_id || !!video || !!feed?.videos?.length;
  const isCarousel = !!link?.child_attachments?.length;
  return {
    externalId: c.id ?? null,
    name: c.name ?? ad.name,
    type: isVideo ? "VIDEO" : isCarousel ? "CAROUSEL" : "IMAGE",
    thumbnailUrl: c.thumbnail_url ?? c.image_url ?? video?.image_url ?? null,
    headline: c.title ?? link?.name ?? video?.title ?? feed?.titles?.[0]?.text ?? null,
    body: c.body ?? link?.message ?? video?.message ?? feed?.bodies?.[0]?.text ?? null,
    landingUrl:
      link?.link ??
      link?.call_to_action?.value?.link ??
      video?.call_to_action?.value?.link ??
      c.link_url ??
      feed?.link_urls?.[0]?.website_url ??
      null,
  };
}

/** https://developers.facebook.com/docs/marketing-api/reference/ad-account — account_status codes */
export const ACCOUNT_STATUS: Record<number, { label: string; ok: boolean }> = {
  1: { label: "Active", ok: true },
  2: { label: "Disabled", ok: false },
  3: { label: "Unsettled (payment issue)", ok: false },
  7: { label: "Pending risk review", ok: false },
  8: { label: "Pending settlement", ok: false },
  9: { label: "In grace period", ok: true },
  100: { label: "Pending closure", ok: false },
  101: { label: "Closed", ok: false },
  201: { label: "Any active", ok: true },
  202: { label: "Any closed", ok: false },
};

export function normalizeAccountId(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}
