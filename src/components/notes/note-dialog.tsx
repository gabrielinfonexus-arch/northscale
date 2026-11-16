"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NOTE_CATEGORIES, type ChartNoteDTO, type NoteCategory } from "@/lib/notes";
import { createNote, deleteNote, updateNote } from "@/server/note-actions";

export interface NoteDraft {
  id?: string;
  date: string;
  title?: string;
  description?: string | null;
  category?: NoteCategory;
}

const field = "h-8 w-full rounded-md border border-border bg-surface px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring";

export function NoteDialog({
  clientId,
  draft,
  onClose,
  maxDate,
}: {
  clientId: string;
  draft: NoteDraft | null;
  onClose: () => void;
  maxDate?: string;
}) {
  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {draft && <NoteForm key={draft.id ?? draft.date} clientId={clientId} draft={draft} onDone={onClose} maxDate={maxDate} />}
      </DialogContent>
    </Dialog>
  );
}

function NoteForm({ clientId, draft, onDone, maxDate }: { clientId: string; draft: NoteDraft; onDone: () => void; maxDate?: string }) {
  const router = useRouter();
  const [date, setDate] = useState(draft.date);
  const [title, setTitle] = useState(draft.title ?? "");
  const [description, setDescription] = useState(draft.description ?? "");
  const [category, setCategory] = useState<NoteCategory>(draft.category ?? "OTHER");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setError(null);
      if (!title.trim()) {
        setError("Title is required.");
        return;
      }
      try {
        const input = { clientId, date, title, description, category };
        if (draft.id) await updateNote(draft.id, input);
        else await createNote(input);
        router.refresh();
        onDone();
      } catch {
        setError("Could not save the note.");
      }
    });

  const remove = () =>
    start(async () => {
      if (!draft.id) return;
      await deleteNote(draft.id);
      router.refresh();
      onDone();
    });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div>
        <DialogTitle className="text-base font-semibold">{draft.id ? "Edit chart note" : "New chart note"}</DialogTitle>
        <DialogDescription className="text-xs text-muted">Shown as a marker on every time chart and available to the AI.</DialogDescription>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Date
        <input type="date" required value={date} max={maxDate} onChange={(e) => setDate(e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Title
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={140}
          className={field}
          placeholder="e.g. Launched summer sale"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Category
        <select value={category} onChange={(e) => setCategory(e.target.value as NoteCategory)} className={field}>
          {NOTE_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Description
        <textarea
          value={description ?? ""}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={2000}
          className={`${field} h-auto py-1.5`}
        />
      </label>
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="flex items-center gap-2">
        {draft.id && (
          <Button type="button" variant="ghost" className="text-bad" onClick={remove} disabled={pending}>
            Delete
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending} data-testid="note-save">
            {pending ? "Saving…" : "Save note"}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function NoteDot({ category, className = "" }: { category: NoteCategory; className?: string }) {
  const c = NOTE_CATEGORIES.find((x) => x.value === category);
  return <span className={`inline-block size-2 shrink-0 rounded-full ${className}`} style={{ background: c?.color }} aria-hidden />;
}

export type { ChartNoteDTO };
