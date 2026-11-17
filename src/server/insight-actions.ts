"use server";
import { updateTag } from "next/cache";
import { prisma } from "@/lib/db";
import { assertCanEdit } from "./auth";
import { generateInsights } from "./ai/insights";
import { describeError } from "./ai/chat";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export async function generateInsightsNow(clientId: string): Promise<Result<{ count: number }>> {
  await assertCanEdit(clientId);
  try {
    const r = await generateInsights(clientId, "on_demand");
    updateTag(`insights:${clientId}`);
    return { ok: true, count: r.count };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

async function insightFor(id: string) {
  const i = await prisma.aiInsight.findUnique({ where: { id } });
  if (!i) throw new Error("Insight not found");
  const user = await assertCanEdit(i.clientId);
  return { i, user };
}

export async function setInsightFeedback(id: string, feedback: "useful" | "not_useful" | null): Promise<Result> {
  const { i } = await insightFor(id);
  await prisma.aiInsight.update({ where: { id }, data: { feedback } });
  updateTag(`insights:${i.clientId}`);
  return { ok: true };
}

/** "Turn into Chart Note": the insight becomes an annotation on the last day of its period. */
export async function insightToNote(id: string): Promise<Result> {
  const { i, user } = await insightFor(id);
  if (i.noteId) return { ok: true };
  const note = await prisma.chartNote.create({
    data: {
      clientId: i.clientId,
      date: i.periodTo ?? new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z"),
      title: i.title.slice(0, 140),
      description: `${i.whatChanged}\n\nProvável causa: ${i.likelyCause}\nAção: ${i.action}`.slice(0, 2000),
      category: "OTHER",
      createdById: user.id,
    },
  });
  await prisma.aiInsight.update({ where: { id }, data: { noteId: note.id } });
  updateTag(`insights:${i.clientId}`);
  updateTag(`notes:${i.clientId}`);
  updateTag(`client:${i.clientId}`);
  return { ok: true };
}
