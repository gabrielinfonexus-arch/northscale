import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { accessibleClientIds, type SessionUser } from "../auth";
import { getOrgSettings, listClients, type ClientSummary } from "../clients";
import { AI_MODEL, AI_MODEL_HEAVY, addUsage, costUsd, ZERO_USAGE, type Usage } from "./config";
import { scopeContext, STABLE_SYSTEM } from "./prompt";
import { executeTool, toolDefinitions, ToolError, type ToolContext } from "./tools";
import { streamTurn } from "./transport";

export interface ChatScope {
  clientIds?: string[]; // empty / missing = all clients the user can see
  connectionIds?: string[];
}

/** Events streamed to the browser (Server-Sent Events). */
export type ChatEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; preview: string }
  | { type: "assistant_saved"; id: string }
  | { type: "error"; message: string }
  | { type: "done"; usage: Usage; model: string };

const MAX_ROUNDS = 12;

/** Clients this user may see, narrowed by the conversation scope. The AI never sees anything else. */
export async function scopedClients(user: SessionUser, scope: ChatScope): Promise<ClientSummary[]> {
  const allowed = new Set(await accessibleClientIds(user));
  const all = (await listClients()).filter((c) => allowed.has(c.id));
  return scope.clientIds?.length ? all.filter((c) => scope.clientIds!.includes(c.id)) : all;
}

type Param = Anthropic.Beta.BetaMessageParam;
type Content = Anthropic.Beta.BetaContentBlockParam[];

/** If a previous turn stopped between a tool call and its result (crash, deploy), close it so the history stays valid. */
function repairHistory(history: Param[]): Param[] {
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return [];
  const pending = last.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlockParam[];
  if (!pending.length) return [];
  return [
    {
      role: "user",
      content: pending.map((b) => ({
        type: "tool_result" as const,
        tool_use_id: b.id,
        is_error: true,
        content: "Interrupted before the tool ran.",
      })),
    },
  ];
}

