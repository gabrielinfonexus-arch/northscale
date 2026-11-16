import { describe, expect, it, vi } from "vitest";
import { MetaClient, classifyMetaError, parseUsageHeaders } from "@/server/connectors/meta/client";
import {
  audienceLabel,
  breakdownValue,
  mapCreative,
  mapMetrics,
  parseResults,
  reviewFeedback,
  type MetaInsightRow,
} from "@/server/connectors/meta/mapping";
import { chunkRange } from "@/lib/periods";

/** Recorded-style insight row (shape of /act_x/insights?level=campaign&time_increment=1 with attribution windows). */
const ROW: MetaInsightRow = {
  date_start: "2026-11-10",
  date_stop: "2026-11-10",
  campaign_id: "120210001",
  campaign_name: "PROSP | ASC+",
  spend: "1019.69",
  impressions: "124206",
  reach: "80112",
  clicks: "2126",
  inline_link_clicks: "1544",
  actions: [
    { action_type: "link_click", value: "1544" },
    { action_type: "video_view", value: "31050" },
    { action_type: "omni_add_to_cart", value: "1291", "7d_click": "1200", "1d_click": "900" },
    { action_type: "add_to_cart", value: "1291" },
    { action_type: "omni_initiated_checkout", value: "266" },
    { action_type: "omni_purchase", value: "134", "7d_click": "120", "1d_click": "88", "1d_view": "14" },
    { action_type: "purchase", value: "134" },
    { action_type: "offsite_conversion.fb_pixel_purchase", value: "134" },
  ],
  action_values: [
    { action_type: "omni_purchase", value: "10621.59", "7d_click": "9500.10", "1d_click": "7000" },
    { action_type: "purchase", value: "10621.59" },
  ],
  video_thruplay_watched_actions: [{ action_type: "video_view", value: "6210" }],
};

describe("Meta insights mapping", () => {
  it("maps base metrics and counts each event once (omni_* wins)", () => {
    const m = mapMetrics(ROW);
    expect(m).toMatchObject({
      spend: 1019.69,
      impressions: 124206,
      reach: 80112,
      clicks: 2126,
      linkClicks: 1544,
      purchases: 134,
      purchaseValue: 10621.59,
      addToCart: 1291,
      initiateCheckout: 266,
      videoViews3s: 31050,
      thruPlays: 6210,
      results: 134,
      resultsValue: 10621.59,
    });
  });

  it("reads attribution windows", () => {
    expect(mapMetrics(ROW, "7d_click")).toMatchObject({ purchases: 120, purchaseValue: 9500.1, addToCart: 1200 });
    expect(mapMetrics(ROW, "1d_click")).toMatchObject({ purchases: 88, purchaseValue: 7000 });
  });

  it("missing fields become null (rendered as —), missing actions become 0", () => {
    const m = mapMetrics({
      date_start: "2026-11-10",
      spend: "10",
      impressions: "100",
      clicks: "1",
      actions: [{ action_type: "link_click", value: "1" }],
    });
    expect(m.reach).toBeNull();
    expect(m.thruPlays).toBeNull();
    expect(m.purchases).toBe(0);
    expect(m.addToCart).toBe(0);
    expect(mapMetrics({ date_start: "2026-11-10" }).addToCart).toBeNull();
  });

  it("lead campaigns: results fall back to leads", () => {
    const m = mapMetrics({
      date_start: "2026-11-10",
      spend: "50",
      actions: [
        { action_type: "lead", value: "7" },
        { action_type: "onsite_conversion.lead_grouped", value: "7" },
      ],
    });
    expect(m.leads).toBe(7);
    expect(m.results).toBe(7);
  });

  it("parses the `results` field in its different shapes", () => {
    expect(parseResults("12")).toBe(12);
    expect(parseResults([{ indicator: "actions:omni_purchase", values: [{ value: "5" }, { value: "2" }] }])).toBe(7);
    expect(parseResults(undefined)).toBeNull();
  });

  it("breakdown labels", () => {
    expect(breakdownValue("PLACEMENT", { date_start: "x", publisher_platform: "instagram", platform_position: "instagram_reels" })).toBe(
      "Instagram · Reels",
    );
    expect(breakdownValue("PLACEMENT", { date_start: "x", publisher_platform: "audience_network", platform_position: "an_classic" })).toBe(
      "Audience Network · Native, banner & interstitial",
    );
    expect(breakdownValue("HOUR", { date_start: "x", hourly_stats_aggregated_by_advertiser_time_zone: "07:00:00 - 07:59:59" })).toBe("07");
    expect(audienceLabel("new_users")).toBe("New audience");
    expect(audienceLabel("engaged_users")).toBe("Engaged audience");
    expect(audienceLabel("existing_customers")).toBe("Existing customers");
  });

  it("creatives: type, copy and landing URL", () => {
    expect(
      mapCreative({
        id: "1",
        name: "Ad",
        creative: {
          id: "c1",
          object_type: "VIDEO",
          video_id: "v",
          thumbnail_url: "https://t",
          object_story_spec: { video_data: { title: "Hook", message: "Body", call_to_action: { value: { link: "https://shop/p" } } } },
        },
      }),
    ).toMatchObject({ type: "VIDEO", headline: "Hook", body: "Body", landingUrl: "https://shop/p", thumbnailUrl: "https://t" });
    expect(
      mapCreative({
        id: "2",
        name: "Car",
        creative: { object_story_spec: { link_data: { link: "https://shop", child_attachments: [{}, {}] } } },
      }).type,
    ).toBe("CAROUSEL");
    expect(reviewFeedback({ id: "3", name: "x", ad_review_feedback: { global: { "Personal health": "Before/after images" } } })).toBe(
      "Personal health: Before/after images",
    );
  });
});

