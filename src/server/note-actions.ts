"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { NOTE_CATEGORIES } from "@/lib/notes";
import { assertCanEdit } from "./auth";

const NoteInput = z.object({
  clientId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1, "Title is required").max(140),
  description: z.string().trim().max(2000).optional().nullable(),
  category: z.enum(NOTE_CATEGORIES.map((c) => c.value) as [string, ...string[]]),
});
export type NoteInput = z.infer<typeof NoteInput>;

function invalidate(clientId: string) {
  updateTag(`notes:${clientId}`);
  updateTag(`client:${clientId}`);
}

export async function createNote(input: NoteInput) {
  const d = NoteInput.parse(input);
  const user = await assertCanEdit(d.clientId);
  await prisma.chartNote.create({
    data: {
      clientId: d.clientId,
      date: new Date(d.date + "T00:00:00Z"),
      title: d.title,
      description: d.description || null,
      category: d.category as never,
      createdById: user.id,
    },
  });
  invalidate(d.clientId);
}

export async function updateNote(id: string, input: NoteInput) {
  const d = NoteInput.parse(input);
  const existing = await prisma.chartNote.findUnique({ where: { id } });
  if (!existing || existing.clientId !== d.clientId) throw new Error("Not found");
  await assertCanEdit(existing.clientId);
  await prisma.chartNote.update({
    where: { id },
    data: { date: new Date(d.date + "T00:00:00Z"), title: d.title, description: d.description || null, category: d.category as never },
  });
  invalidate(d.clientId);
}

export async function deleteNote(id: string) {
  const existing = await prisma.chartNote.findUnique({ where: { id } });
  if (!existing) return;
  await assertCanEdit(existing.clientId);
  await prisma.chartNote.delete({ where: { id } });
  invalidate(existing.clientId);
}
