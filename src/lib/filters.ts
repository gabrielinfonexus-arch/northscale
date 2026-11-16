/**
 * Global filters live in the URL so any view can be shared as a link.
 *   ?client=<slug>&accounts=<connId,connId>&preset=last_30&from=&to=&gran=day&cmp=previous&cfrom=&cto=
 * Shared by server components (parsing searchParams) and client components (building URLs).
 */
import { comparisonRange, isIsoDate, presetRange, type CompareMode, type DateRange, type Granularity, type Preset } from "./periods";

export interface GlobalFilters {
  client: string | null; // client slug; null = all accessible clients
  accounts: string[]; // connection ids; empty = all accounts of the client
  preset: Preset;
  range: DateRange;
  granularity: Granularity;
  compare: CompareMode;
  compareRange: DateRange | null;
}

export type SearchParams = Record<string, string | string[] | undefined>;

const GRANS: Granularity[] = ["day", "week", "month", "year"];
const PRESET_VALUES: Preset[] = [
  "today",
  "yesterday",
  "last_7",
  "last_14",
  "last_30",
  "last_90",
  "this_month",
  "last_month",
  "this_year",
  "custom",
];
const CMP: CompareMode[] = ["previous", "yoy", "custom", "none"];

export const DEFAULT_PRESET: Preset = "last_30";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseFilters(sp: SearchParams, today: string): GlobalFilters {
  const client = first(sp.client) || null;
  const accounts = (first(sp.accounts) ?? "").split(",").filter(Boolean);
  const granularity = (GRANS as string[]).includes(first(sp.gran) ?? "") ? (first(sp.gran) as Granularity) : "day";
  let preset = (PRESET_VALUES as string[]).includes(first(sp.preset) ?? "") ? (first(sp.preset) as Preset) : null;
  const from = first(sp.from),
    to = first(sp.to);

  let range: DateRange;
  if ((preset === "custom" || preset === null) && isIsoDate(from) && isIsoDate(to) && from <= to) {
    range = { from, to };
    preset = "custom";
  } else {
    if (!preset || preset === "custom") preset = DEFAULT_PRESET;
    range = presetRange(preset as Exclude<Preset, "custom">, today);
  }

  const compare = (CMP as string[]).includes(first(sp.cmp) ?? "") ? (first(sp.cmp) as CompareMode) : "previous";
  const cfrom = first(sp.cfrom),
    cto = first(sp.cto);
  const custom = isIsoDate(cfrom) && isIsoDate(cto) && cfrom <= cto ? { from: cfrom, to: cto } : null;
  const compareR = comparisonRange(range, compare === "custom" && !custom ? "previous" : compare, custom);

  return {
    client,
    accounts,
    preset,
    range,
    granularity,
    compare: compare === "custom" && !custom ? "previous" : compare,
    compareRange: compareR,
  };
}

/** Serialize filters (plus any extra page params) to a query string. Defaults are omitted to keep links short. */
export function filtersToQuery(f: Partial<GlobalFilters>, extra: Record<string, string | null | undefined> = {}): string {
  const p = new URLSearchParams();
  if (f.client) p.set("client", f.client);
  if (f.accounts && f.accounts.length) p.set("accounts", f.accounts.join(","));
  if (f.preset === "custom" && f.range) {
    p.set("preset", "custom");
    p.set("from", f.range.from);
    p.set("to", f.range.to);
  } else if (f.preset && f.preset !== DEFAULT_PRESET) {
    p.set("preset", f.preset);
  }
  if (f.granularity && f.granularity !== "day") p.set("gran", f.granularity);
  if (f.compare && f.compare !== "previous") p.set("cmp", f.compare);
  if (f.compare === "custom" && f.compareRange) {
    p.set("cfrom", f.compareRange.from);
    p.set("cto", f.compareRange.to);
  }
  for (const [k, val] of Object.entries(extra)) if (val) p.set(k, val);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Keys that belong to the global filter set (kept when navigating between pages). */
export const GLOBAL_KEYS = ["client", "accounts", "preset", "from", "to", "gran", "cmp", "cfrom", "cto"] as const;

export function pickGlobalParams(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of GLOBAL_KEYS) {
    const val = sp.get(k);
    if (val) out.set(k, val);
  }
  return out;
}
