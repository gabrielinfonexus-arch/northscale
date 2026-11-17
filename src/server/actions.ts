"use server";
import { updateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "./auth";

/** Per-user preference (column choices, layouts…). */
export async function savePreference(key: string, value: unknown) {
  const k = z
    .string()
    .regex(/^[a-zA-Z0-9_.:-]{1,120}$/)
    .parse(key);
  const user = await getCurrentUser();
  if (user.kind !== "user") return; // public links have no account to remember preferences
  await prisma.userPreference.upsert({
    where: { userId_key: { userId: user.id, key: k } },
    update: { value: value as never },
    create: { userId: user.id, key: k, value: value as never },
  });
  updateTag(`prefs:${user.id}`);
}

export async function setDemoData(enabled: boolean) {
  const user = await getCurrentUser();
  if (user.role !== "OWNER" && user.role !== "ADMIN") throw new Error("Forbidden");
  await prisma.orgSetting.update({ where: { organizationId: user.organizationId }, data: { demoData: z.boolean().parse(enabled) } });
  updateTag("clients");
}
