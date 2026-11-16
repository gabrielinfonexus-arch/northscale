/**
 * Deterministic fake of the Meta Graph API, for local development and tests when graph.facebook.com
 * is unreachable or no Meta app exists yet. Enabled with META_MOCK=1 (refused in production).
 * Shapes follow the real API responses that the connector reads.
 */
const ACCOUNTS = [
  {
    id: "act_900100200",
    account_id: "900100200",
    name: "Mock Brand – Prospecting",
    currency: "USD",
    timezone_name: "America/New_York",
    account_status: 1,
    business: { name: "Mock Business" },
  },
  {
    id: "act_900100300",
    account_id: "900100300",
    name: "Mock Brand – Retargeting",
    currency: "USD",
    timezone_name: "America/New_York",
    account_status: 1,
    business: { name: "Mock Business" },
  },
  {
    id: "act_900100400",
    account_id: "900100400",
    name: "Mock Marca – Brasil",
    currency: "BRL",
    timezone_name: "America/Sao_Paulo",
    account_status: 3,
    business: { name: "Mock Business" },
  },
];

interface Ad {
  id: string;
  name: string;
  adset: string;
  campaign: string;
  video: boolean;
}

function structure(account: string) {
  const n = account.slice(-3);
  const campaigns = [
    { id: `${n}01`, name: "PROSP | Broad | Sales", objective: "OUTCOME_SALES", smart_promotion_type: "AUTOMATED_SHOPPING_ADS" },
    { id: `${n}02`, name: "RT | DPA | Viewed 14d", objective: "OUTCOME_SALES" },
  ];
  const adsets = campaigns.flatMap((c, i) =>
    [0, 1].map((j) => ({
      id: `${c.id}${j}`,
      name: `${c.name.split("|")[0].trim()} | Ad set ${j + 1}`,
      campaign_id: c.id,
      w: i === 0 ? 0.7 : 0.3,
    })),
  );
  const ads: Ad[] = adsets.flatMap((s) =>
    [0, 1].map((k) => ({
      id: `${s.id}${k}`,
      name: `${k ? "IMG" : "VID"} | Creative ${s.id}${k}`,
      adset: s.id,
      campaign: s.campaign_id,
      video: k === 0,
    })),
  );
  return { campaigns, adsets, ads };
}

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return (h % 10_000) / 10_000;
}

function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000))
    out.push(d.toISOString().slice(0, 10));
  return out;
}

/** Ad-level metrics for a day; every other level is a sum of these, so levels always reconcile. */
function adDay(account: string, ad: Ad, day: string) {
  const r = hash(account + ad.id + day);
  const spend = (Math.round((40 + 160 * r) * 100) / 100) * (ad.campaign.endsWith("01") ? 1.6 : 0.6);
  const impressions = Math.round(spend * (55 + 20 * r));
  const clicks = Math.round(impressions * (0.012 + 0.01 * hash(day + ad.id)));
  const atc = Math.round(clicks * 0.1);
  const ic = Math.round(atc * 0.35);
  const purchases = Math.round(ic * (0.4 + 0.3 * r));
  const value = Math.round(purchases * (60 + 30 * r) * 100) / 100;
  return {
    spend,
    impressions,
    reach: Math.round(impressions / 1.4),
    clicks,
    link: Math.round(clicks * 0.7),
    atc,
    ic,
    purchases,
    value,
    v3: ad.video ? Math.round(impressions * 0.3) : 0,
    thru: ad.video ? Math.round(impressions * 0.06) : 0,
  };
}

type Day = ReturnType<typeof adDay>;
const sum = (xs: Day[]): Day =>
  xs.reduce(
    (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, Math.round(((a as never)[k] + (b as never)[k]) * 100) / 100])) as Day,
  );

function toRow(day: string, m: Day, ids: Record<string, string>, withWindows: boolean) {
  const w = (v: number) =>
    withWindows
      ? { "7d_click": String(Math.round(v * 0.85)), "1d_click": String(Math.round(v * 0.6)), "1d_view": String(Math.round(v * 0.1)) }
      : {};
  return {
    date_start: day,
    date_stop: day,
    ...ids,
    spend: String(m.spend),
    impressions: String(m.impressions),
    reach: String(m.reach),
    clicks: String(m.clicks),
    inline_link_clicks: String(m.link),
    actions: [
      { action_type: "link_click", value: String(m.link) },
      { action_type: "video_view", value: String(m.v3) },
      { action_type: "omni_add_to_cart", value: String(m.atc), ...w(m.atc) },
      { action_type: "omni_initiated_checkout", value: String(m.ic) },
      { action_type: "omni_purchase", value: String(m.purchases), ...w(m.purchases) },
    ],
    action_values: [{ action_type: "omni_purchase", value: String(m.value), ...w(m.value) }],
    video_thruplay_watched_actions: [{ action_type: "video_view", value: String(m.thru) }],
  };
}

