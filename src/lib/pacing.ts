/**
 * Target pacing: progress, end-of-month projection and status.
 * Additive metrics (spend, revenue, orders, new customers) project linearly from the pace so far;
 * ratio metrics (MER, ROAS, CPA, nCAC) project at their month-to-date value.
 */
import { getMetric, type MetricDirection } from "./metrics";

export type PaceStatus = "ahead" | "on_track" | "behind" | "over" | "under" | "no_data";

export const ADDITIVE_TARGETS = new Set(["spend", "totalRevenue", "orders", "newCustomers"]);

export interface PaceInput {
  metric: string;
  target: number;
  /** month-to-date actual (sum for additive metrics, ratio value for ratio metrics) */
  actual: number | null;
  daysElapsed: number;
  daysInMonth: number;
  /** ± % within which the projection counts as on track */
  tolerancePct?: number;
}

export interface PaceResult {
  metric: string;
  target: number;
  actual: number | null;
  projection: number | null;
  /** actual / target (additive) – share of the monthly target already reached */
  progress: number | null;
  /** where the actual should be by now if perfectly on pace (additive only) */
  expectedToDate: number | null;
  /** projection vs target, % */
  gapPct: number | null;
  status: PaceStatus;
  tone: "good" | "bad" | "warn" | "neutral";
}

export function pace({ metric, target, actual, daysElapsed, daysInMonth, tolerancePct = 5 }: PaceInput): PaceResult {
  const additive = ADDITIVE_TARGETS.has(metric);
  const direction: MetricDirection = getMetric(metric).direction;
  const base = { metric, target, actual };
  if (actual === null || target <= 0 || (additive && daysElapsed <= 0)) {
    return { ...base, projection: null, progress: null, expectedToDate: null, gapPct: null, status: "no_data", tone: "neutral" };
  }
  const projection = additive ? (actual / daysElapsed) * daysInMonth : actual;
  const progress = additive ? actual / target : null;
  const expectedToDate = additive ? (target * daysElapsed) / daysInMonth : null;
  const gapPct = ((projection - target) / target) * 100;

  if (Math.abs(gapPct) < tolerancePct) return { ...base, projection, progress, expectedToDate, gapPct, status: "on_track", tone: "good" };
  if (direction === "neutral") {
    // Spend: pacing over or under budget are both worth a look
    return { ...base, projection, progress, expectedToDate, gapPct, status: gapPct > 0 ? "over" : "under", tone: "warn" };
  }
  const better = direction === "up" ? gapPct > 0 : gapPct < 0;
  return { ...base, projection, progress, expectedToDate, gapPct, status: better ? "ahead" : "behind", tone: better ? "good" : "bad" };
}

export const STATUS_LABEL: Record<PaceStatus, string> = {
  ahead: "Ahead",
  on_track: "On track",
  behind: "Behind",
  over: "Over pace",
  under: "Under pace",
  no_data: "No data",
};