export async function runChat(a: {
  user: SessionUser;
  conversationId: string;
  text: string;
  emit: (e: ChatEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const conv = await prisma.aiConversation.findUnique({
    where: { id: a.conversationId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conv || conv.userId !== a.user.id) throw new Error("Conversation not found");
  const scope = (conv.scope ?? {}) as ChatScope;
  const clients = await scopedClients(a.user, scope);
  const settings = await getOrgSettings();
  const ctx: ToolContext = { clients, connectionIds: scope.connectionIds ?? null, thresholdPct: settings?.comparisonThresholdPct ?? 2 };
  const model = conv.heavy ? AI_MODEL_HEAVY : AI_MODEL;

  const messages: Param[] = conv.messages.map((m) => ({ role: m.role, content: m.content }) as unknown as Param);
  const save = (role: "user" | "assistant", content: Param["content"] | Content, extra: { model?: string; usage?: object } = {}) =>
    prisma.aiMessage.create({
      data: { conversationId: conv.id, role, content: content as never, model: extra.model, usage: extra.usage as never },
    });

  for (const fix of repairHistory(messages)) {
    messages.push(fix);
    await save("user", fix.content);
  }
  const userMsg: Param = { role: "user", content: [{ type: "text", text: a.text }] };
  messages.push(userMsg);
  await save("user", userMsg.content);
  if (!conv.messages.length) {
    const title = a.text.length > 70 ? a.text.slice(0, 67) + "…" : a.text;
    await prisma.aiConversation.update({ where: { id: conv.id }, data: { title } });
    a.emit({ type: "conversation", id: conv.id, title });
  }

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: await scopeContext(clients, scope.connectionIds ?? null) },
  ];
  const tools = toolDefinitions({ stream: true });
  let usage = ZERO_USAGE;
  let parseRetries = 0;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await streamTurn(
          {
            model,
            max_tokens: 64000,
            system,
            tools,
            messages,
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: conv.heavy ? "high" : "medium" },
            cache_control: { type: "ephemeral" },
          },
          {
            onText: (d) => a.emit({ type: "text", delta: d }),
            onThinking: (d) => a.emit({ type: "thinking", delta: d }),
            onToolStart: (id, name) => a.emit({ type: "tool_start", id, name }),
          },
          a.signal,
        );
        parseRetries = 0;
      } catch (e) {
        // eager tool-input streaming: unparseable JSON or a dropped connection → re-issue the turn (API errors are not retried here)
        if (!(e instanceof Anthropic.APIError) && parseRetries++ < 2 && !a.signal?.aborted) continue;
        throw e;
      }
      usage = addUsage(usage, msg.usage);
      messages.push({ role: "assistant", content: msg.content as unknown as Content } as Param);
      const saved = await save("assistant", msg.content as unknown as Content, { model: msg.model, usage: msg.usage });
      a.emit({ type: "assistant_saved", id: saved.id });

      if (msg.stop_reason === "refusal") {
        a.emit({ type: "error", message: "The model declined to answer this request." });
        break;
      }
      const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!calls.length) break;
      if (msg.stop_reason === "max_tokens") {
        // a tool input cut off at max_tokens may parse as a partial object: never run it
        const fix: Param = {
          role: "user",
          content: calls.map((c) => ({
            type: "tool_result" as const,
            tool_use_id: c.id,
            is_error: true,
            content: "Tool input was truncated.",
          })),
        };
        messages.push(fix);
        await save("user", fix.content);
        a.emit({ type: "error", message: "The answer was too long and got cut off. Ask for a narrower question." });
        break;
      }
      const results = await Promise.all(
        calls.map(async (c) => {
          a.emit({ type: "tool_call", id: c.id, name: c.name, input: c.input });
          try {
            const content = await executeTool(ctx, c.name, c.input);
            a.emit({ type: "tool_result", id: c.id, ok: true, preview: content.slice(0, 2000) });
            return { type: "tool_result" as const, tool_use_id: c.id, content };
          } catch (e) {
            const message = e instanceof ToolError ? e.message : "Tool failed.";
            a.emit({ type: "tool_result", id: c.id, ok: false, preview: message });
            return { type: "tool_result" as const, tool_use_id: c.id, content: message, is_error: true };
          }
        }),
      );
      const toolMsg: Param = { role: "user", content: results };
      messages.push(toolMsg);
      await save("user", toolMsg.content);
      if (round === MAX_ROUNDS - 1)
        a.emit({ type: "error", message: "Stopped after many tool calls. Ask a narrower question or continue." });
    }
  } catch (e) {
    a.emit({ type: "error", message: describeError(e) });
  } finally {
    await prisma.aiConversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } });
    if (usage.input || usage.output)
      await recordUsage({ user: a.user, clientId: clients.length === 1 ? clients[0].id : null, feature: "hive_mind", model, usage });
    a.emit({ type: "done", usage, model });
  }
}

export async function recordUsage(a: {
  user?: SessionUser | null;
  organizationId?: string;
  clientId: string | null;
  feature: "hive_mind" | "insights";
  model: string;
  usage: Usage;
}) {
  await prisma.aiUsage.create({
    data: {
      organizationId: a.user?.organizationId ?? a.organizationId ?? null,
      userId: a.user?.id ?? null,
      clientId: a.clientId,
      feature: a.feature,
      model: a.model,
      inputTokens: a.usage.input,
      outputTokens: a.usage.output,
      cacheReadTokens: a.usage.cacheRead,
      cacheWriteTokens: a.usage.cacheWrite,
      costUsd: costUsd(a.model, a.usage),
    },
  });
}

export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Anthropic API key is missing or invalid (ANTHROPIC_API_KEY).";
  if (e instanceof Anthropic.PermissionDeniedError) return "This API key cannot use the configured model.";
  if (e instanceof Anthropic.NotFoundError) return "The configured model was not found (check ANTHROPIC_MODEL / ANTHROPIC_MODEL_HEAVY).";
  if (e instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached — try again in a minute.";
  if (e instanceof Anthropic.BadRequestError) return `The AI request was rejected: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Anthropic API error (${e.status ?? "network"}). Try again.`;
  if ((e as Error)?.name === "AbortError") return "Stopped.";
  return (e as Error)?.message || "Something went wrong.";
}
