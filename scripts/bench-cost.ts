import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BenchUsageError, parseBenchArgs, USAGE } from "./bench-cost/args";
import { assertBenchDatabase, assertSimulatedEnvironment, BenchRefusal, enforceSpendMode, installConsoleScrub, LocalPath, safeErrorText, scrubReport } from "./bench-cost/safety";

/**
 * `npx tsx scripts/bench-cost.ts [--runs 3] [--baseline both] [--out ./bench-cost-report] [--before-tier fast]`
 * `npx tsx scripts/bench-cost.ts --live --budget-usd 2 --runs 5 [--yes]`
 *
 * Cost per run of Foreman's deterministic steps against all-agent baselines, for one fixed job (the funding-tracker
 * example), in PAIRS on the same collected records:
 *   AFTER     the worker Foreman designs (collector + analyst agents, validate/dedupe/rank/stats/report in code)
 *   per-step  the same worker with each mechanical step done by its own model call
 *   merged    the same, with the record-cleaning steps merged into one model call
 * Each pair runs AFTER end to end, then every baseline from the records AFTER's collector returned, through the real
 * runtime; costs come from Foreman's own metering (Run.costUsd, ModelCall and ToolCall rows). The temporary workspace
 * is always deleted, on failure and on Ctrl+C too.
 *
 * Money: without --live, everything is Simulated ($0) whatever keys exist — see bench-cost/safety.ts for how that is
 * enforced (and re-checked once Foreman's modules have loaded), and for the caps on a --live run. Key values are
 * never printed.
 *
 * This file only parses flags and fixes the spend mode before importing Foreman's modules, so the first thing that
 * loads .env again (the Prisma client) finds the keys already blanked and leaves them blank.
 */

/** A second signal within this window is the same Ctrl+C delivered twice, not a request to hurry. */
const SIGNAL_DEBOUNCE_MS = 1_000;

/** .env the way the app loads it (existing variables win). dotenv is a dev dependency, absent from the runtime image. */
async function loadDotenv(): Promise<void> {
  try {
    (await import("dotenv")).config({ quiet: true });
  } catch {
    // Not installed: compose has already put .env into the environment.
  }
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseBenchArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof BenchUsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  await loadDotenv();
  let plan;
  try {
    plan = enforceSpendMode(args, process.env);
  } catch (e) {
    if (e instanceof BenchRefusal) {
      console.error(`Refusing to run: ${e.message}`);
      return 2;
    }
    throw e;
  }
  // Fail closed before any Foreman module (and so the Prisma client) loads: only a *_test database, no override.
  try {
    assertBenchDatabase(process.env.DATABASE_URL);
  } catch (e) {
    if (e instanceof BenchRefusal) {
      console.error(`Refusing to run: ${e.message}`);
      return 2;
    }
    throw e;
  }
  // From here on Foreman's modules (and Prisma, whose own warn/error log prints through console.log) are loaded:
  // nothing this process prints may name the database. App-wide logging is unchanged.
  const restoreConsole = installConsoleScrub(process.env.DATABASE_URL);
  console.log(plan.mode === "simulated" ? "Mode: SIMULATED — no provider is called and nothing is spent." : `Mode: LIVE — budget cap $${plan.budgetUsd.toFixed(2)}.`);

  const { runBenchmark, withCleanup } = await import("./bench-cost/run");
  const { renderMarkdown } = await import("./bench-cost/markdown");
  const { db } = await import("@/server/db");
  if (plan.mode === "simulated") {
    try {
      assertSimulatedEnvironment(process.env);
    } catch (e) {
      console.error(`Refusing to run: ${e instanceof Error ? e.message : String(e)}`);
      await db.$disconnect().catch(() => undefined);
      return 2;
    }
  }

  let stop = false;
  let stopAt = 0;
  let forced = false;
  const control: Parameters<typeof runBenchmark>[2] = { stopRequested: () => stop };
  const onSignal = (signal: NodeJS.Signals) => {
    if (!stop) {
      stop = true;
      stopAt = Date.now();
      console.log(`\n${signal}: cancelling the current run and cleaning up (press Ctrl+C again to clean up immediately)…`);
      void control.onCancel?.();
      return;
    }
    // One Ctrl+C can arrive twice (the terminal signals the whole process group and tsx relays it too).
    if (forced || Date.now() - stopAt < SIGNAL_DEBOUNCE_MS) return;
    forced = true;
    console.log("Cleaning up now…");
    void (control.onCleanup?.() ?? Promise.resolve(null)).then((result) => {
      if (result) console.log(result.note);
      process.exit(130);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const outcome = await runBenchmark(args, plan, control);
    if (outcome.kind === "declined") {
      console.log(outcome.cleanup.note);
      return outcome.cleanup.workspaceDeleted ? 0 : 1;
    }
    const cleanup = await control.onCleanup!();
    const report = scrubReport(withCleanup(outcome.report, cleanup));
    const markdown = renderMarkdown(report);
    const base = resolve(args.out);
    await mkdir(dirname(base), { recursive: true });
    await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(`${base}.md`, markdown);
    console.log(`\n${markdown}`);
    // The path comes from the cwd and --out: printed as a LocalPath so directory names are not taken for database parts.
    console.log("Report written to", new LocalPath(`${base}.json`), "and", new LocalPath(`${base}.md`));
    if (!cleanup.workspaceDeleted) {
      console.error(cleanup.note);
      return 1;
    }
    return stop ? 130 : 0;
  } catch (e) {
    const cleanup = await control.onCleanup?.();
    console.error(`Benchmark failed: ${safeErrorText(e)}`);
    if (cleanup) console.error(cleanup.note);
    return 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
    restoreConsole();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`Benchmark crashed: ${safeErrorText(e)}`);
    process.exit(1);
  },
);
