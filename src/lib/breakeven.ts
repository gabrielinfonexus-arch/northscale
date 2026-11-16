/**
 * Breakeven calculator (Targets page).
 *
 * m  = gross margin (0..1) after COGS and variable costs
 * S  = planned monthly ad spend, F = fixed monthly costs
 * Profit = Revenue·m − S − F = 0
 *   → Breakeven ROAS (= MER) = (S + F) / (m·S)          (1/m when F = 0)
 *   → Breakeven CPA          = AOV·m·S / (S + F)          (AOV·m when F = 0)
 * Targets apply a profit multiplier k (default 1.1): ROAS target = BE ROAS × k, CPA target = BE CPA ÷ k
 * (CPA is lower-is-better, so the multiplier tightens it).
 */
export interface BreakevenInput {
  aov: number;
  marginPct: number; // 0..100
  fixedCosts: number;
  plannedSpend: number;
  multiplier: number;
}

export interface BreakevenResult {
  contributionPerOrder: number;
  breakevenRoas: number | null;
  breakevenCpa: number | null;
  targetRoas: number | null;
  targetCpa: number | null;
  /** monthly revenue needed to break even at the planned spend */
  breakevenRevenue: number | null;
}

export function breakeven({ aov, marginPct, fixedCosts, plannedSpend, multiplier }: BreakevenInput): BreakevenResult {
  const m = marginPct / 100;
  const contributionPerOrder = aov * m;
  if (m <= 0 || aov <= 0)
    return { contributionPerOrder, breakevenRoas: null, breakevenCpa: null, targetRoas: null, targetCpa: null, breakevenRevenue: null };
  const S = Math.max(0, plannedSpend);
  const F = Math.max(0, fixedCosts);
  const breakevenRoas = S > 0 ? (S + F) / (m * S) : F > 0 ? null : 1 / m;
  const breakevenCpa = S > 0 ? (aov * m * S) / (S + F) : F > 0 ? null : aov * m;
  const k = multiplier > 0 ? multiplier : 1;
  return {
    contributionPerOrder,
    breakevenRoas,
    breakevenCpa,
    targetRoas: breakevenRoas === null ? null : breakevenRoas * k,
    targetCpa: breakevenCpa === null ? null : breakevenCpa / k,
    breakevenRevenue: S > 0 || F > 0 ? (S + F) / m : null,
  };
}
