import { describe, expect, it } from "vitest";
import { BACKFILL_DAYS, plannedRange } from "@/server/sync/engine";

describe("sync windows", () => {
  const today = "2026-11-16";
  it("backfill covers 13 months", () => {
    const r = plannedRange("BACKFILL", today, 10);
    expect(r).toEqual({ from: "2025-10-17", to: today });
    expect(BACKFILL_DAYS).toBeGreaterThanOrEqual(395);
  });
  it("hourly sync is today, plus yesterday in the first hours of the day", () => {
    expect(plannedRange("INCREMENTAL", today, 14)).toEqual({ from: today, to: today });
    expect(plannedRange("INCREMENTAL", today, 2)).toEqual({ from: "2026-11-15", to: today });
  });
  it("daily re-sync covers the last 7 complete days", () => {
    expect(plannedRange("DAILY", today, 8)).toEqual({ from: "2026-11-09", to: "2026-11-15" });
  });
  it("custom re-sync is clamped to today", () => {
    expect(plannedRange("RESYNC_RANGE", today, 8, { from: "2026-11-01", to: "2026-12-31" })).toEqual({ from: "2026-11-01", to: today });
    expect(() => plannedRange("RESYNC_RANGE", today, 8)).toThrow();
  });
});
