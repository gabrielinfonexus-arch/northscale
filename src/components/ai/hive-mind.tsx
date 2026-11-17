"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUp, Brain, ChevronRight, Database, MessageSquarePlus, Square, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TOOL_LABEL, type Segment, type Turn } from "@/lib/ai-display";
import { deleteConversation, updateConversation } from "@/server/ai-actions";
import { Markdown } from "./markdown";

interface ConversationItem {
  id: string;
  title: string;
  when: string;
}

export interface HiveMindProps {
  conversations: ConversationItem[];
  active: { id: string; clientIds: string[]; heavy: boolean; turns: Turn[] } | null;
  clients: { id: string; name: string }[];
  defaultClientIds: string[];
  suggestions: string[];
  configured: boolean;
  mock: boolean;
  models: { standard: string; heavy: string };
}

type Ev =
  | { type: "conversation"; id: string; title: string }
  | { type: "text" | "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; preview: string }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "assistant_saved"; id: string };

function applyEvent(segments: Segment[], e: Ev): Segment[] {
  const s = [...segments];
  const last = s[s.length - 1];
  switch (e.type) {
    case "text":
    case "thinking":
      if (last && last.kind === e.type) s[s.length - 1] = { ...last, text: last.text + e.delta };
      else s.push({ kind: e.type, text: e.delta });
      return s;
    case "tool_start":
      if (!s.some((x) => x.kind === "tool" && x.id === e.id))
        s.push({ kind: "tool", id: e.id, name: e.name, input: undefined, status: "running" });
      return s;
    case "tool_call": {
      const i = s.findIndex((x) => x.kind === "tool" && x.id === e.id);
      if (i >= 0) s[i] = { ...(s[i] as Extract<Segment, { kind: "tool" }>), input: e.input };
      else s.push({ kind: "tool", id: e.id, name: e.name, input: e.input, status: "running" });
      return s;
    }
    case "tool_result": {
      const i = s.findIndex((x) => x.kind === "tool" && x.id === e.id);
      if (i >= 0) s[i] = { ...(s[i] as Extract<Segment, { kind: "tool" }>), status: e.ok ? "ok" : "error", preview: e.preview };
      return s;
    }
    default:
      return s;
  }
}

function ToolCall({ seg }: { seg: Extract<Segment, { kind: "tool" }> }) {
  return (
    <details className="group rounded-md border border-border bg-surface text-[12.5px]" data-testid="tool-call">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-muted hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        <Database className="size-3.5" aria-hidden />
        <span>{TOOL_LABEL[seg.name] ?? seg.name}</span>
        <span
          className={cn(
            "ml-auto text-[11px]",
            seg.status === "error" ? "text-bad" : seg.status === "running" ? "text-warn" : "text-subtle",
          )}
        >
          {seg.status === "running" ? "running…" : seg.status === "error" ? "error" : "done"}
        </span>
      </summary>
      <div className="space-y-1.5 border-t border-border px-2.5 py-2 font-mono text-[11.5px]">
        <div>
          <span className="text-subtle">{seg.name}</span> {seg.input !== undefined ? JSON.stringify(seg.input) : ""}
        </div>
        {seg.preview && <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-muted">{seg.preview}</pre>}
      </div>
    </details>
  );
}

function AssistantTurn({ segments, streaming }: { segments: Segment[]; streaming?: boolean }) {
  // group consecutive tool calls so a burst of lookups reads as one step
  const groups: (Segment | Extract<Segment, { kind: "tool" }>[])[] = [];
  for (const s of segments) {
    const prev = groups[groups.length - 1];
    if (s.kind === "tool" && Array.isArray(prev)) prev.push(s);
    else groups.push(s.kind === "tool" ? [s] : s);
  }
  return (
    <div className="flex flex-col gap-2" data-testid="assistant-turn">
      {groups.map((g, i) =>
        Array.isArray(g) ? (
          <div key={i} className="flex flex-col gap-1">
            {g.map((s) => (
              <ToolCall key={s.id} seg={s} />
            ))}
          </div>
        ) : g.kind === "thinking" ? (
          <details key={i} className="text-[12.5px] text-muted">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-foreground">
              <Brain className="size-3.5" aria-hidden /> Reasoning
            </summary>
            <p className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3">{g.text}</p>
          </details>
        ) : g.kind === "text" ? (
          <Markdown key={i} text={g.text} />
        ) : null,
      )}
      {streaming && !segments.length && <div className="h-4 w-24 animate-pulse rounded bg-accent" aria-label="Thinking" />}
    </div>
  );
}

export function HiveMind(p: HiveMindProps) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>(p.active?.turns ?? []);
  const [convId, setConvId] = useState<string | null>(p.active?.id ?? null);
  const [clientIds, setClientIds] = useState<string[]>(p.active?.clientIds ?? p.defaultClientIds);
  const [heavy, setHeavy] = useState(p.active?.heavy ?? false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const scopeLabel = clientIds.length ? (p.clients.find((c) => c.id === clientIds[0])?.name ?? "1 client") : "All clients";

  const changeScope = async (v: string) => {
    const ids = v ? [v] : [];
    setClientIds(ids);
    if (convId) await updateConversation(convId, { clientIds: ids });
  };
  const changeHeavy = async (v: boolean) => {
    setHeavy(v);
    if (convId) await updateConversation(convId, { heavy: v });
  };

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || streaming) return;
    setInput("");
    setError(null);
    setStreaming(true);
    setTurns((t) => [...t, { role: "user", id: `u${Date.now()}`, text: msg }, { role: "assistant", id: `a${Date.now()}`, segments: [] }]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    let id = convId;
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: convId ?? undefined, message: msg, scope: { clientIds }, heavy }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body)
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const e = JSON.parse(line.slice(6)) as Ev;
          if (e.type === "conversation") {
            id = e.id;
            setConvId(e.id);
          } else if (e.type === "error") setError(e.message);
          else
            setTurns((t) => {
              const last = t[t.length - 1];
              if (!last || last.role !== "assistant") return t;
              return [...t.slice(0, -1), { ...last, segments: applyEvent(last.segments, e) }];
            });
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setStreaming(false);
      abort.current = null;
      if (id) {
        router.replace(`/hive-mind?c=${id}`, { scroll: false });
        router.refresh();
      }
    }
  }

  const remove = async (id: string) => {
    await deleteConversation(id);
    if (id === convId) router.push("/hive-mind");
    else router.refresh();
  };

  return (
    <div className="flex h-[calc(100vh-172px)] min-h-[520px] gap-4">
      <aside className="hidden w-60 shrink-0 flex-col gap-2 lg:flex" aria-label="Conversations">
        <Button asChild variant="outline" className="justify-start">
          <Link href="/hive-mind?new=1">
            <MessageSquarePlus aria-hidden /> New conversation
          </Link>
        </Button>
        <ul className="scroll-thin -mx-1 flex-1 overflow-y-auto px-1" data-testid="conversation-list">
          {p.conversations.map((c) => (
            <li key={c.id} className="group relative">
              <Link
                href={`/hive-mind?c=${c.id}`}
                className={cn("block rounded-md px-2 py-1.5 pr-7 text-[13px] hover:bg-accent", c.id === convId && "bg-accent font-medium")}
              >
                <span className="line-clamp-1">{c.title}</span>
                <span className="text-[11px] text-subtle">{c.when}</span>
              </Link>
              <button
                type="button"
                onClick={() => remove(c.id)}
                className="absolute right-1 top-2 hidden rounded p-1 text-subtle hover:bg-border hover:text-foreground group-hover:block"
                aria-label={`Delete ${c.title}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
          {!p.conversations.length && <li className="px-2 py-1 text-[12.5px] text-subtle">No conversations yet.</li>}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-surface">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            Scope
            <select
              className="h-7 rounded-md border border-border bg-surface px-2 text-[13px] text-foreground"
              value={clientIds[0] ?? ""}
              onChange={(e) => changeScope(e.target.value)}
              disabled={streaming}
              aria-label="Scope"
            >
              <option value="">All clients</option>
              {p.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {p.mock && (
            <span className="rounded bg-warn-bg px-1.5 py-0.5 text-[11px] font-medium text-warn" data-testid="ai-mock">
              Simulated AI (AI_MOCK)
            </span>
          )}
          <div
            className="ml-auto flex items-center rounded-md border border-border p-0.5 text-[12.5px]"
            role="radiogroup"
            aria-label="Model"
          >
            {[
              { v: false, label: "Standard", title: p.models.standard },
              { v: true, label: "Deep analysis", title: p.models.heavy },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={heavy === o.v}
                title={o.title}
                disabled={streaming}
                onClick={() => changeHeavy(o.v)}
                className={cn("rounded px-2 py-0.5 text-muted", heavy === o.v && "bg-accent font-medium text-foreground")}
              >
                {o.label}
              </button>
            ))}
          </div>
        </header>

        <div className="scroll-thin flex-1 overflow-y-auto px-4 py-4" data-testid="chat-log">
          {!turns.length ? (
            <div className="mx-auto flex max-w-xl flex-col items-center gap-4 pt-10 text-center">
              <h2 className="text-[18px] font-semibold">Ask anything about your accounts</h2>
              <p className="text-[13px] text-muted">
                Hive-Mind reads the same data as every NorthScale screen —{" "}
                {scopeLabel.toLowerCase() === "all clients" ? "all your clients" : scopeLabel} — and never changes anything in your ad
                accounts.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {p.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!p.configured}
                    onClick={() => send(s)}
                    className="rounded-full border border-border px-3 py-1.5 text-[12.5px] hover:bg-accent disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-5">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={t.id} className="self-end rounded-2xl bg-accent px-3.5 py-2 text-[14px]" data-testid="user-turn">
                    {t.text}
                  </div>
                ) : (
                  <AssistantTurn key={t.id} segments={t.segments} streaming={streaming && i === turns.length - 1} />
                ),
              )}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="mx-auto mt-3 flex max-w-3xl items-center gap-2 rounded-md bg-bad-bg px-3 py-2 text-[13px] text-bad"
            >
              <TriangleAlert className="size-4" aria-hidden /> {error}
            </div>
          )}
          <div ref={bottom} />
        </div>

        <form
          className="border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          {!p.configured && (
            <p className="mb-2 text-[12.5px] text-warn">Set ANTHROPIC_API_KEY in the server environment to use Hive-Mind.</p>
          )}
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-border bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              placeholder={`Ask about ${scopeLabel === "All clients" ? "any client" : scopeLabel}…`}
              aria-label="Message"
              disabled={!p.configured}
              className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-[14px] outline-none"
            />
            {streaming ? (
              <Button type="button" size="icon-sm" variant="outline" onClick={() => abort.current?.abort()} aria-label="Stop">
                <Square />
              </Button>
            ) : (
              <Button type="submit" size="icon-sm" disabled={!input.trim() || !p.configured} aria-label="Send">
                <ArrowUp />
              </Button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
