/**
 * NorthScale's own attribution: classify a Shopify order's visit (UTMs, click ids, referrer) into a channel.
 * Used for first click and last click. Pure function, unit-tested.
 */
export type Channel = "META" | "GOOGLE" | "EMAIL" | "ORGANIC" | "DIRECT" | "OTHER";

export interface VisitInfo {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  landingPage?: string | null;
  referrer?: string | null;
}

const META_SOURCES = new Set(["facebook", "fb", "ig", "instagram", "meta", "an", "audience_network", "messenger", "threads"]);
const GOOGLE_SOURCES = new Set(["google", "adwords", "youtube", "googleads", "google_ads"]);
const PAID_MEDIA = new Set([
  "cpc",
  "ppc",
  "paid",
  "paidsearch",
  "paid_search",
  "paid-search",
  "cpm",
  "display",
  "video",
  "pmax",
  "shopping",
  "paid_social",
  "paidsocial",
  "paid-social",
  "ads",
]);
const EMAIL_SOURCES = new Set([
  "klaviyo",
  "mailchimp",
  "omnisend",
  "sendgrid",
  "newsletter",
  "activecampaign",
  "drip",
  "hubspot",
  "rdstation",
]);
const EMAIL_MEDIA = new Set(["email", "e-mail", "newsletter", "flow", "campaign_email"]);
const SEARCH_ENGINES = /(^|\.)(google|bing|yahoo|duckduckgo|ecosia|yandex|baidu|search\.brave)\./i;
const SOCIAL = /(^|\.)(facebook|instagram|t\.co|twitter|x\.com|tiktok|pinterest|youtube|linkedin|reddit|threads)\./i;

function params(url: string | null | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  try {
    return new URL(url, "https://shop.example").searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function host(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase() + ".";
  } catch {
    return "";
  }
}

export function classifyChannel(v: VisitInfo): Channel {
  const p = params(v.landingPage);
  const src = (v.utmSource ?? p.get("utm_source") ?? "").trim().toLowerCase();
  const med = (v.utmMedium ?? p.get("utm_medium") ?? "").trim().toLowerCase();

  if (p.has("fbclid") || META_SOURCES.has(src)) return "META";
  if (
    p.has("gclid") ||
    p.has("gbraid") ||
    p.has("wbraid") ||
    p.has("gad_source") ||
    (GOOGLE_SOURCES.has(src) && (PAID_MEDIA.has(med) || med === ""))
  )
    return "GOOGLE";
  if (EMAIL_MEDIA.has(med) || EMAIL_SOURCES.has(src)) return "EMAIL";
  if (src || med) return src === "google" || src === "bing" ? (med === "organic" ? "ORGANIC" : "OTHER") : "OTHER";

  const ref = host(v.referrer);
  if (!ref) return "DIRECT";
  if (SEARCH_ENGINES.test(ref) || SOCIAL.test(ref)) return "ORGANIC";
  return "OTHER";
}
