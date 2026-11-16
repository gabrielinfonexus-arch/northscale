/** Platform tabs and their sub-tabs on the Data page. */
export type DataPlatform = "all" | "google" | "meta" | "shopify" | "other";

export const PLATFORM_TABS: { id: DataPlatform; label: string }[] = [
  { id: "all", label: "All Platforms" },
  { id: "google", label: "Google" },
  { id: "meta", label: "Meta" },
  { id: "shopify", label: "Shopify" },
  { id: "other", label: "Other Revenue" },
];

export const SUB_TABS: Record<DataPlatform, { id: string; label: string }[]> = {
  all: [
    { id: "core", label: "Core" },
    { id: "day-of-week", label: "Day of Week" },
  ],
  meta: [
    { id: "core", label: "Core" },
    { id: "creatives", label: "Ad Creatives" },
    { id: "lead-gen", label: "Lead Gen" },
    { id: "age", label: "Age" },
    { id: "gender", label: "Gender" },
    { id: "placements", label: "Placements" },
    { id: "countries", label: "Countries" },
    { id: "audience", label: "Audience Types" },
    { id: "landing", label: "Landing Destination" },
    { id: "hour", label: "Hour of Day" },
    { id: "day-of-week", label: "Day of Week" },
    { id: "campaigns", label: "Campaigns" },
    { id: "adsets", label: "Ad Sets" },
    { id: "ads", label: "Ads" },
  ],
  google: [
    { id: "core", label: "Core" },
    { id: "campaigns", label: "Campaigns" },
    { id: "adsets", label: "Ad Groups" },
    { id: "ads", label: "Ads" },
    { id: "keywords", label: "Keywords" },
    { id: "search-terms", label: "Search Terms" },
    { id: "age", label: "Age" },
    { id: "gender", label: "Gender" },
    { id: "device", label: "Device" },
    { id: "countries", label: "Countries" },
    { id: "hour", label: "Hour of Day" },
    { id: "day-of-week", label: "Day of Week" },
    { id: "campaign-type", label: "Campaign Type" },
  ],
  shopify: [
    { id: "core", label: "Core" },
    { id: "products", label: "Products" },
    { id: "new-vs-returning", label: "New vs Returning" },
    { id: "discount-codes", label: "Discount Codes" },
    { id: "channels", label: "Channels (UTM)" },
    { id: "refunds", label: "Refunds" },
  ],
  other: [
    { id: "core", label: "Core" },
    { id: "sources", label: "Sources" },
  ],
};

export function resolveTabs(platform?: string, tab?: string): { platform: DataPlatform; tab: string } {
  const p = (PLATFORM_TABS.find((t) => t.id === platform)?.id ?? "meta") as DataPlatform;
  const t = SUB_TABS[p].find((s) => s.id === tab)?.id ?? "core";
  return { platform: p, tab: t };
}
