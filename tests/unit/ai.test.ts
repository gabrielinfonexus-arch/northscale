import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("next/cache", () => ({ cacheLife: () => {}, cacheTag: () => {}, revalidateTag: () => {}, updateTag: () => {} }));
const getDataTable = vi.fn();
vi.mock("@/server/data/data-page", () => ({ getDataTable: (...a: unknown[]) => getDataTable(...a) }));
vi.mock("@/server/pnl", () => ({ getPnl: vi.fn() }));
vi.mock("@/server/targets", () => ({ getMonthPacing: vi.fn() }));
vi.mock("@/server/notes", () => ({ getNotes: vi.fn() }));

import { checkSql } from "@/server/ai/sql-sandbox";
import { executeTool, toolDefinitions, ToolError, type ToolContext } from "@/server/ai/tools";
import { addUsage, costUsd, ZERO_USAGE } from "@/server/ai/config";
import { insightPeriod } from "@/server/ai/insights";
import { parseChartSpec, toTurns } from "@/lib/ai-display";

const client = (id: string, slug: string, name: string) => ({
  id,
  slug,
  name,
  currency: "USD",
  timezone: "America/New_York",
  logoUrl: null,
  isDemo: true,
  newAudienceMinPct: 60,
  breakevenAov: null,
  breakevenMarginPct: null,
  fixedCostsMonthly: 0,
  profitMultiplier: 1.1,
  connections: [
    { id: `${id}-meta`, platform: "META" as const, externalId: "act_1", name: `${name} Meta`, currency: "USD", status: "OK" as const },
  ],
});
const A = client("c1", "aurora", "Aurora");
const B = client("c2", "casa", "Casa Verde");

describe("run_readonly_sql guard", () => {
  it("accepts one SELECT / WITH", () => {
    expect(checkSql("select * from ai_client_daily;")).toEqual({ ok: true, sql: "select * from ai_client_daily" });
    expect(checkSql("WITH x AS (select 1) select * from x").ok).toBe(true);
  });
  it.each([
    ["delete from alerts", "Only SELECT"],
    ["select 1; select 2", "one statement"],
    ["select set_config('role','postgres',true)", "set_config"],
    ["select pg_sleep(10)", "pg_sleep"],
    ["select pg_read_file('/etc/passwd')", "pg_read_file"],
    ["select 1 -- comment", "Comments"],
    ['select * from U&"\\0063lients"', "U&"],
    ["", "Empty"],
  ])("rejects %s", (q, msg) => {
    const r = checkSql(q);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(msg);
  });
});

