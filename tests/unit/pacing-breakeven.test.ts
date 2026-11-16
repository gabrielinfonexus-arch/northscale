import { describe, expect, it } from "vitest";
import { pace } from "@/lib/pacing";
import { breakeven } from "@/lib/breakeven";

describe("pacing", () => {
  it("projects additive metrics linearly", () => {
    const r = pace({ metric: "totalRevenue", target: 300_000, actual: 150_000, daysElapsed: 15, daysInMonth: 30 });
    expect(r.projection).toBeCloseTo(300_000);
    expect(r.progress).toBeCloseTo(0.5);
    expect(r.expectedToDate).toBeCloseTo(150_000);
    expect(r.status).toBe("on_track");
  });

  it("revenue ahead is good, behind is bad", () => {
    expect(pace({ metric: "totalRevenue", target: 300_000, actual: 180_000, daysElapsed: 15, daysInMonth: 30 })).toMatchObject({
      status: "ahead",
      tone: "good",
    });
    expect(pace({ metric: "totalRevenue", target: 300_000, actual: 120_000, daysElapsed: 15, daysInMonth: 30 })).toMatchObject({
      status: "behind",
      tone: "bad",
    });
  });

  it("ratio metrics use direction: CPA above target is behind", () => {
    expect(pace({ metric: "cpa", target: 40, actual: 46, daysElapsed: 10, daysInMonth: 30 })).toMatchObject({
      status: "behind",
      tone: "bad",
      projection: 46,
    });
    expect(pace({ metric: "mer", target: 3, actual: 3.4, daysElapsed: 10, daysInMonth: 30 })).toMatchObject({ status: "ahead" });
  });

  it("spend over or under pace is a warning", () => {
    expect(pace({ metric: "spend", target: 100_000, actual: 70_000, daysElapsed: 15, daysInMonth: 30 })).toMatchObject({
      status: "over",
      tone: "warn",
    });
    expect(pace({ metric: "spend", target: 100_000, actual: 30_000, daysElapsed: 15, daysInMonth: 30 })).toMatchObject({
      status: "under",
      tone: "warn",
    });
  });

  it("no data", () => {
    expect(pace({ metric: "orders", target: 100, actual: null, daysElapsed: 5, daysInMonth: 30 }).status).toBe("no_data");
    expect(pace({ metric: "orders", target: 100, actual: 10, daysElapsed: 0, daysInMonth: 30 }).status).toBe("no_data");
  });
});

describe("breakeven", () => {
  it("without fixed costs: 1/margin and AOV × margin", () => {
    const r = breakeven({ aov: 100, marginPct: 50, fixedCosts: 0, plannedSpend: 10_000, multiplier: 1.1 });
    expect(r.breakevenRoas).toBeCloseTo(2);
    expect(r.breakevenCpa).toBeCloseTo(50);
    expect(r.targetRoas).toBeCloseTo(2.2);
    expect(r.targetCpa).toBeCloseTo(50 / 1.1);
    expect(r.breakevenRevenue).toBeCloseTo(20_000);
  });

  it("fixed costs raise the breakeven ROAS and lower the breakeven CPA", () => {
    const r = breakeven({ aov: 100, marginPct: 50, fixedCosts: 10_000, plannedSpend: 10_000, multiplier: 1 });
    expect(r.breakevenRoas).toBeCloseTo(4); // (10k + 10k) / (0.5 × 10k)
    expect(r.breakevenCpa).toBeCloseTo(25); // 100 × 0.5 × 10k / 20k
    // profit at breakeven is 0: revenue = 4 × 10k = 40k → 20k margin − 10k spend − 10k fixed
    expect(40_000 * 0.5 - 10_000 - 10_000).toBe(0);
  });

  it("invalid inputs give no result", () => {
    expect(breakeven({ aov: 0, marginPct: 50, fixedCosts: 0, plannedSpend: 1, multiplier: 1.1 }).breakevenRoas).toBeNull();
    expect(breakeven({ aov: 80, marginPct: 0, fixedCosts: 0, plannedSpend: 1, multiplier: 1.1 }).breakevenCpa).toBeNull();
  });
});
