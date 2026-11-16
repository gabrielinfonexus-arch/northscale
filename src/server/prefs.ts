import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { prisma } from "@/lib/db";

export async function getPreference<T>(userId: string, key: string): Promise<T | null> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`prefs:${userId}`);
  const p = await prisma.userPreference.findUnique({ where: { userId_key: { userId, key } } });
  return (p?.value as T) ?? null;
}
