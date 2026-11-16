/**
 * Winner / Watch / Cut classification for ads & creatives.
 * Same rules the Watchdog uses ("Anúncio para cortar" / "Anúncio vencedor").
 */
export interface CreativeRuleParams {
  /** Cut when CPA ≥ cutCpaMult × target CPA … */
  cutCpaMult: number;
  /** … and spend ≥ cutSpendMult × target CPA (enough data to judge). */
  cutSpendMult: number;
  /** Winner when share of account spend ≥ winnerSpendShare … */
  winnerSpendShare: number;
}

export const DEFAULT_CREATIVE_RULES: CreativeRuleParams = { cutCpaMult: 2, cutSpendMult: 2, winnerSpendShare: 0.05 };

export interface CreativeInput {
  spend: number;
  purchases: number;
  purchaseValue: number;
  /** total spend of the account(s) in the same period */
  accountSpend: number;
  targetCpa?: number | null;
  targetRoas?: number | null;
}

export type CreativeStatus = "winner" | "watch" | "cut" | null;

export function classifyCreative(c: CreativeInput, p: CreativeRuleParams = DEFAULT_CREATIVE_RULES): CreativeStatus {
  if (c.spend <= 0) return null;
  const cpa = c.purchases > 0 ? c.spend / c.purchases : Infinity;
  const roas = c.purchaseValue / c.spend;
  const share = c.accountSpend > 0 ? c.spend / c.accountSpend : 0;
  const tCpa = c.targetCpa ?? null;
  const tRoas = c.targetRoas ?? null;

  if (tCpa && c.spend >= p.cutSpendMult * tCpa && cpa >= p.cutCpaMult * tCpa) return "cut";

  const beatsTarget = tRoas ? roas >= tRoas : tCpa ? cpa <= tCpa : false;
  if (share >= p.winnerSpendShare && beatsTarget) return "winner";

  const missesTarget = tRoas ? roas < tRoas : tCpa ? cpa > tCpa : false;
  const enoughData = tCpa ? c.spend >= tCpa : share >= p.winnerSpendShare;
  if (missesTarget && enoughData) return "watch";
  return null;
}
