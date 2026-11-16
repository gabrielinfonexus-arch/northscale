import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { seedSyncHistory } from "../prisma/seed/demo";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
seedSyncHistory(db)
  .then((n) => console.log(`${n} demo sync jobs`))
  .finally(() => db.$disconnect());
