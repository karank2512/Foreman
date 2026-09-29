import "dotenv/config";
import { db } from "@/server/db";
import { seedDemo } from "./seed/demo";
import { demoSeedRefusalReason } from "./seed/guard";

/**
 * `npm run db:seed:demo` — rebuilds the Acme Robotics demo workspace (idempotent; see prisma/seed/demo.ts).
 * Only runs when executed directly, so tests can import `seedDemo` without side effects.
 *
 * Deployments run `npm run setup` (migrations only). The demo seed is never part of a release path: it writes a
 * workspace whose password is in the docs, so it refuses to touch a production database unless ALLOW_DEMO_SEED is
 * explicitly set (audit OPS-14).
 */

export { seedDemo } from "./seed/demo";
export { demoSeedRefusalReason } from "./seed/guard";

async function main(): Promise<void> {
  const refusal = demoSeedRefusalReason();
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  const verbose = process.argv.includes("--verbose");
  const summary = await seedDemo(db, { log: verbose ? (line) => console.log(line) : undefined });
  console.log(`Seeded the demo workspace in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  organization ${summary.organizationId} · workers Alex, Maya, Sam · pending approval ${summary.pendingApprovalId}`);
  console.log("  sign in as demo@foreman.example / demo1234");
}

const invokedDirectly = /(^|[\\/])seed\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main()
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
