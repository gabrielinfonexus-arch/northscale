import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

declare global {
  var __prisma: InstanceType<typeof PrismaClient> | undefined;
}

/**
 * Serverless-friendly connection for the running app.
 * Supabase's Session pooler (port 5432) allows only a handful of connections in total, and every Vercel
 * instance opens its own pool — pages fail with "max clients reached". The app therefore talks to the
 * Transaction pooler (same host, port 6543), built for many short connections. Migrations and scripts keep
 * using DATABASE_URL as given (they need a session). Set DB_TRANSACTION_POOLER=0 to opt out.
 */
export function runtimeDatabaseUrl(url: string | undefined = process.env.DATABASE_URL): string {
  if (!url) throw new Error("DATABASE_URL is not set");
  if (process.env.DB_TRANSACTION_POOLER === "0") return url;
  return url.replace(/(@[^/:]+\.pooler\.supabase\.com):5432(\/|$|\?)/, "$1:6543$2");
}

function create() {
  const adapter = new PrismaPg({
    connectionString: runtimeDatabaseUrl(),
    max: Number(process.env.PG_POOL_MAX ?? (process.env.NODE_ENV === "production" ? 3 : 10)), // per server instance
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__prisma ?? create();
if (process.env.NODE_ENV !== "production") globalThis.__prisma = prisma;