function res(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("Meta client", () => {
  it("follows pagination and sends the token as a header (not in the URL)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        res({ data: [{ id: 1 }, { id: 2 }], paging: { next: "https://graph.facebook.com/v26.0/act_1/campaigns?after=abc" } }),
      )
      .mockResolvedValueOnce(res({ data: [{ id: 3 }] }));
    const c = new MetaClient({ token: "SECRET", fetchImpl, sleep: async () => {} });
    const all = await c.all<{ id: number }>("act_1/campaigns", { fields: "id" });
    expect(all.map((x) => x.id)).toEqual([1, 2, 3]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/v26.0/act_1/campaigns");
    expect(String(url)).not.toContain("SECRET");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer SECRET");
  });

  it("backs off and retries on throttling, using estimated_time_to_regain_access", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        res({ error: { code: 80004, message: "There have been too many calls to this ad-account" } }, 400, {
          "x-business-use-case-usage": JSON.stringify({
            "123": [{ type: "ads_insights", call_count: 100, total_cputime: 40, total_time: 60, estimated_time_to_regain_access: 2 }],
          }),
        }),
      )
      .mockResolvedValueOnce(res({ data: [] }));
    const c = new MetaClient({ token: "t", fetchImpl, sleep });
    await c.get("act_1/insights");
    expect(sleep).toHaveBeenCalledWith(120_000);
    expect(c.maxUsage).toBe(100);
  });

  it("slows down when usage is high even on success", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(res({ data: [] }, 200, { "x-app-usage": JSON.stringify({ call_count: 90, total_cputime: 10, total_time: 10 }) }));
    const usage: number[] = [];
    await new MetaClient({ token: "t", fetchImpl, sleep, onUsage: (p) => usage.push(p) }).get("me");
    expect(usage).toEqual([90]);
    expect(sleep).toHaveBeenCalled();
  });

  it("does not retry auth errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(res({ error: { code: 190, type: "OAuthException", message: "Session has expired" } }, 400));
    await expect(new MetaClient({ token: "t", fetchImpl, sleep: async () => {} }).get("me")).rejects.toMatchObject({ kind: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses any write call except starting an insights report", () => {
    const c = new MetaClient({ token: "t", fetchImpl: vi.fn(), sleep: async () => {} });
    expect(() => c.post("act_1/campaigns", { name: "x" })).toThrow(/read-only/);
  });

  it("classifies errors", () => {
    expect(classifyMetaError(400, { error: { code: 17 } }).kind).toBe("rate_limit");
    expect(classifyMetaError(400, { error: { code: 200 } }).kind).toBe("permission");
    expect(classifyMetaError(500, { error: { code: 2, is_transient: true } }).kind).toBe("transient");
    expect(classifyMetaError(400, { error: { code: 100, message: "(#100) reach is not valid" } }).kind).toBe("invalid_request");
  });

  it("parses usage headers", () => {
    const h = new Headers({
      "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 42, reset_time_duration: 100, ads_api_access_tier: "standard_access" }),
    });
    expect(parseUsageHeaders(h)).toEqual({ pct: 42, waitMs: 0 });
  });
});

describe("range chunking for backfills", () => {
  it("splits newest first and covers the range exactly", () => {
    const chunks = chunkRange({ from: "2026-01-01", to: "2026-03-15" }, 31);
    expect(chunks[0]).toEqual({ from: "2026-02-13", to: "2026-03-15" });
    expect(chunks[chunks.length - 1].from).toBe("2026-01-01");
    expect(chunks.length).toBe(3);
  });
});
