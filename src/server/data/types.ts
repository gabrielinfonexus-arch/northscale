/** Shared (server → client) shapes for the Data page. Plain JSON, no server-only imports. */
import type { Totals } from "@/lib/metrics";

export type ColumnKind = "metric" | "share" | "text" | "thumb" | "badge";

export interface ColumnSpec {
  id: string;
  kind: ColumnKind;
  /** metric key in metrics.ts (kind = metric | share) */
  metric?: string;
  header?: string;
  /** For "share": share of the total of this metric (e.g. % of spend). */
  shareOf?: string;
}

export type CreativeBadge = "winner" | "watch" | "cut";

export interface DataRow {
  id: string;
  label: string;
  sub?: string | null;
  /** Number of child records (shown as "(N records)"). */
  records?: number;
  totals: Totals;
  compare?: Totals | null;
  /** metric key → target value for this row (already scaled to the row period). */
  target?: Record<string, number>;
  text?: Record<string, string | null>;
  thumb?: string | null;
  badge?: CreativeBadge | null;
  /** sort key for the first column (e.g. ISO date, hour) */
  sortKey?: string | number;
  children?: DataRow[];
}

export interface SegmentChart {
  kind: "segments";
  /** label, spend share, ROAS, CPA */
  items: { label: string; spendShare: number | null; roas: number | null; cpa: number | null }[];
}
export interface HeatmapChart {
  kind: "heatmap";
  /** [dow 0..6][hour 0..23] totals */
  cells: { dow: number; hour: number; totals: Totals }[];
}

export interface Notice {
  tone: "warn" | "info";
  text: string;
  href?: string;
  linkText?: string;
}

export interface DataTableModel {
  key: string;
  firstColumn: string;
  columns: ColumnSpec[];
  defaultVisible: string[];
  rows: DataRow[];
  total: Totals;
  totalCompare: Totals | null;
  totalTarget?: Record<string, number>;
  currency: string;
  compareLabel: string | null;
  defaultSort: { id: string; desc: boolean };
  /** Why a metric shows "—" in this table. */
  unavailable: Record<string, string>;
  chart?: SegmentChart | HeatmapChart;
  notices?: Notice[];
  view?: "table" | "creatives";
  /** campaigns available for the campaign filter */
  campaigns?: { id: string; name: string }[];
  /** whether any row has a target (enables "Color vs target") */
  hasTargets: boolean;
}
