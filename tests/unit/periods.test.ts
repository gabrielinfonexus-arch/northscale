import { describe, expect, it } from "vitest";
import {
  addMonths,
  bucketLabel,
  bucketStart,
  bucketsInRange,
  comparisonRange,
  daysInRange,
  isIsoDate,
  presetRange,
  todayInTz,
} from "@/lib/periods";
import { filtersToQuery, parseFilters } from "@/lib/filters";

const TODAY = "2026-04-23"; // Thursday

describe("presets", () => {
  it("resolves relative presets ending yesterday", () => {
    expect(presetRange("last_7", TODAY)).toEqual({ from: "2026-04-16", to: "2026-04-22" });
    expect(presetRange("last_30", TODAY)).toEqual({ from: "2026-03-24", to: "2026-04-22" });
    expect(presetRange("today", TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(presetRange("yesterday", TODAY)).toEqual({ from: "2026-04-22", to: "2026-04-22" });
  });

  it("calendar presets", () => {
    expect(presetRange("this_month", TODAY)).toEqual({ from: "2026-04-01", to: TODAY });
    expect(presetRange("last_month", TODAY)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(presetRange("last_month", "2026-03-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("this_year", TODAY)).toEqual({ from: "2026-01-01", to: TODAY });
  });
});

describe("comparison periods", () => {
  it("previous period has the same length, right before", () => {
    const r = { from: "2026-04-16", to: "2026-04-22" };
    const c = comparisonRange(r, "previous")!;
    expect(c).toEqual({ from: "2026-04-09", to: "2026-04-15" });
    expect(daysInRange(c)).toBe(daysInRange(r));
  });

  it("whole months compare with the whole previous month", () => {
    expect(comparisonRange({ from: "2026-03-01", to: "2026-03-31" }, "previous")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("same period last year", () => {
    expect(comparisonRange({ from: "2026-04-01", to: "2026-04-22" }, "yoy")).toEqual({ from: "2025-04-01", to: "2025-04-22" });
    expect(comparisonRange({ from: "2024-02-29", to: "2024-02-29" }, "yoy")).toEqual({ from: "2023-02-28", to: "2023-02-28" });
  });

  it("custom and none", () => {
    const custom = { from: "2026-01-01", to: "2026-01-07" };
    expect(comparisonRange({ from: "2026-04-01", to: "2026-04-07" }, "custom", custom)).toEqual(custom);
    expect(comparisonRange({ from: "2026-04-01", to: "2026-04-07" }, "none")).toBeNull();
  });
});

describe("buckets", () => {
  it("weeks start on Monday", () => {
    expect(bucketStart("2026-04-23", "week")).toBe("2026-04-20");
    expect(bucketStart("2026-04-26", "week")).toBe("2026-04-20"); // Sunday
    expect(bucketStart("2026-04-20", "week")).toBe("2026-04-20");
  });

  it("lists buckets intersecting a range", () => {
    expect(bucketsInRange({ from: "2026-01-15", to: "2026-03-02" }, "month")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(bucketsInRange({ from: "2026-04-01", to: "2026-04-03" }, "day")).toHaveLength(3);
    expect(bucketsInRange({ from: "2025-12-30", to: "2026-01-02" }, "year")).toEqual(["2025-01-01", "2026-01-01"]);
  });

  it("labels", () => {
    expect(bucketLabel("2026-04-08", "day")).toBe("Apr 8, 2026");
    expect(bucketLabel("2026-04-01", "month")).toBe("Apr 2026");
  });

  it("month arithmetic clamps", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("validates ISO dates and resolves today per timezone", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-02-28")).toBe(true);
    const now = new Date("2026-04-23T02:00:00Z");
    expect(todayInTz("America/Sao_Paulo", now)).toBe("2026-04-22");
    expect(todayInTz("Europe/Berlin", now)).toBe("2026-04-23");
  });
});

describe("URL filters", () => {
  it("defaults", () => {
    const f = parseFilters({}, TODAY);
    expect(f.preset).toBe("last_30");
    expect(f.granularity).toBe("day");
    expect(f.compare).toBe("previous");
    expect(f.compareRange).toEqual({ from: "2026-02-22", to: "2026-03-23" });
  });

  it("custom range and accounts", () => {
    const f = parseFilters({ client: "aurora", accounts: "a,b", from: "2026-04-01", to: "2026-04-10", gran: "week", cmp: "yoy" }, TODAY);
    expect(f).toMatchObject({ client: "aurora", accounts: ["a", "b"], preset: "custom", granularity: "week", compare: "yoy" });
    expect(f.range).toEqual({ from: "2026-04-01", to: "2026-04-10" });
    expect(f.compareRange).toEqual({ from: "2025-04-01", to: "2025-04-10" });
  });

  it("rejects invalid values", () => {
    const f = parseFilters({ gran: "hour", preset: "bogus", from: "2026-04-10", to: "2026-04-01", cmp: "x" }, TODAY);
    expect(f.granularity).toBe("day");
    expect(f.preset).toBe("last_30");
    expect(f.compare).toBe("previous");
  });

  it("round-trips through the query string", () => {
    const f = parseFilters(
      { client: "aurora", preset: "last_7", gran: "month", cmp: "custom", cfrom: "2026-01-01", cto: "2026-01-07" },
      TODAY,
    );
    const q = filtersToQuery(f);
    const back = parseFilters(Object.fromEntries(new URLSearchParams(q)), TODAY);
    expect(back).toEqual(f);
  });
});
