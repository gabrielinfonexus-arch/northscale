import { describe, expect, it } from "vitest";
import { parseDate, parseNumber, parseOtherRevenueCsv } from "@/lib/other-revenue-csv";

describe("Other Revenue CSV", () => {
  it("parses US-style CSV", () => {
    const r = parseOtherRevenueCsv('date,source,revenue,orders\n2026-11-01,Amazon,"1,234.50",12\n2026-11-02,Amazon,99,1\n');
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { date: "2026-11-01", source: "Amazon", revenue: 1234.5, orders: 12 },
      { date: "2026-11-02", source: "Amazon", revenue: 99, orders: 1 },
    ]);
  });

  it("parses Brazilian CSV with ; and Portuguese headers", () => {
    const r = parseOtherRevenueCsv("﻿Data;Fonte;Receita;Pedidos;Moeda\n01/11/2026;Mercado Livre;R$ 3.810,90;19;BRL\n");
    expect(r.rows).toEqual([{ date: "2026-11-01", source: "Mercado Livre", revenue: 3810.9, orders: 19, currency: "BRL" }]);
  });

  it("reports bad lines without dropping good ones", () => {
    const r = parseOtherRevenueCsv(
      "date,source,revenue\n2026-02-30,Stripe,10\n2026-11-03,,10\n2026-11-04,Stripe,abc\n2026-11-05,Stripe,10\n",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(r.errors[0].message).toContain("invalid date");
  });

  it("requires the core columns", () => {
    expect(parseOtherRevenueCsv("day,amount\n2026-11-01,10").errors[0].message).toMatch(/source/);
  });

  it("number and date helpers", () => {
    expect(parseNumber("1.234,56")).toBe(1234.56);
    expect(parseNumber("1,234.56")).toBe(1234.56);
    expect(parseNumber("-12,5")).toBe(-12.5);
    expect(parseDate("5/1/2026")).toBe("2026-01-05");
    expect(parseDate("2026-13-01")).toBeNull();
  });
});
