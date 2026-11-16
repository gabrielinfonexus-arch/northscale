import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

/** Refresh the reporting materialized views (also called by every sync job from phase 3 on). */
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
db.$executeRawUnsafe("SELECT refresh_reporting_views()")
  .then(() => console.log("Reporting views refreshed"))
  .finally(() => db.$disconnect());
