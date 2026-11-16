"use client";
import { useMemo, useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { NOTE_CATEGORIES, NOTE_CATEGORY_MAP, type ChartNoteDTO, type NoteCategory } from "@/lib/notes";
import { formatDay } from "@/lib/periods";
import { cn } from "@/lib/utils";
import { NoteDialog, NoteDot, type NoteDraft } from "./note-dialog";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function NotesList({
  clientId,
  notes,
  range,
  today,
  canEdit,
}: {
  clientId: string;
  notes: ChartNoteDTO[];
  range: { from: string; to: string };
  today: string;
  canEdit: boolean;
}) {
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [cats, setCats] = useState<Set<NoteCategory>>(new Set());
  const [inRange, setInRange] = useState(false);

  const filtered = useMemo(
    () => notes.filter((n) => (cats.size === 0 || cats.has(n.category)) && (!inRange || (n.date >= range.from && n.date <= range.to))),
    [notes, cats, inRange, range.from, range.to],
  );
  const groups = useMemo(() => {
    const g = new Map<string, ChartNoteDTO[]>();
    for (const n of filtered) g.set(n.date.slice(0, 7), [...(g.get(n.date.slice(0, 7)) ?? []), n]);
    return [...g];
  }, [filtered]);

  const toggleCat = (c: NoteCategory) =>
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {NOTE_CATEGORIES.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => toggleCat(c.value)}
            aria-pressed={cats.has(c.value)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
              cats.has(c.value) ? "border-primary bg-accent font-medium" : "border-border bg-surface text-muted hover:text-foreground",
            )}
          >
            <NoteDot category={c.value} />
            {c.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          <Switch checked={inRange} onCheckedChange={setInRange} />
          Only selected period
        </label>
        {canEdit && (
          <Button size="sm" onClick={() => setDraft({ date: today })} data-testid="new-note">
            <Plus /> New note
          </Button>
        )}
      </div>

      {groups.length === 0 ? (
        <Card className="px-6 py-14 text-center text-[13px] text-muted">
          No notes yet. Add one here or click any point on a Dashboard chart. Notes explain spikes and drops — and the AI reads them too.
        </Card>
      ) : (
        <div className="flex flex-col gap-5" data-testid="notes-list">
          {groups.map(([month, list]) => (
            <section key={month}>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                {MONTHS[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}
              </h2>
              <Card className="divide-y divide-border">
                {list.map((n) => (
                  <article key={n.id} className="group flex items-start gap-3 px-4 py-3">
                    <span
                      className="mt-1.5 h-8 w-1 shrink-0 rounded-full"
                      style={{ background: NOTE_CATEGORY_MAP[n.category].color }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <h3 className="text-[13.5px] font-medium">{n.title}</h3>
                        <span className="text-xs text-muted">{formatDay(n.date)}</span>
                        <span className="text-xs text-subtle">· {NOTE_CATEGORY_MAP[n.category].label}</span>
                      </div>
                      {n.description && <p className="mt-0.5 text-[13px] text-zinc-600 dark:text-zinc-400">{n.description}</p>}
                    </div>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${n.title}`}
                        onClick={() => setDraft({ ...n })}
                        className="opacity-60 group-hover:opacity-100"
                      >
                        <Pencil />
                      </Button>
                    )}
                  </article>
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}
      <NoteDialog clientId={clientId} draft={draft} onClose={() => setDraft(null)} maxDate={today} />
    </>
  );
}
