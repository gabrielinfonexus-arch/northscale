import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { seedDemo } from "./demo";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

async function main() {
  const t0 = Date.now();
  let org = await db.organization.findFirst();
  if (!org) org = await db.organization.create({ data: { name: "NorthScale" } });
  await db.orgSetting.upsert({ where: { organizationId: org.id }, update: {}, create: { organizationId: org.id, demoData: true } });

  const owner = await db.user.upsert({
    where: { email: "owner@northscale.local" },
    update: {},
    create: { email: "owner@northscale.local", name: "NorthScale Owner" },
  });
  await db.membership.upsert({
    where: { userId_organizationId: { userId: owner.id, organizationId: org.id } },
    update: { role: "OWNER" },
    create: { userId: owner.id, organizationId: org.id, role: "OWNER" },
  });

  const summary = await seedDemo(db, org.id, { days: Number(process.env.SEED_DAYS ?? 180) });
  for (const s of summary) console.log("  •", s);
  console.log(`Seed done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
