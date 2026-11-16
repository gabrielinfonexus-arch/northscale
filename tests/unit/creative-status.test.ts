import { describe, expect, it } from "vitest";
import { classifyCreative } from "@/lib/rules/creative-status";

const base = { accountSpend: 10_000, targetCpa: 40, targetRoas: 2 };

describe("Winner / Watch / Cut", () => {
  it("cut: CPA ≥ 2× target after spending ≥ 2× target CPA", () => {
    expect(classifyCreative({ ...base, spend: 400, purchases: 4, purchaseValue: 300 })).toBe("cut"); // CPA 100
    expect(classifyCreative({ ...base, spend: 200, purchases: 0, purchaseValue: 0 })).toBe("cut"); // no purchases after 5× CPA
  });

  it("not cut before enough spend", () => {
    expect(classifyCreative({ ...base, spend: 70, purchases: 0, purchaseValue: 0 })).toBe("watch");
    expect(classifyCreative({ ...base, spend: 30, purchases: 0, purchaseValue: 0 })).toBeNull();
  });

  it("winner: ≥ 5% of account spend and above target ROAS", () => {
    expect(classifyCreative({ ...base, spend: 800, purchases: 25, purchaseValue: 2400 })).toBe("winner"); // ROAS 3
  });

  it("big spender below target ROAS is watch, not winner", () => {
    expect(classifyCreative({ ...base, spend: 800, purchases: 15, purchaseValue: 1200 })).toBe("watch"); // ROAS 1.5, CPA 53
  });

  it("small, efficient ad is neither", () => {
    expect(classifyCreative({ ...base, spend: 200, purchases: 8, purchaseValue: 600 })).toBeNull();
  });

  it("falls back to CPA target when there is no ROAS target", () => {
    expect(classifyCreative({ accountSpend: 10_000, targetCpa: 40, spend: 900, purchases: 30, purchaseValue: 0 })).toBe("winner");
  });
});
