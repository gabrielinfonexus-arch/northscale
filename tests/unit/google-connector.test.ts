import { describe, expect, it, vi } from "vitest";
import { GoogleAdsClient, classifyGoogleError, formatCustomerId } from "@/server/connectors/google/client";
import {
  adName,
  ageLabel,
  campaignType,
  foldCategories,
  genderLabel,
  hourLabel,
  mapMetrics,
  micros,
  policyIssue,
} from "@/server/connectors/google/mapping";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const TOKEN = () => json({ access_token: "ya29.access", expires_in: 3599 });

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof GoogleAdsClient>[0]> = {}) {
  return new GoogleAdsClient({
    refreshToken: "1//refresh",
    developerToken: "DEV",
    clientId: "cid",
    clientSecret: "sec",
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });
}

describe("Google Ads mapping", () => {
  it("converts micros and int64 strings", () => {
    const m = mapMetrics({
      metrics: {
        costMicros: "1019690000",
        impressions: "124206",
        clicks: "2126",
        conversions: 134.5,
        conversionsValue: 10621.59,
        allConversions: 160,
        viewThroughConversions: "12",
        searchImpressionShare: 0.62,
      },
    });
    expect(m).toMatchObject({
      spend: 1019.69,
      impressions: 124206,
      clicks: 2126,
      purchases: 134.5,
      purchaseValue: 10621.59,
      allConversions: 160,
      viewThroughConv: 12,
      searchImprShare: 0.62,
      reach: null,
      linkClicks: null,
    });
    expect(micros("1500000")).toBe(1.5);
  });

  it("folds conversion categories into funnel columns (null when the account has no such action)", () => {
    const rows = [
      { segments: { conversionActionCategory: "PURCHASE" }, metrics: { allConversions: 30, allConversionsValue: 2000 } },
      { segments: { conversionActionCategory: "ADD_TO_CART" }, metrics: { allConversions: 300 } },
      { segments: { conversionActionCategory: "BEGIN_CHECKOUT" }, metrics: { allConversions: 90 } },
    ];
    const f = foldCategories(rows, new Set(["addToCart", "initiateCheckout"]));
    expect(f).toMatchObject({ addToCart: 300, initiateCheckout: 90, leads: null });
    expect(f.byCategory.PURCHASE).toEqual({ conversions: 30, value: 2000 });
    expect(foldCategories([], new Set()).addToCart).toBeNull();
  });

  it("labels", () => {
    expect(ageLabel("AGE_RANGE_25_34")).toBe("25-34");
    expect(ageLabel("AGE_RANGE_65_UP")).toBe("65+");
    expect(ageLabel("AGE_RANGE_UNDETERMINED")).toBe("Undetermined");
    expect(genderLabel("FEMALE")).toBe("Female");
    expect(hourLabel(7)).toBe("07");
    expect(campaignType({ advertisingChannelType: "PERFORMANCE_MAX" })).toBe("PERFORMANCE_MAX");
    expect(
      adName({ adGroupAd: { ad: { id: "9", type: "RESPONSIVE_SEARCH_AD", responsiveSearchAd: { headlines: [{ text: "Glow serum" }] } } } }),
    ).toBe("Responsive search ad · Glow serum");
    expect(
      policyIssue({
        adGroupAd: { policySummary: { approvalStatus: "DISAPPROVED", policyTopicEntries: [{ topic: "HEALTH_IN_PERSONALIZED_ADS" }] } },
      }),
    ).toBe("Disapproved: HEALTH_IN_PERSONALIZED_ADS");
    expect(policyIssue({ adGroupAd: { policySummary: { approvalStatus: "APPROVED" } } })).toBeNull();
    expect(formatCustomerId("4821937710")).toBe("482-193-7710");
  });
});

describe("Google Ads client", () => {
  it("refreshes the access token once and sends developer-token + login-customer-id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(json([{ results: [{ campaign: { id: "1" } }] }, { results: [{ campaign: { id: "2" } }] }]))
      .mockResolvedValueOnce(json([{ results: [{ campaign: { id: "3" } }] }]));
    const c = client(fetchImpl, { loginCustomerId: "100-200-3000" });
    const rows = await c.query("482-193-7710", "SELECT campaign.id FROM campaign");
    await c.query("4821937710", "SELECT campaign.id FROM campaign");
    expect(rows.map((r) => (r as { campaign: { id: string } }).campaign.id)).toEqual(["1", "2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // token fetched once
    const [url, init] = fetchImpl.mock.calls[1];
    expect(String(url)).toBe("https://googleads.googleapis.com/v26/customers/4821937710/googleAds:searchStream");
    const h = init?.headers as Record<string, string>;
    expect(h["developer-token"]).toBe("DEV");
    expect(h["login-customer-id"]).toBe("1002003000");
    expect(h.Authorization).toBe("Bearer ya29.access");
  });

  it("retries RESOURCE_EXHAUSTED using retryDelay", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(
        json(
          [
            {
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message: "Too many requests",
                details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "42s" }],
              },
            },
          ],
          429,
        ),
      )
      .mockResolvedValueOnce(json([{ results: [] }]));
    await client(fetchImpl, { sleep }).query("1", "SELECT customer.id FROM customer");
    expect(sleep).toHaveBeenCalledWith(42_000);
  });

  it("an expired refresh token is an auth error (no retry)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    await expect(client(fetchImpl).query("1", "SELECT customer.id FROM customer")).rejects.toMatchObject({ kind: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies Google Ads failures", () => {
    const failure = (errorCode: Record<string, string>, status = "PERMISSION_DENIED", code = 403) => ({
      error: {
        code,
        status,
        message: "x",
        details: [
          { "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [{ errorCode, message: "detail" }] },
        ],
      },
    });
    expect(classifyGoogleError(403, failure({ authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" })).message).toMatch(/Basic access/);
    expect(classifyGoogleError(403, failure({ authorizationError: "USER_PERMISSION_DENIED" })).kind).toBe("permission");
    expect(classifyGoogleError(401, { error: { status: "UNAUTHENTICATED" } }).kind).toBe("auth");
    expect(classifyGoogleError(400, failure({ queryError: "UNRECOGNIZED_FIELD" }, "INVALID_ARGUMENT", 400)).kind).toBe("invalid_request");
    expect(classifyGoogleError(503, { error: { status: "UNAVAILABLE" } }).kind).toBe("transient");
  });

  it("lists accessible customers", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(TOKEN())
      .mockResolvedValueOnce(json({ resourceNames: ["customers/1002003000", "customers/4821937710"] }));
    expect(await client(fetchImpl).listAccessibleCustomers()).toEqual(["1002003000", "4821937710"]);
  });
});
