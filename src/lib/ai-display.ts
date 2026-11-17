/** Chat transcript shapes for the Hive-Mind UI (plain JSON; built on the server from stored Anthropic messages). */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; status: "running" | "ok" | "error"; preview?: string };

export type Turn = { role: "user"; id: string; text: string } | { role: "assistant"; id: string; segments: Segment[] };

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

/** Fold stored messages (user text, assistant blocks, user tool results) into display turns. */
export function toTurns(messages: { id: string; role: string; content: unknown }[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const blocks: Block[] = Array.isArray(m.content) ? (m.content as Block[]) : [{ type: "text", text: String(m.content) }];
    if (m.role === "user") {
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      if (text) turns.push({ role: "user", id: m.id, text });
      const last = turns[turns.length - 1];
      for (const b of blocks)
        if (b.type === "tool_result" && last?.role === "assistant") {
          const seg = last.segments.find((s) => s.kind === "tool" && s.id === b.tool_use_id);
          if (seg && seg.kind === "tool") {
            seg.status = b.is_error ? "error" : "ok";
            seg.preview = (typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 2000);
          }
        }
      continue;
    }
    let last = turns[turns.length - 1];
    if (!last || last.role !== "assistant") {
      last = { role: "assistant", id: m.id, segments: [] };
      turns.push(last);
    }
    for (const b of blocks) {
      if (b.type === "text" && b.text) last.segments.push({ kind: "text", text: b.text });
      else if (b.type === "thinking" && b.thinking) last.segments.push({ kind: "thinking", text: b.thinking });
      else if (b.type === "tool_use") last.segments.push({ kind: "tool", id: b.id!, name: b.name!, input: b.input, status: "running" });
    }
  }
  return turns;
}

export const TOOL_LABEL: Record<string, string> = {
  list_clients_and_accounts: "Listed clients and accounts",
  get_metrics: "Read metrics",
  compare_periods: "Compared periods",
  get_breakdown: "Read a breakdown",
  get_top_entities: "Ranked campaigns / ads / products",
  get_shopify_summary: "Read the Shopify summary",
  get_pnl: "Read the P&L",
  get_targets_and_pacing: "Read targets and pacing",
  get_alerts: "Read Watchdog alerts",
  get_chart_notes: "Read Chart Notes",
  run_readonly_sql: "Ran a read-only SQL query",
};

export interface ChartSpec {
  type: "line" | "bar";
  title?: string;
  format?: "currency" | "number" | "percent" | "ratio";
  x: (string | number)[];
  series: { name: string; data: (number | null)[] }[];
}

export function parseChartSpec(raw: string): ChartSpec | null {
  try {
    const s = JSON.parse(raw) as ChartSpec;
    if (!Array.isArray(s.x) || !Array.isArray(s.series) || !s.series.length) return null;
    if (s.series.some((x) => !Array.isArray(x.data) || x.data.length !== s.x.length)) return null;
    return { ...s, type: s.type === "bar" ? "bar" : "line" };
  } catch {
    return null;
  }
}
