"use server";
import { updateTag } from "next/cache";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "./auth";
import { scopedClients } from "./ai/chat";

type Result = { ok: true } | { ok: false; error: string };

async function own(id: string) {
  const user = await getCurrentUser();
  const c = await prisma.aiConversation.findUnique({ where: { id }, select: { userId: true } });
  if (!c || c.userId !== user.id) throw new Error("Conversation not found");
  return user;
}

export async function deleteConversation(id: string): Promise<Result> {
  const user = await own(id);
  await prisma.aiConversation.delete({ where: { id } });
  updateTag(`ai:${user.id}`);
  return { ok: true };
}

export async function renameConversation(id: string, title: string): Promise<Result> {
  const t = title.trim().slice(0, 120);
  if (!t) return { ok: false, error: "Title required" };
  const user = await own(id);
  await prisma.aiConversation.update({ where: { id }, data: { title: t } });
  updateTag(`ai:${user.id}`);
  return { ok: true };
}

/** Change scope / model of an existing conversation (narrowing only to what the user may see). */
export async function updateConversation(id: string, o: { clientIds?: string[]; heavy?: boolean }): Promise<Result> {
  const user = await own(id);
  const allowed = await scopedClients(user, {});
  const data: { scope?: object; heavy?: boolean } = {};
  if (o.clientIds) data.scope = { clientIds: o.clientIds.filter((x) => allowed.some((c) => c.id === x)), connectionIds: [] };
  if (o.heavy !== undefined) data.heavy = o.heavy;
  await prisma.aiConversation.update({ where: { id }, data });
  updateTag(`ai:${user.id}`);
  return { ok: true };
}
