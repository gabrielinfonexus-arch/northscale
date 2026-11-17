// Run the Watchdog for every client (or one slug) from the command line: npm run watchdog [-- <slug>]
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { runWatchdog } from "../src/server/watchdog/run";

async function main() {
  const slug = process.argv[2];
  const clients = await prisma.client.findMany({ where: { archivedAt: null, ...(slug ? { slug } : {}) } });
  for (const c of clients) console.log(c.slug, await runWatchdog(c.id));
  await prisma.$disconnect();
}
main();