const SEGMENTS: Record<string, [Record<string, string>, number][]> = {
  age: ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"].map((a, i) => [{ age: a }, [0.1, 0.3, 0.27, 0.18, 0.1, 0.05][i]]),
  gender: [
    [{ gender: "female" }, 0.65],
    [{ gender: "male" }, 0.32],
    [{ gender: "unknown" }, 0.03],
  ],
  "publisher_platform,platform_position": [
    [{ publisher_platform: "facebook", platform_position: "feed" }, 0.3],
    [{ publisher_platform: "instagram", platform_position: "feed" }, 0.25],
    [{ publisher_platform: "instagram", platform_position: "instagram_reels" }, 0.25],
    [{ publisher_platform: "instagram", platform_position: "instagram_stories" }, 0.2],
  ],
  country: [
    [{ country: "US" }, 0.85],
    [{ country: "CA" }, 0.15],
  ],
  hourly_stats_aggregated_by_advertiser_time_zone: Array.from({ length: 24 }, (_, h) => [
    { hourly_stats_aggregated_by_advertiser_time_zone: `${String(h).padStart(2, "0")}:00:00 - ${String(h).padStart(2, "0")}:59:59` },
    h < 6 ? 0.01 : h > 17 ? 0.07 : 0.045,
  ]),
  user_segment_key: [
    [{ user_segment_key: "new_users" }, 0.7],
    [{ user_segment_key: "engaged_users" }, 0.2],
    [{ user_segment_key: "existing_customers" }, 0.1],
  ],
};

function scale(m: Day, f: number): Day {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v * f * 100) / 100])) as Day;
}

function insights(account: string, q: URLSearchParams) {
  const { campaigns, adsets, ads } = structure(account);
  const tr = JSON.parse(q.get("time_range") ?? "{}") as { since: string; until: string };
  const level = q.get("level") ?? "account";
  const breakdowns = q.get("breakdowns");
  const withWindows = !!q.get("action_attribution_windows");
  const acc = ACCOUNTS.find((a) => a.id === account)!;
  const rows: unknown[] = [];
  for (const day of eachDay(tr.since, tr.until)) {
    const perAd = new Map(ads.map((a) => [a.id, adDay(account, a, day)]));
    const of = (pred: (a: Ad) => boolean) => sum(ads.filter(pred).map((a) => perAd.get(a.id)!));
    if (breakdowns) {
      for (const c of campaigns) {
        const m = of((a) => a.campaign === c.id);
        const segs = SEGMENTS[breakdowns] ?? [];
        const total = segs.reduce((acc, [, w]) => acc + w, 0) || 1;
        for (const [seg, w0] of segs) {
          const w = w0 / total;
          rows.push(toRow(day, scale(m, w), { campaign_id: c.id, campaign_name: c.name, ...seg }, false));
        }
      }
      continue;
    }
    if (level === "account")
      rows.push(
        toRow(
          day,
          of(() => true),
          { account_id: acc.account_id, account_name: acc.name },
          withWindows,
        ),
      );
    if (level === "campaign")
      for (const c of campaigns)
        rows.push(
          toRow(
            day,
            of((a) => a.campaign === c.id),
            { campaign_id: c.id, campaign_name: c.name },
            false,
          ),
        );
    if (level === "adset")
      for (const s of adsets)
        rows.push(
          toRow(
            day,
            of((a) => a.adset === s.id),
            {
              campaign_id: s.campaign_id,
              campaign_name: campaigns.find((c) => c.id === s.campaign_id)!.name,
              adset_id: s.id,
              adset_name: s.name,
            },
            false,
          ),
        );
    if (level === "ad")
      for (const a of ads) {
        const s = adsets.find((x) => x.id === a.adset)!;
        rows.push(
          toRow(
            day,
            perAd.get(a.id)!,
            {
              campaign_id: a.campaign,
              campaign_name: campaigns.find((c) => c.id === a.campaign)!.name,
              adset_id: s.id,
              adset_name: s.name,
              ad_id: a.id,
              ad_name: a.name,
            },
            false,
          ),
        );
      }
  }
  return rows;
}

