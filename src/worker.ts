import { config } from "@/server/config";
import { db } from "@/server/db";
import { assertValidEnv, EnvError } from "@/server/env";
import { createLogger } from "@/server/log";
import { startExecutor, stopExecutor } from "@/server/runtime";
import { initTelemetry, shutdownTelemetry } from "@/server/telemetry";

/**
 * The standalone run executor (`npm run worker`, or `node dist/worker.mjs` in a container).
 *
 * In production the web tier runs with `EXECUTOR_MODE=off` and this process does all the work, so the two scale
 * independently and a long LLM run never competes with request handling for CPU or database connections. This
 * process always runs the executor — `EXECUTOR_MODE` only decides whether the *web* process does too.
 *
 * Shutdown is the part that matters operationally: on SIGTERM we stop claiming, give in-flight runs a bounded
 * grace period, and then hand their leases back to the queue without consuming a retry attempt. A deploy
 * therefore costs a few seconds of latency instead of half of every in-flight run's attempts.
 */

/** sysexits.h EX_CONFIG: the environment is wrong, restarting will not help. */
const EXIT_CONFIG = 78;
const EXIT_FATAL = 1;
/** Hard stop if a drain wedges, so an orchestrator never has to SIGKILL us. */
const FORCE_EXIT_SLACK_MS = 5_000;

const log = createLogger({ service: process.env.SERVICE_NAME ?? "worker", pid: process.pid });

/** The executor's timers are unref'd, so the process needs one ref'd handle to stay alive. */
let keepAlive: NodeJS.Timeout | undefined;
let stopping = false;

async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  const graceMs = config.executor.shutdownGraceMs;
  log.info("worker.stopping", { reason, graceMs });

  const forceExit = setTimeout(() => {
    log.error("worker.force_exit", { reason, graceMs });
    process.exit(code === 0 ? EXIT_FATAL : code);
  }, graceMs + FORCE_EXIT_SLACK_MS);
  forceExit.unref?.();

  let exitCode = code;
  try {
    await stopExecutor({ graceMs });
  } catch (e) {
    log.error("worker.stop_failed", { err: e });
    exitCode = EXIT_FATAL;
  }
  // After the executor: the last slices have ended their spans, so the flush carries them out.
  try {
    await shutdownTelemetry();
  } catch (e) {
    log.warn("worker.telemetry_shutdown_failed", { err: e });
  }
  try {
    await db.$disconnect();
  } catch (e) {
    log.warn("worker.disconnect_failed", { err: e });
  }

  if (keepAlive) clearInterval(keepAlive);
  clearTimeout(forceExit);
  log.info("worker.stopped", { reason, exitCode });
  process.exit(exitCode);
}

async function main(): Promise<void> {
  try {
    assertValidEnv();
  } catch (e) {
    const problems = e instanceof EnvError ? e.problems : [e instanceof Error ? e.message : String(e)];
    log.error("worker.invalid_environment", { problems });
    process.exit(EXIT_CONFIG);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error("worker.unhandled_rejection", { err: reason }));
  process.on("uncaughtException", (e) => {
    log.error("worker.uncaught_exception", { err: e });
    void shutdown("uncaughtException", EXIT_FATAL);
  });

  keepAlive = setInterval(() => {}, 60_000);

  // Opt-in OpenTelemetry export (OTEL_ENABLED=true, docs/OTEL.md). Before the executor, so the very first slice
  // is traced; a tracing problem is logged and the worker runs without it rather than not at all.
  let telemetryEnabled = false;
  try {
    telemetryEnabled = (await initTelemetry()).enabled;
  } catch (e) {
    log.error("worker.telemetry_failed", { err: e });
  }

  startExecutor();
  log.info("worker.started", {
    version: config.appVersion,
    nodeEnv: process.env.NODE_ENV ?? "development",
    concurrency: config.executor.concurrency,
    pollMs: config.executor.pollMs,
    shutdownGraceMs: config.executor.shutdownGraceMs,
    telemetry: telemetryEnabled,
  });
}

void main();
