import { describe, expect, it } from "vitest";
import { costsForDay, pnlForDays, type CostSettings, type DayInput } from "@/lib/pnl";

const settings: CostSettings = {
  shippingCostPerOrder: 5,
  shippingCostPct: 0,
  costItems: [
    { name: "Packaging", type: "VARIABLE_PER_ORDER", amount: 1.5 },
    { name: "Affiliate", type: "VARIABLE_PCT_REVENUE", amount: 2 },
    { name: "Team", type: "FIXED_MONTHLY", amount: 3000 }, // November: 100/day
    { name: "Old tool", type: "FIXED_MONTHLY", amount: 900, endDate: "2026-10-31" },
  ],
};

const day = (date: string, extra: Partial<DayInput> = {}): DayInput => ({
  date,
  grossSales: 1000,
  discounts: 100,
  refunds: 50,
  otherRevenue: 200,
  cogs: 250,
  paymentFees: 30,
  orders: 10,
  adSpend: { META: 150, GOOGLE: 50 },
  ...extra,
});

describe("P&L", () => {
  it("computes every line for a day", () => {
    const p = pnlForDays([day("2026-11-10")], settings);
    expect(p.netSales).toBe(850);
    expect(p.totalRevenue).toBe(1050);
    expect(p.grossProfit).toBe(800);
    expect(p.shippingCost).toBe(50);
    expect(p.variableCosts).toBeCloseTo(15 + 17); // 1.5 × 10 + 2% of 850
    expect(p.contributionBeforeAds).toBeCloseTo(800 - 50 - 30 - 32);
    expect(p.adSpendTotal).toBe(200);
    expect(p.contributionMargin).toBeCloseTo(488);
    expect(p.fixedCosts).toBeCloseTo(100);
    expect(p.netProfit).toBeCloseTo(388);
  });

  it("spreads fixed monthly costs per day and respects start/end dates", () => {
    expect(costsForDay("2026-10-15", 0, 0, settings).fixedCosts).toBeCloseTo(3000 / 31 + 900 / 31);
    expect(costsForDay("2026-11-15", 0, 0, settings).fixedCosts).toBeCloseTo(100);
    const month = Array.from({ length: 30 }, (_, i) => day(`2026-11-${String(i + 1).padStart(2, "0")}`));
    expect(pnlForDays(month, settings).fixedCosts).toBeCloseTo(3000);
  });

  it("shipping as % of net sales", () => {
    expect(costsForDay("2026-11-01", 1000, 10, { shippingCostPerOrder: 0, shippingCostPct: 8, costItems: [] }).shippingCost).toBe(80);
  });

  it("sums ad spend per platform across days", () => {
    const p = pnlForDays([day("2026-11-01"), day("2026-11-02", { adSpend: { META: 10 } })], settings);
    expect(p.adSpend).toEqual({ META: 160, GOOGLE: 50 });
  });
});
