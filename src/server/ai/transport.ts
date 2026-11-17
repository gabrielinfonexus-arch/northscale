import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { aiMockEnabled, anthropic, FALLBACK } from "./config";

type Msg = Anthropic.Beta.BetaMessage;
type Params = Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, "stream" | "betas" | "fallbacks">;

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** a tool call started (input still streaming) */
  onToolStart?: (id: string, name: string) => void;
}

/** One model turn, streamed. Resolves with the complete message (all content blocks, to be replayed unchanged). */
export async function streamTurn(params: Params, h: StreamHandlers = {}, signal?: AbortSignal): Promise<Msg> {
  if (aiMockEnabled()) return mockTurn(params, h);
  const stream = anthropic().beta.messages.stream({ ...params, ...FALLBACK }, { signal });
  for await (const ev of stream) {
    if (ev.type === "content_block_start" && ev.content_block.type === "tool_use")
      h.onToolStart?.(ev.content_block.id, ev.content_block.name);
    else if (ev.type === "content_block_delta") {
      if (ev.delta.type === "text_delta") h.onText?.(ev.delta.text);
      else if (ev.delta.type === "thinking_delta") h.onThinking?.(ev.delta.thinking);
    }
  }
  return stream.finalMessage();
}

// ───────────────────────── scripted model (AI_MOCK=1) ─────────────────────────
// Exercises the whole pipeline without the API: one tool round to find clients, one to read metrics,
// then an answer with a Markdown table and a chart block built only from the tool results.

let seq = 0;
const id = (p: string) => `${p}_mock_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function lastToolResults(params: Params): Record<string, string> {
  const last = params.messages[params.messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return {};
  const out: Record<string, string> = {};
  const prev = params.messages[params.messages.length - 2];
  const names = new Map<string, string>();
  if (prev && prev.role === "assistant" && typeof prev.content !== "string")
    for (const b of prev.content) if (b.type === "tool_use") names.set(b.id, b.name);
  for (const b of last.content)
    if (b.type === "tool_result")
      out[names.get(b.tool_use_id) ?? b.tool_use_id] = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
  return out;
}

async function mockTurn(params: Params, h: StreamHandlers): Promise<Msg> {
  const results = lastToolResults(params);
  const say = async (text: string) => {
    for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) {
      h.onText?.(chunk);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const msg = (content: Anthropic.Beta.BetaContentBlock[], stop: "end_turn" | "tool_use"): Msg =>
    ({
      id: id("msg"),
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
    }) as unknown as Msg;
  const toolUse = (name: string, input: Record<string, unknown>) => {
    const tid = id("toolu");
    h.onToolStart?.(tid, name);
    return { type: "tool_use", id: tid, name, input } as unknown as Anthropic.Beta.BetaContentBlock;
  };

  if (results.list_clients_and_accounts) {
    const clients = JSON.parse(results.list_clients_and_accounts) as { client: string }[];
    const text = "Now the numbers for the last 7 days.";
    await say(text);
    return msg(
      [
        { type: "text", text, citations: null } as Anthropic.Beta.BetaContentBlock,
        toolUse("get_metrics", {
          client: clients[0]?.client,
          preset: "last_7",
          level: "period",
          metrics: ["spend", "totalRevenue", "mer"],
        }),
      ],
      "tool_use",
    );
  }
  if (results.get_metrics) {
    const r = JSON.parse(results.get_metrics) as {
      client: string;
      period: string;
      total: { values: Record<string, string>; change?: Record<string, string> };
      rows?: { label: string; values: Record<string, string> }[];
    };
    const num = (s: string) => Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
    const rows = r.rows ?? [];
    const table = [
      "| Metric | Value | Change |",
      "|---|---:|---|",
      ...Object.entries(r.total.values).map(([k, v]) => `| ${k} | ${v} | ${r.total.change?.[k] ?? ""} |`),
    ].join("\n");
    const chart = JSON.stringify({
      type: "line",
      title: "Spend vs total revenue",
      format: "currency",
      x: rows.map((x) => x.label),
      series: [
        { name: "Spend", data: rows.map((x) => num(x.values.spend)) },
        { name: "Total revenue", data: rows.map((x) => num(x.values.totalRevenue)) },
      ],
    });
    const text = `**${r.client}**, ${r.period} (blended: ads + Shopify + other revenue) — simulated answer (AI_MOCK).\n\n${table}\n\n\`\`\`chart\n${chart}\n\`\`\``;
    await say(text);
    return msg([{ type: "text", text, citations: null } as Anthropic.Beta.BetaContentBlock], "end_turn");
  }
  const text = "Let me look up the clients in scope.";
  h.onThinking?.("Deciding which tools to call…");
  await say(text);
  return msg(
    [{ type: "text", text, citations: null } as Anthropic.Beta.BetaContentBlock, toolUse("list_clients_and_accounts", {})],
    "tool_use",
  );
}
