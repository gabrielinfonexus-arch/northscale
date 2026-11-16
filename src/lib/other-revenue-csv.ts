/**
 * CSV import for Other Revenue: date, source, revenue[, orders][, currency]
 * Accepts English/Portuguese headers, "," or ";" separators, US (1,234.56) or BR (1.234,56) numbers,
 * ISO (2026-11-01) or day-first (01/11/2026) dates. Pure; used in the browser (preview) and on the server.
 */
export interface OtherRevenueRow {
  date: string;
  source: string;
  revenue: number;
  orders: number;
  currency?: string;
}
export interface ParseResult {
  rows: OtherRevenueRow[];
  errors: { line: number; message: string }[];
}

const HEADERS: Record<keyof OtherRevenueRow, string[]> = {
  date: ["date", "data", "dia", "day"],
  source: ["source", "fonte", "origem", "canal", "channel"],
  revenue: ["revenue", "receita", "amount", "valor", "faturamento", "sales"],
  orders: ["orders", "pedidos", "vendas", "qty", "quantidade"],
  currency: ["currency", "moeda"],
};

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === sep && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** "1.234,56" → 1234.56 ; "1,234.56" → 1234.56 ; "R$ 99,90" → 99.9 */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/[^\d,.-]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(","),
    lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function parseOtherRevenueCsv(text: string): ParseResult {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const res: ParseResult = { rows: [], errors: [] };
  if (!lines.length) return { rows: [], errors: [{ line: 0, message: "The file is empty." }] };
  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const header = splitLine(lines[0], sep).map((h) => h.toLowerCase());
  const idx = Object.fromEntries(Object.entries(HEADERS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))])) as Record<
    keyof OtherRevenueRow,
    number
  >;
  if (idx.date < 0 || idx.source < 0 || idx.revenue < 0)
    return { rows: [], errors: [{ line: 1, message: "Header must contain date, source and revenue columns." }] };
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i], sep);
    const date = parseDate(cols[idx.date] ?? "");
    const source = (cols[idx.source] ?? "").trim();
    const revenue = parseNumber(cols[idx.revenue] ?? "");
    const orders = idx.orders >= 0 ? parseNumber(cols[idx.orders] ?? "") : 0;
    const currency = idx.currency >= 0 ? (cols[idx.currency] ?? "").trim().toUpperCase() || undefined : undefined;
    const problems = [
      !date && "invalid date",
      !source && "missing source",
      revenue === null && "invalid revenue",
      currency && !/^[A-Z]{3}$/.test(currency) && "invalid currency",
    ].filter(Boolean);
    if (problems.length) res.errors.push({ line: i + 1, message: problems.join(", ") });
    else
      res.rows.push({
        date: date!,
        source: source.slice(0, 80),
        revenue: revenue!,
        orders: Math.max(0, Math.round(orders ?? 0)),
        ...(currency ? { currency } : {}),
      });
  }
  return res;
}
