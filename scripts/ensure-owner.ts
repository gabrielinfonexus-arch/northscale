// Makes sure the organization has an Owner who can sign in.
//  - OWNER_EMAIL: the Owner's email (renames the seeded owner@northscale.local the first time).
//  - OWNER_PASSWORD: sets the Owner's password if none is set yet (or always, with OWNER_PASSWORD_RESET=1).
//  - Local development without OWNER_PASSWORD: sets the password "northscale-dev" and prints it.
// Runs after `npm run db:seed` and on every deploy (scripts/deploy-setup.ts). Idempotent.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/server/password-core";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const DEV_PASSWORD = "northscale-dev";

async function main() {
  const prod = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
  const wantedEmail = process.env.OWNER_EMAIL?.trim().toLowerCase() || null;
  let org = await db.organization.findFirst({ orderBy: { createdAt: "asc" } });
  if (!org) {
    org = await db.organization.create({ data: { name: "NorthScale" } });
    await db.orgSetting.create({ data: { organizationId: org.id, demoData: true } });
  }
  let m = await db.membership.findFirst({
    where: { organizationId: org.id, role: "OWNER" },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });
  if (!m) {
    const email = wantedEmail ?? "owner@northscale.local";
    const user = await db.user.upsert({ where: { email }, update: {}, create: { email, name: "Owner" } });
    await db.membership.create({ data: { userId: user.id, organizationId: org.id, role: "OWNER" } });
    m = await db.membership.findFirstOrThrow({ where: { organizationId: org.id, role: "OWNER" }, include: { user: true } });
  }
  let user = m.user;
  if (wantedEmail && user.email !== wantedEmail && user.email === "owner@northscale.local") {
    const taken = await db.user.findUnique({ where: { email: wantedEmail } });
    if (!taken) user = await db.user.update({ where: { id: user.id }, data: { email: wantedEmail } });
  }

  const pw = process.env.OWNER_PASSWORD;
  if (pw && (!user.passwordHash || process.env.OWNER_PASSWORD_RESET === "1")) {
    if (pw.length < 10) throw new Error("OWNER_PASSWORD must have at least 10 characters.");
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(pw) } });
    console.log(`Owner ${user.email}: password set from OWNER_PASSWORD.`);
  } else if (!user.passwordHash && !prod) {
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(DEV_PASSWORD) } });
    console.log(`Owner ${user.email}: local development password is "${DEV_PASSWORD}".`);
  } else if (!user.passwordHash) {
    console.warn(`Owner ${user.email} has no password yet: set OWNER_EMAIL and OWNER_PASSWORD and redeploy.`);
  } else console.log(`Owner ${user.email}: password already set.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
