import type { MetricFormat } from "./metrics";

const LOCALE_BY_CURRENCY: Record<string, string> = {
  USD: "en-US",
  BRL: "pt-BR",
  EUR: "de-DE",
  GBP: "en-GB",
  CAD: "en-CA",
  AUD: "en-AU",
  MXN: "es-MX",
};

export function localeFor(currency: string): string {
  return LOCALE_BY_CURRENCY[currency] ?? "en-US";
}

const cache = new Map<string, Intl.NumberFormat>();
function nf(key: string, locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    cache.set(key, f);
  }
  return f;
}

export const EMPTY = "—";

export function formatCurrency(value: number, currency: string, opts: { compact?: boolean; decimals?: number } = {}): string {
  const locale = localeFor(currency);
  const decimals = opts.decimals ?? 2;
  const key = `c|${currency}|${opts.compact ? 1 : 0}|${decimals}`;
  return nf(key, locale, {
    style: "currency",
    currency,
    notation: opts.compact ? "compact" : "standard",
    minimumFractionDigits: opts.compact ? 0 : decimals,
    maximumFractionDigits: opts.compact ? 1 : decimals,
  }).format(value);
}

export function formatNumber(value: number, currency = "USD", decimals = 0, compact = false): string {
  return nf(`n|${localeFor(currency)}|${decimals}|${compact ? 1 : 0}`, localeFor(currency), {
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: compact ? 0 : decimals,
    maximumFractionDigits: compact ? 1 : decimals,
  }).format(value);
}

/** value is a fraction (0.0234 → "2.34%"). */
export function formatPercent(value: number, currency = "USD", decimals = 2): string {
  return nf(`p|${localeFor(currency)}|${decimals}`, localeFor(currency), {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatMetricValue(
  value: number | null | undefined,
  format: MetricFormat,
  currency: string,
  opts: { compact?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  switch (format) {
    case "currency":
      return formatCurrency(value, currency, { compact: opts.compact });
    case "number":
      return formatNumber(value, currency, Number.isInteger(value) || Math.abs(value) >= 100 ? 0 : 1, opts.compact);
    case "percent":
      return formatPercent(value, currency, value !== 0 && Math.abs(value) < 0.1 ? 2 : 1);
    case "ratio":
      return `${formatNumber(value, currency, 2)}x`;
    case "decimal":
      return formatNumber(value, currency, 2);
  }
}

export function formatDeltaPct(deltaPct: number | null, currency = "USD"): string {
  if (deltaPct === null || !Number.isFinite(deltaPct)) return EMPTY;
  const abs = Math.abs(deltaPct);
  return `${formatNumber(abs, currency, abs < 10 ? 1 : 0)}%`;
}
