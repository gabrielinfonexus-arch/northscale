import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

/**
 * Create a client from the command line (until the Clients page lands in phase 8).
 *   npm run client:create -- "Brand name" USD America/New_York [--demo]
 */
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--demo");
  const [name, currency = "USD", timezone = "America/New_York"] = args;
  if (!name) throw new Error('Usage: npm run client:create -- "Brand name" USD America/New_York [--demo]');
  const org = await db.organization.findFirstOrThrow();
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const c = await db.client.upsert({
    where: { slug },
    update: {},
    create: { organizationId: org.id, name, slug, currency, timezone, isDemo: process.argv.includes("--demo") },
  });
  console.log(`Client "${c.name}" → ?client=${c.slug}`);
}
main().finally(() => db.$disconnect());
