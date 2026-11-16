import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";
import type { ChartNoteDTO, NoteCategory } from "@/lib/notes";

export async function getNotes(clientId: string, range?: { from: string; to: string }): Promise<ChartNoteDTO[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`client:${clientId}`, `notes:${clientId}`);
  const rows = await prisma.chartNote.findMany({
    where: { clientId, ...(range ? { date: { gte: new Date(range.from + "T00:00:00Z"), lte: new Date(range.to + "T00:00:00Z") } } : {}) },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((n) => ({
    id: n.id,
    date: n.date.toISOString().slice(0, 10),
    title: n.title,
    description: n.description,
    category: n.category as NoteCategory,
  }));
}
