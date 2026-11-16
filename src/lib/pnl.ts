/**
 * P&L / cost model — one implementation used by the P&L page and the Dashboard, so contribution margin
 * is identical everywhere.
 *
 *   Gross sales − Discounts − Refunds                    = Net sales
 *   Net sales + Other revenue                            = Total revenue
 *   − COGS                                               = Gross profit
 *   − Shipping cost − Payment fees − Variable costs      = Contribution before ads
 *   − Ad spend (per platform)                            = Contribution margin
 *   − Fixed costs (monthly, spread per day)              = Net profit
 */
import { endOfMonth } from "./periods";

export type CostType = "FIXED_MONTHLY" | "VARIABLE_PER_ORDER" | "VARIABLE_PCT_REVENUE";

export interface CostItemInput {
  name: string;
  type: CostType;
  amount: number; // money for FIXED_MONTHLY / per order; percent (0..100) for PCT
  startDate?: string | null;
  endDate?: string | null;
}

export interface CostSettings {
  shippingCostPerOrder: number;
  shippingCostPct: number; // of net sales
  costItems: CostItemInput[];
}

export interface DayInput {
  date: string;
  grossSales: number;
  discounts: number;
  refunds: number;
  otherRevenue: number;
  cogs: number;
  paymentFees: number;
  orders: number;
  adSpend: Record<string, number>; // platform → spend
}

export interface PnlLines {
  grossSales: number;
  discounts: number;
  refunds: number;
  netSales: number;
  otherRevenue: number;
  totalRevenue: number;
  cogs: number;
  grossProfit: number;
  shippingCost: number;
  paymentFees: number;
  variableCosts: number;
  contributionBeforeAds: number;
  adSpend: Record<string, number>;
  adSpendTotal: number;
  contributionMargin: number;
  fixedCosts: number;
  netProfit: number;
  orders: number;
}

const active = (c: CostItemInput, day: string) => (!c.startDate || day >= c.startDate) && (!c.endDate || day <= c.endDate);

/** Costs that depend on the cost model for one day (also used to enrich Dashboard totals). */
export function costsForDay(day: string, netSales: number, orders: number, s: CostSettings) {
  const shippingCost = orders * s.shippingCostPerOrder + (netSales * s.shippingCostPct) / 100;
  let variableCosts = 0;
  let fixedCosts = 0;
  const dim = Number(endOfMonth(day).slice(8, 10));
  for (const c of s.costItems) {
    if (!active(c, day)) continue;
    if (c.type === "VARIABLE_PER_ORDER") variableCosts += c.amount * orders;
    else if (c.type === "VARIABLE_PCT_REVENUE") variableCosts += (c.amount / 100) * netSales;
    else fixedCosts += c.amount / dim;
  }
  return { shippingCost, variableCosts, fixedCosts };
}

export function pnlForDays(days: DayInput[], s: CostSettings): PnlLines {
  const out: PnlLines = {
    grossSales: 0,
    discounts: 0,
    refunds: 0,
    netSales: 0,
    otherRevenue: 0,
    totalRevenue: 0,
    cogs: 0,
    grossProfit: 0,
    shippingCost: 0,
    paymentFees: 0,
    variableCosts: 0,
    contributionBeforeAds: 0,
    adSpend: {},
    adSpendTotal: 0,
    contributionMargin: 0,
    fixedCosts: 0,
    netProfit: 0,
    orders: 0,
  };
  for (const d of days) {
    const net = d.grossSales - d.discounts - d.refunds;
    const c = costsForDay(d.date, net, d.orders, s);
    out.grossSales += d.grossSales;
    out.discounts += d.discounts;
    out.refunds += d.refunds;
    out.otherRevenue += d.otherRevenue;
    out.cogs += d.cogs;
    out.paymentFees += d.paymentFees;
    out.orders += d.orders;
    out.shippingCost += c.shippingCost;
    out.variableCosts += c.variableCosts;
    out.fixedCosts += c.fixedCosts;
    for (const [p, v] of Object.entries(d.adSpend)) out.adSpend[p] = (out.adSpend[p] ?? 0) + v;
  }
  out.netSales = out.grossSales - out.discounts - out.refunds;
  out.totalRevenue = out.netSales + out.otherRevenue;
  out.grossProfit = out.totalRevenue - out.cogs;
  out.contributionBeforeAds = out.grossProfit - out.shippingCost - out.paymentFees - out.variableCosts;
  out.adSpendTotal = Object.values(out.adSpend).reduce((a, b) => a + b, 0);
  out.contributionMargin = out.contributionBeforeAds - out.adSpendTotal;
  out.netProfit = out.contributionMargin - out.fixedCosts;
  return out;
}

export const pct = (part: number, whole: number): number | null => (whole ? part / whole : null);

/** Costs for a period of several days (linear costs on the period totals, fixed costs per day). */
export function costsForPeriod(days: string[], netSales: number, orders: number, s: CostSettings) {
  if (!days.length) return { shippingCost: 0, variableCosts: 0, fixedCosts: 0 };
  const linear = costsForDay(days[0], netSales, orders, { ...s, costItems: s.costItems.filter((c) => c.type !== "FIXED_MONTHLY") });
  // variable items can start/end mid-period: apply them per day proportionally to the period totals
  let variableCosts = 0;
  for (const c of s.costItems.filter((x) => x.type !== "FIXED_MONTHLY")) {
    const activeDays = days.filter((d) => (!c.startDate || d >= c.startDate) && (!c.endDate || d <= c.endDate)).length;
    const share = activeDays / days.length;
    variableCosts += (c.type === "VARIABLE_PER_ORDER" ? c.amount * orders : (c.amount / 100) * netSales) * share;
  }
  const fixedCosts = days.reduce(
    (sum, d) => sum + costsForDay(d, 0, 0, { ...s, costItems: s.costItems.filter((c) => c.type === "FIXED_MONTHLY") }).fixedCosts,
    0,
  );
  return { shippingCost: linear.shippingCost, variableCosts, fixedCosts };
}
