import { describe, expect, it } from "vitest";
import { evaluateRules, RULE_MAP, defaultParams, type DayAd, type WatchdogInput } from "@/lib/watchdog/rules";
import { addDays } from "@/lib/periods";

const TODAY = "2026-11-17";
const days = (n: number) => Array.from({ length: n }, (_, i) => addDays(TODAY, i - n)); // ends yesterday

/** Stable business: Meta $1,000/day, 25 purchases ($40 CPA), ROAS 3; Google $400/day, 16 purchases ($25 CPA). */
function base(): WatchdogInput {
  const meta: DayAd[] = days(30).map((date) => ({
    date,
    spend: 1000,
    purchases: 25,
    value: 3000,
    clicks: 1000,
    impressions: 50_000,
    addToCart: 250,
  }));
  const google: DayAd[] = days(30).map((date) => ({
    date,
    spend: 400,
    purchases: 16,
    value: 1400,
    clicks: 500,
    impressions: 15_000,
    addToCart: null,
  }));
  return {
    today: TODAY,
    currency: "USD",
    platformDaily: { META: meta, GOOGLE: google },
    blendedDaily: days(35).map((date) => ({ date, spend: 1400, totalRevenue: 4200, orders: 40, netSales: 4000, platformRevenue: 4400 })),
    hasShopify: true,
    connections: [
      {
        id: "c1",
        name: "Brand – Prospecting",
        platform: "META",
        status: "OK",
        isDemo: false,
        lastError: null,
        lastSuccessAt: `${TODAY}T10:00:00Z`,
        tokenExpiresAt: null,
        accountStatus: "Active",
        dailySpend: days(14).map((date) => ({ date, spend: 1000 })),
      },
    ],
    targets: {
      META: { cpa: 42, roas: 2.8, spend: 31_000 },
      GOOGLE: { cpa: 26, roas: 3.2, spend: 12_000 },
      CLIENT: { mer: 2.9, spend: 43_000 },
    },
    monthToDate: { daysElapsed: 16, daysInMonth: 30, spend: { META: 16_000, GOOGLE: 6_400, CLIENT: 22_400 } },
    rejectedAds: [],
    prospecting: [{ connectionId: "c1", campaignId: "k1", name: "PROSP | Broad", impressions: 200_000, reach: 100_000, spend: 5000 }],
    ads: [],
    adsAccountSpend: { META: 14_000, GOOGLE: 5_600 },
  };
}

const keys = (i: WatchdogInput, only?: string) => evaluateRules(i).filter((c) => !only || c.ruleKey === only);