function route(path: string, q: URLSearchParams): unknown {
  const parts = path.split("/").filter(Boolean); // [version, ...]
  const p = parts.slice(1);
  if (p[0] === "me" && p.length === 1) return { id: "10001", name: "Mock User" };
  if (p[0] === "me" && p[1] === "permissions")
    return { data: ["ads_read", "business_management", "leads_retrieval"].map((permission) => ({ permission, status: "granted" })) };
  if (p[0] === "me" && p[1] === "adaccounts") return { data: ACCOUNTS };
  if (p[0] === "oauth" && p[1] === "access_token") return { access_token: "mock-long-lived-token", expires_in: 60 * 86_400 };
  const account = p[0];
  const acc = ACCOUNTS.find((a) => a.id === account);
  if (!acc) return { __error: { status: 404, body: { error: { code: 803, message: "Unknown object" } } } };
  const { campaigns, adsets, ads } = structure(account);
  if (p.length === 1)
    return {
      name: acc.name,
      account_status: acc.account_status,
      disable_reason: acc.account_status === 1 ? 0 : 3,
      spend_cap: "5000000",
      amount_spent: "4120050",
      currency: acc.currency,
      timezone_name: acc.timezone_name,
    };
  switch (p[1]) {
    case "campaigns":
      return { data: campaigns.map((c) => ({ ...c, status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "50000" })) };
    case "adsets":
      return {
        data: adsets.map((s) => ({
          id: s.id,
          name: s.name,
          campaign_id: s.campaign_id,
          status: "ACTIVE",
          effective_status: "ACTIVE",
          attribution_spec: [
            { event_type: "CLICK_THROUGH", window_days: 7 },
            { event_type: "VIEW_THROUGH", window_days: 1 },
          ],
        })),
      };
    case "ads":
      return {
        data: ads.map((a, i) => ({
          id: a.id,
          name: a.name,
          adset_id: a.adset,
          campaign_id: a.campaign,
          status: "ACTIVE",
          effective_status: i === 3 ? "DISAPPROVED" : "ACTIVE",
          ...(i === 3 ? { ad_review_feedback: { global: { "Misleading claims": "Ad makes exaggerated health claims" } } } : {}),
          creative: {
            id: `cr${a.id}`,
            name: a.name,
            object_type: a.video ? "VIDEO" : "SHARE",
            thumbnail_url: `/api/demo/thumb/${a.id}`,
            ...(a.video ? { video_id: `v${a.id}` } : {}),
            object_story_spec: {
              link_data: {
                link: `https://mockbrand.example/products/${i % 3 === 0 ? "hero" : "bundle"}`,
                message: "Mock primary text",
                name: `Mock headline ${i + 1}`,
              },
            },
          },
        })),
      };
    case "insights":
      return { data: insights(account, q) };
  }
  return { data: [] };
}

/** fetch-compatible function that serves the fake API (with a small page size to exercise pagination). */
export const mockMetaFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const after = Number(url.searchParams.get("__offset") ?? 0);
  const result = route(url.pathname, url.searchParams) as { data?: unknown[]; __error?: { status: number; body: unknown } };
  const headers = {
    "content-type": "application/json",
    "x-app-usage": JSON.stringify({ call_count: 12, total_cputime: 4, total_time: 6 }),
  };
  if (result.__error) return new Response(JSON.stringify(result.__error.body), { status: result.__error.status, headers });
  if (Array.isArray(result.data)) {
    const PAGE = 400;
    const page = result.data.slice(after, after + PAGE);
    const body: Record<string, unknown> = { data: page };
    if (after + PAGE < result.data.length) {
      const next = new URL(url);
      next.searchParams.set("__offset", String(after + PAGE));
      body.paging = { next: next.toString() };
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  }
  return new Response(JSON.stringify(result), { status: 200, headers });
};

export function metaMockEnabled(): boolean {
  if (process.env.META_MOCK !== "1") return false;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_META_MOCK_IN_PROD !== "1")
    throw new Error("META_MOCK is not allowed in production");
  return true;
}
