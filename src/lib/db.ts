import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

declare global {
  var __prisma: InstanceType<typeof PrismaClient> | undefined;
}

function create() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__prisma ?? create();
if (process.env.NODE_ENV !== "production") globalThis.__prisma = prisma;