describe("Watchdog rules", () => {
  it("a healthy account raises nothing", () => {
    expect(keys(base())).toEqual([]);
  });

  it("CPA above target over the last 3 days (critical at 1.5×)", () => {
    const i = base();
    i.platformDaily.META!.slice(-3).forEach((d) => (d.purchases = 18)); // CPA 55.6 vs 42 → +32%
    const c = keys(i, "cpa_above_target");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ severity: "WARNING", fingerprint: "cpa_above_target:META" });
    i.platformDaily.META!.slice(-3).forEach((d) => (d.purchases = 10)); // CPA 100
    expect(keys(i, "cpa_above_target")[0].severity).toBe("CRITICAL");
  });

  it("ROAS drop vs 7-day average, and below target", () => {
    const i = base();
    i.platformDaily.META!.slice(-3).forEach((d) => (d.value = 2200)); // ROAS 2.2: −27% and below 2.8
    const c = keys(i, "roas_drop").find((x) => x.fingerprint === "roas_drop:META")!;
    expect(c.severity).toBe("CRITICAL");
    expect(c.title).toContain("below target");
  });

  it("MER below target (blended)", () => {
    const i = base();
    i.targets.CLIENT.mer = 3.5;
    expect(keys(i, "roas_drop").map((c) => c.fingerprint)).toContain("roas_drop:CLIENT");
  });

  it("spend pacing over / under budget", () => {
    const i = base();
    i.monthToDate.spend.META = 22_000; // → 41,250 vs 31,000 (+33%)
    i.monthToDate.spend.GOOGLE = 4_000; // → 7,500 vs 12,000 (−38%)
    const c = keys(i, "spend_pacing");
    expect(c.find((x) => x.fingerprint === "spend_pacing:META:over")?.severity).toBe("CRITICAL");
    expect(c.find((x) => x.fingerprint === "spend_pacing:GOOGLE:under")?.severity).toBe("WARNING");
    i.monthToDate.daysElapsed = 2;
    expect(keys(i, "spend_pacing")).toEqual([]);
  });

  it("zero spend on an account that normally spends, and account status", () => {
    const i = base();
    i.connections[0].dailySpend[i.connections[0].dailySpend.length - 1].spend = 0;
    expect(keys(i, "zero_spend")[0]).toMatchObject({ severity: "CRITICAL", fingerprint: "zero_spend:c1" });
    i.connections[0].accountStatus = "Unsettled (payment issue)";
    expect(keys(i, "zero_spend").map((c) => c.fingerprint)).toContain("account_status:c1");
  });

  it("rejected ads", () => {
    const i = base();
    i.rejectedAds = [
      { connectionId: "c1", platform: "META", adId: "a9", name: "IMG | Before/After", review: "Personal health policy", spend7d: 120 },
    ];
    expect(keys(i, "ad_rejected")[0]).toMatchObject({ fingerprint: "ad_rejected:c1:a9", link: { tab: "ads" } });
  });

  it("frequency in prospecting", () => {
    const i = base();
    i.prospecting[0].reach = 60_000; // 3.3x
    expect(keys(i, "high_frequency")[0].title).toContain("3.3x");
  });

  it("tracking: platform conversions collapse while Shopify orders hold", () => {
    const i = base();
    i.platformDaily.META!.slice(-2).forEach((d) => (d.purchases = 5));
    expect(keys(i, "tracking_broken").find((c) => c.fingerprint === "tracking_broken:META")?.severity).toBe("CRITICAL");
  });

  it("tracking: Shopify orders collapse while platforms hold", () => {
    const i = base();
    i.blendedDaily.slice(-2).forEach((d) => (d.orders = 10));
    expect(keys(i, "tracking_broken").map((c) => c.fingerprint)).toContain("tracking_broken:SHOPIFY");
  });

  it("tracking: attribution gap far from normal", () => {
    const i = base();
    i.blendedDaily.slice(-3).forEach((d) => (d.platformRevenue = 6000)); // 50% vs normal 10%
    expect(keys(i, "tracking_broken").map((c) => c.fingerprint)).toContain("tracking_broken:GAP");
  });

  it("funnel diagnosis: CPA up with CPC and cost/ATC up → traffic got expensive", () => {
    const i = base();
    i.platformDaily.META!.slice(-3).forEach((d) => Object.assign(d, { clicks: 750, addToCart: 190, purchases: 19 }));
    const c = keys(i, "funnel_diagnosis")[0];
    expect(c.severity).toBe("WARNING");
    expect(c.title).toContain("more expensive");
  });

  it("funnel diagnosis: CPA up but CPC and cost/ATC stable → hold", () => {
    const i = base();
    i.platformDaily.META!.slice(-3).forEach((d) => (d.purchases = 19));
    const c = keys(i, "funnel_diagnosis")[0];
    expect(c.severity).toBe("INFO");
    expect(c.title).toContain("hold");
  });

  it("ads to cut and winners", () => {
    const i = base();
    i.ads = [
      { platform: "META", connectionId: "c1", adId: "bad", name: "VID | Hook B", spend: 300, purchases: 2, value: 200 }, // CPA 150 ≥ 2×42, spend ≥ 84
      { platform: "META", connectionId: "c1", adId: "win", name: "VID | UGC", spend: 2000, purchases: 60, value: 7000 }, // 14% share, ROAS 3.5
      { platform: "META", connectionId: "c1", adId: "ok", name: "IMG | ok", spend: 200, purchases: 5, value: 600 },
    ];
    expect(keys(i, "ad_to_cut").map((c) => c.entityId)).toEqual(["bad"]);
    expect(keys(i, "ad_winner").map((c) => c.entityId)).toEqual(["win"]);
  });

  it("sync issues and token expiry (demo connections ignored)", () => {
    const i = base();
    i.connections.push(
      { ...i.connections[0], id: "c2", name: "Google", status: "TOKEN_EXPIRED", dailySpend: [] },
      {
        ...i.connections[0],
        id: "c3",
        name: "Store",
        status: "ERROR",
        lastSuccessAt: "2026-11-10T00:00:00Z",
        lastError: "500",
        dailySpend: [],
      },
      { ...i.connections[0], id: "c4", name: "Soon", tokenExpiresAt: "2026-11-20T00:00:00Z", dailySpend: [] },
      { ...i.connections[0], id: "c5", name: "Demo", status: "ERROR", isDemo: true, dailySpend: [] },
    );
    const c = keys(i, "sync_issue");
    expect(c.map((x) => [x.fingerprint, x.severity])).toEqual([
      ["sync_issue:token:c2", "CRITICAL"],
      ["sync_issue:error:c3", "CRITICAL"],
      ["sync_issue:expiry:c4", "WARNING"],
    ]);
  });

  it("rules can be disabled and params overridden", () => {
    const i = base();
    i.platformDaily.META!.slice(-3).forEach((d) => (d.purchases = 18));
    expect(evaluateRules(i, { cpa_above_target: { enabled: false, params: {} } }).filter((c) => c.ruleKey === "cpa_above_target")).toEqual(
      [],
    );
    expect(
      evaluateRules(i, { cpa_above_target: { enabled: true, params: { pct: 50 } } }).filter((c) => c.ruleKey === "cpa_above_target"),
    ).toEqual([]);
    expect(defaultParams(RULE_MAP.cpa_above_target)).toEqual({ pct: 20, days: 3, minSpend: 100 });
  });
});
