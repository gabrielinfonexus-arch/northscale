// Runs on every deploy (npm run vercel-build): applies migrations, and seeds the demo data once on an empty database.
import "dotenv/config";
import { execSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const run = (cmd: string) => execSync(cmd, { stdio: "inherit", env: process.env });

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!process.env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set (openssl rand -hex 32)");
  run("npx prisma migrate deploy");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const clients = await db.client.count();
  await db.$disconnect();
  if (clients === 0 && process.env.SEED_DEMO_ON_DEPLOY !== "0") {
    console.log("Empty database: seeding demo clients…");
    run("npm run db:seed");
  } else console.log(`Database has ${clients} client(s): skipping the demo seed.`);
  run("npx tsx scripts/ensure-owner.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
