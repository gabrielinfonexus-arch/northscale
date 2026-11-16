import { describe, expect, it } from "vitest";
import { METRICS, METRIC_MAP, compareMetric, compareToTarget, compareValues, computeMetric, sumTotals, type Totals } from "@/lib/metrics";

const t: Totals = {
  spend: 1000,
  impressions: 100_000,
  reach: 50_000,
  clicks: 2000,
  purchases: 50,
  purchaseValue: 5000,
  addToCart: 400,
  initiateCheckout: 100,
  videoViews3s: 30_000,
  thruPlays: 6000,
  orders: 60,
  grossSales: 7000,
  discounts: 500,
  refunds: 300,
  netSales: 6200,
  cogs: 2000,
  paymentFees: 180,
  newCustomers: 40,
  newCustomerRevenue: 4000,
  otherRevenue: 800,
  totalRevenue: 7000,
  platformRevenue: 7440,
};

describe("metric formulas", () => {
  it("delivery & efficiency", () => {
    expect(computeMetric("ctr", t)).toBeCloseTo(0.02);
    expect(computeMetric("cpc", t)).toBeCloseTo(0.5);
    expect(computeMetric("cpm", t)).toBeCloseTo(10);
    expect(computeMetric("frequency", t)).toBeCloseTo(2);
    expect(computeMetric("roas", t)).toBeCloseTo(5);
    expect(computeMetric("cpa", t)).toBeCloseTo(20);
    expect(computeMetric("cvr", t)).toBeCloseTo(0.025);
  });

  it("funnel", () => {
    expect(computeMetric("costPerAtc", t)).toBeCloseTo(2.5);
    expect(computeMetric("costPerIc", t)).toBeCloseTo(10);
    expect(computeMetric("clickToAtc", t)).toBeCloseTo(0.2);
    expect(computeMetric("atcToIc", t)).toBeCloseTo(0.25);
    expect(computeMetric("icToPurchase", t)).toBeCloseTo(0.5);
    expect(computeMetric("hookRate", t)).toBeCloseTo(0.3);
    expect(computeMetric("holdRate", t)).toBeCloseTo(0.2);
  });

  it("blended metrics", () => {
    expect(computeMetric("mer", t)).toBeCloseTo(7);
    expect(computeMetric("amer", t)).toBeCloseTo(4);
    expect(computeMetric("ncac", t)).toBeCloseTo(25);
    expect(computeMetric("aov", t)).toBeCloseTo(6500 / 60);
    expect(computeMetric("contributionMargin", t)).toBeCloseTo(6200 + 800 - 2000 - 180 - 1000);
    expect(computeMetric("grossMarginPct", t)).toBeCloseTo(4200 / 6200);
    expect(computeMetric("breakevenRoas", t)).toBeCloseTo(6200 / 4200);
    expect(computeMetric("breakevenCpa", t)).toBeCloseTo((6500 / 60) * (4200 / 6200));
    expect(computeMetric("attributionDiscrepancy", t)).toBeCloseTo(0.2);
  });

  it("returns null (rendered as —) for zero denominators and missing sources", () => {
    expect(computeMetric("cpa", { spend: 100, purchases: 0 })).toBeNull();
    expect(computeMetric("frequency", { impressions: 100, reach: null })).toBeNull();
    expect(computeMetric("roas", {})).toBeNull();
  });

  it("every metric has a direction, format, description and formula", () => {
    for (const m of METRICS) {
      expect(["up", "down", "neutral"]).toContain(m.direction);
      expect(m.description.length).toBeGreaterThan(5);
      expect(m.formula.length).toBeGreaterThan(3);
    }
    expect(new Set(METRICS.map((m) => m.key)).size).toBe(METRICS.length);
  });

  it("directions follow the spec", () => {
    for (const k of ["totalRevenue", "roas", "mer", "ctr", "purchases", "cvr", "aov"]) expect(METRIC_MAP[k].direction).toBe("up");
    for (const k of ["cpa", "cpc", "cpm", "ncac", "costPerAtc", "costPerIc", "refunds"]) expect(METRIC_MAP[k].direction).toBe("down");
    for (const k of ["spend", "impressions"]) expect(METRIC_MAP[k].direction).toBe("neutral");
  });

  it("sumTotals keeps null only when no row has the value", () => {
    const s = sumTotals([{ spend: 1, reach: null }, { spend: 2 }]);
    expect(s.spend).toBe(3);
    expect(s.reach).toBeNull();
    expect(sumTotals([{ reach: 5 }, { reach: null }]).reach).toBe(5);
  });
});

describe("comparison colour rule", () => {
  it("higher-is-better: up = green, down = red", () => {
    expect(compareValues("up", 110, 100).tone).toBe("good");
    expect(compareValues("up", 90, 100).tone).toBe("bad");
    expect(compareValues("up", 110, 100).arrow).toBe("up");
    expect(compareValues("up", 110, 100).deltaPct).toBeCloseTo(10);
  });

  it("lower-is-better: up = red, down = green", () => {
    expect(compareValues("down", 110, 100).tone).toBe("bad");
    expect(compareValues("down", 90, 100).tone).toBe("good");
    expect(compareValues("down", 90, 100).arrow).toBe("down");
  });

  it("neutral metrics are always grey", () => {
    expect(compareValues("neutral", 200, 100).tone).toBe("neutral");
    expect(compareValues("neutral", 200, 100).arrow).toBe("up");
  });

  it("changes within the threshold are grey (default ±2%)", () => {
    expect(compareValues("up", 101.9, 100).tone).toBe("neutral");
    expect(compareValues("up", 102, 100).tone).toBe("good");
    expect(compareValues("down", 98.5, 100).tone).toBe("neutral");
    expect(compareValues("up", 104, 100, 5).tone).toBe("neutral");
  });

  it("missing or zero previous value gives no delta", () => {
    expect(compareValues("up", 10, 0)).toMatchObject({ deltaPct: null, tone: "neutral", arrow: null });
    expect(compareValues("up", null, 10).tone).toBe("neutral");
  });

  it("negative baselines use absolute value", () => {
    expect(compareValues("up", -50, -100).deltaPct).toBeCloseTo(50);
    expect(compareValues("up", -50, -100).tone).toBe("good");
  });

  it("compareMetric computes derived metrics on both sides", () => {
    const cur: Totals = { spend: 100, purchases: 4 }; // CPA 25
    const prev: Totals = { spend: 100, purchases: 5 }; // CPA 20
    const c = compareMetric("cpa", cur, prev);
    expect(c.deltaPct).toBeCloseTo(25);
    expect(c.tone).toBe("bad");
  });

  it("compareToTarget uses the target as baseline", () => {
    expect(compareToTarget("roas", 3, 2.5).tone).toBe("good");
    expect(compareToTarget("cpa", 30, 25).tone).toBe("bad");
    expect(compareToTarget("cpa", 30, null).tone).toBe("neutral");
  });
});