describe("AI tools", () => {
  const ctx: ToolContext = { clients: [A] };

  it("definitions are plain JSON Schema with eager streaming when streaming", () => {
    const defs = toolDefinitions({ stream: true });
    expect(defs.map((d) => d.name)).toContain("run_readonly_sql");
    for (const d of defs) {
      expect(d.input_schema.type).toBe("object");
      expect(d.input_schema).not.toHaveProperty("$schema");
      expect(d.eager_input_streaming).toBe(true);
    }
    expect(toolDefinitions({ stream: false })[0]).not.toHaveProperty("eager_input_streaming");
  });

  it("only sees the clients in scope (permissions)", async () => {
    await expect(executeTool(ctx, "get_metrics", { client: "casa" })).rejects.toThrow(/not in scope/);
    await expect(executeTool({ clients: [A, B] }, "get_metrics", {})).rejects.toThrow(/Several clients/);
    const list = JSON.parse(await executeTool(ctx, "list_clients_and_accounts", {}));
    expect(list.map((c: { client: string }) => c.client)).toEqual(["aurora"]);
  });

  it("restricts accounts to the conversation scope", async () => {
    const list = JSON.parse(await executeTool({ clients: [A], connectionIds: ["nope"] }, "list_clients_and_accounts", {}));
    expect(list[0].accounts).toEqual([]);
  });

  it("validates input before running (invalid / truncated tool input)", async () => {
    await expect(executeTool(ctx, "get_breakdown", { platform: "meta", breakdown: "zodiac" })).rejects.toBeInstanceOf(ToolError);
    await expect(executeTool(ctx, "nope", {})).rejects.toThrow(/Unknown tool/);
    await expect(executeTool(ctx, "get_metrics", { from: "2026-11-10", to: "2026-11-01" })).rejects.toThrow(/from ≤ to/);
  });

  it("reads metrics through the Data page model with comparison tone and '—' reasons", async () => {
    getDataTable.mockResolvedValueOnce({
      columns: [
        { id: "spend", kind: "metric", metric: "spend" },
        { id: "roas", kind: "metric", metric: "roas" },
        { id: "cpa", kind: "metric", metric: "cpa" },
        { id: "reach", kind: "metric", metric: "reach" },
      ],
      defaultVisible: ["spend", "roas", "cpa"],
      rows: [],
      total: { spend: 1000, purchaseValue: 3000, purchases: 20, reach: null },
      totalCompare: { spend: 1000, purchaseValue: 2000, purchases: 25 },
      unavailable: { reach: "Meta only", cogs: "irrelevant here" },
      currency: "USD",
    });
    const r = JSON.parse(
      await executeTool(ctx, "get_metrics", {
        platform: "meta",
        from: "2026-11-01",
        to: "2026-11-07",
        metrics: ["spend", "roas", "cpa", "reach"],
      }),
    );
    expect(getDataTable.mock.calls[0][0]).toMatchObject({
      clientId: "c1",
      platform: "meta",
      tab: "core",
      range: { from: "2026-11-01", to: "2026-11-07" },
      compareRange: { from: "2026-10-25", to: "2026-10-31" },
    });
    expect(r.total.values).toEqual({ spend: "$1,000.00", roas: "3.00x", cpa: "$50.00", reach: "—" });
    expect(r.total.change.roas).toMatch(/^\+50\.0% vs 2\.00x \(better\)/);
    expect(r.total.change.cpa).toBe("+25.0% vs $40.00 (worse)"); // CPA 40 → 50: lower is better
    expect(r.not_available).toEqual({ reach: "Meta only" });
  });
});

describe("AI helpers", () => {
  it("usage and cost", () => {
    const u = addUsage(ZERO_USAGE, {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    });
    expect(costUsd("claude-sonnet-5-5", u)).toBeCloseTo(2 + 1 + 0.1);
    expect(costUsd("unknown-model", u)).toBe(0);
  });

  it("insight periods", () => {
    expect(insightPeriod("daily", "2026-11-17")).toEqual({
      range: { from: "2026-11-10", to: "2026-11-16" },
      compare: { from: "2026-11-03", to: "2026-11-09" },
    });
    // 2026-11-17 is a Tuesday → last full week Mon 9 – Sun 15
    expect(insightPeriod("weekly", "2026-11-17")).toEqual({
      range: { from: "2026-11-09", to: "2026-11-15" },
      compare: { from: "2026-11-02", to: "2026-11-08" },
    });
  });

  it("transcript: tool results attach to their calls", () => {
    const turns = toTurns([
      { id: "1", role: "user", content: [{ type: "text", text: "hi" }] },
      {
        id: "2",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "Looking" },
          { type: "tool_use", id: "t1", name: "get_metrics", input: {} },
        ],
      },
      { id: "3", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}", is_error: false }] },
      { id: "4", role: "assistant", content: [{ type: "text", text: "Done" }] },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      role: "assistant",
      segments: [{ kind: "thinking" }, { kind: "text", text: "Looking" }, { kind: "tool", status: "ok" }, { kind: "text", text: "Done" }],
    });
  });

  it("chart blocks are validated", () => {
    expect(parseChartSpec('{"type":"bar","x":["a","b"],"series":[{"name":"s","data":[1,2]}]}')).toMatchObject({ type: "bar" });
    expect(parseChartSpec('{"x":["a"],"series":[{"name":"s","data":[1,2]}]}')).toBeNull();
    expect(parseChartSpec("not json")).toBeNull();
  });
});
