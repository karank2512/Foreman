/**
 * Demo seed for the self-hosted Docker stack (the `setup` service in docker-compose.yml). The Dockerfile bundles it
 * to dist/seed-demo.cjs, because the runtime image carries no TypeScript tooling.
 *
 * Unlike `npm run db:seed:demo`, which rebuilds the workspace from scratch every time, this only seeds when the demo
 * workspace is missing — `docker compose up` runs it on every start, and a restart must never wipe what someone did
 * in the demo. It is also best-effort: a failed seed is reported, but it never stops the app from starting.
 */
import { db } from "@/server/db";
import { DEMO_IDS, seedDemo } from "../prisma/seed/demo";
import { demoSeedRefusalReason } from "../prisma/seed/guard";

const isOn = (value: string | undefined) => value === "true" || value === "1";

async function main(): Promise<void> {
  if (!isOn(process.env.DEMO_MODE)) {
    console.log("Demo workspace: skipped (DEMO_MODE is off)");
    return;
  }
  const refusal = demoSeedRefusalReason();
  if (refusal) {
    console.error(refusal);
    return;
  }

  const existing = await db.organization.findUnique({ where: { id: DEMO_IDS.organizationId }, select: { id: true } });
  if (existing) {
    console.log("Demo workspace: already seeded");
    return;
  }

  const started = Date.now();
  await seedDemo(db);
  console.log(`Demo workspace: seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((e: unknown) => {
    console.error("Demo workspace: seeding failed — Foreman will still start, without the demo workspace.");
    console.error(e);
  })
  .finally(() => db.$disconnect());
