// Runs on every deploy (npm run vercel-build): applies migrations, and seeds the demo data once on an empty database.
import "dotenv/config";
import { execSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const run = (cmd: string, env: NodeJS.ProcessEnv = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });

/**
 * Migrations that were fixed after failing on some databases and are safe to re-run from the start
 * (CREATE OR REPLACE / failed before creating anything else). A failed attempt of one of these is
 * marked as rolled back so `migrate deploy` applies the corrected version.
 *  - reporting_views: fx_factor referenced fx_rates without a schema, which fails on Supabase.
 */
const RETRYABLE = ["20261116135801_reporting_views"];

async function retryKnownFailures(db: PrismaClient) {
  let failed: { migration_name: string }[] = [];
  try {
    failed = await db.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
    );
  } catch {
    return; // fresh database: no migrations table yet
  }
  for (const { migration_name } of failed) {
    if (!RETRYABLE.includes(migration_name)) continue;
    console.log(`Retrying migration ${migration_name} (fixed version).`);
    run(`npx prisma migrate resolve --rolled-back ${migration_name}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!process.env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set (openssl rand -hex 32)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  await retryKnownFailures(db);
  run("npx prisma migrate deploy");
  const clients = await db.client.count();
  await db.$disconnect();
  if (clients === 0 && process.env.SEED_DEMO_ON_DEPLOY !== "0") {
    console.log("Empty database: seeding demo clients…");
    run("npm run db:seed", { SEED_DAYS: process.env.SEED_DAYS ?? "90" }); // 90 days keeps the first build short
  } else console.log(`Database has ${clients} client(s): skipping the demo seed.`);
  run("npx tsx scripts/ensure-owner.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
