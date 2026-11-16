/**
 * Date ranges, presets, comparison periods and period buckets.
 * Dates are plain "YYYY-MM-DD" strings (calendar days in the client's reporting timezone),
 * so no timezone shifting can happen once a day has been resolved.
 */

export type Granularity = "day" | "week" | "month" | "year";
export type Preset =
  "today" | "yesterday" | "last_7" | "last_14" | "last_30" | "last_90" | "this_month" | "last_month" | "this_year" | "custom";
export type CompareMode = "previous" | "yoy" | "custom" | "none";

export interface DateRange {
  from: string;
  to: string;
}

export const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7", label: "Last 7 days" },
  { value: "last_14", label: "Last 14 days" },
  { value: "last_30", label: "Last 30 days" },
  { value: "last_90", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_year", label: "This year" },
  { value: "custom", label: "Custom" },
];

export const COMPARE_MODES: { value: CompareMode; label: string }[] = [
  { value: "previous", label: "Previous period" },
  { value: "yoy", label: "Same period last year" },
  { value: "custom", label: "Custom" },
  { value: "none", label: "No comparison" },
];

const DAY_MS = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_RE.test(s)) return false;
  const d = parseIso(s);
  return !Number.isNaN(d.getTime()) && toIso(d) === s;
}

export function parseIso(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: string, n: number): string {
  return toIso(new Date(parseIso(s).getTime() + n * DAY_MS));
}

/** Adds months, clamping to the last day of the target month (Mar 31 − 1 month = Feb 28/29). */
export function addMonths(s: string, n: number): string {
  const d = parseIso(s);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return toIso(target);
}

export function addYears(s: string, n: number): string {
  return addMonths(s, n * 12);
}

/** Inclusive number of days in a range. */
export function daysInRange(r: DateRange): number {
  return Math.round((parseIso(r.to).getTime() - parseIso(r.from).getTime()) / DAY_MS) + 1;
}

export function eachDay(r: DateRange): string[] {
  const out: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Today's calendar date in an IANA timezone. */
export function todayInTz(tz: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

export function startOfMonth(s: string): string {
  return s.slice(0, 8) + "01";
}

export function endOfMonth(s: string): string {
  return addDays(addMonths(startOfMonth(s), 1), -1);
}

export function startOfYear(s: string): string {
  return s.slice(0, 4) + "-01-01";
}

/** ISO week start (Monday). */
export function startOfWeek(s: string): string {
  const dow = parseIso(s).getUTCDay(); // 0 = Sunday
  return addDays(s, -((dow + 6) % 7));
}

export function presetRange(preset: Exclude<Preset, "custom">, today: string): DateRange {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "last_7":
      return { from: addDays(today, -7), to: addDays(today, -1) };
    case "last_14":
      return { from: addDays(today, -14), to: addDays(today, -1) };
    case "last_30":
      return { from: addDays(today, -30), to: addDays(today, -1) };
    case "last_90":
      return { from: addDays(today, -90), to: addDays(today, -1) };
    case "this_month":
      return { from: startOfMonth(today), to: today };
    case "last_month": {
      const firstThis = startOfMonth(today);
      const lastPrev = addDays(firstThis, -1);
      return { from: startOfMonth(lastPrev), to: lastPrev };
    }
    case "this_year":
      return { from: startOfYear(today), to: today };
  }
}

/**
 * Comparison period.
 *  - previous: the same number of days immediately before (for whole-month presets,
 *    the previous whole month so "Last month" compares month vs month).
 *  - yoy: the same calendar dates one year earlier.
 */
export function comparisonRange(range: DateRange, mode: CompareMode, custom?: DateRange | null): DateRange | null {
  if (mode === "none") return null;
  if (mode === "custom") return custom ?? null;
  if (mode === "yoy") return { from: addYears(range.from, -1), to: addYears(range.to, -1) };
  // previous
  const isWholeMonth = range.from === startOfMonth(range.from) && range.to === endOfMonth(range.from);
  if (isWholeMonth) {
    const prevFrom = addMonths(range.from, -1);
    return { from: prevFrom, to: endOfMonth(prevFrom) };
  }
  const n = daysInRange(range);
  return { from: addDays(range.from, -n), to: addDays(range.from, -1) };
}

export function bucketStart(day: string, g: Granularity): string {
  switch (g) {
    case "day":
      return day;
    case "week":
      return startOfWeek(day);
    case "month":
      return startOfMonth(day);
    case "year":
      return startOfYear(day);
  }
}

/** All bucket keys that intersect the range, in order. */
export function bucketsInRange(r: DateRange, g: Granularity): string[] {
  const out: string[] = [];
  let cur = bucketStart(r.from, g);
  while (cur <= r.to) {
    out.push(cur);
    cur = g === "day" ? addDays(cur, 1) : g === "week" ? addDays(cur, 7) : g === "month" ? addMonths(cur, 1) : addYears(cur, 1);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(s: string): string {
  const d = parseIso(s);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function formatShortDay(s: string): string {
  const d = parseIso(s);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function bucketLabel(bucket: string, g: Granularity): string {
  const d = parseIso(bucket);
  switch (g) {
    case "day":
      return formatDay(bucket);
    case "week":
      return `Week of ${formatDay(bucket)}`;
    case "month":
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    case "year":
      return String(d.getUTCFullYear());
  }
}

export function formatRange(r: DateRange): string {
  if (r.from === r.to) return formatDay(r.from);
  const a = parseIso(r.from),
    b = parseIso(r.to);
  if (a.getUTCFullYear() === b.getUTCFullYear()) return `${formatShortDay(r.from)} – ${formatDay(r.to)}`;
  return `${formatDay(r.from)} – ${formatDay(r.to)}`;
}

export const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** 0 = Monday … 6 = Sunday */
export function isoDow(s: string): number {
  return (parseIso(s).getUTCDay() + 6) % 7;
}
