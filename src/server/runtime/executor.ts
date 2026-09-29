import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { logger } from "@/server/log";
import { clearHeartbeat, recordHeartbeat, runMaintenance } from "@/server/maintenance";
import { claimNextRun, recoverStaleRuns } from "./queue";
import { executeRun } from "./run";
import { tickScheduler } from "./scheduler";

/**
 * The executor: a polling loop that claims QUEUED runs and executes them, plus periodic stale-lock recovery,
 * scheduler ticks and housekeeping. It runs either inside the web process (`EXECUTOR_MODE=inline`, local dev) or
 * as the standalone `src/worker.ts` process (production). It shares NO memory with request handlers: every
 * decision is made from the database, so any number of executors on any number of hosts is safe.
 *
 * The registry lives on globalThis so a dev-server reload replaces the previous loop instead of stacking a second.
 */

/** Housekeeping cadence (rate-limit buckets, retention, stale heartbeats). Cheap and idempotent. */
const MAINTENANCE_INTERVAL_MS = 10 * 60_000;
/** Spread the first sweep of each process out a little so a fleet restart does not sweep in lockstep. */
const MAINTENANCE_INITIAL_DELAY_MS = 30_000 + (process.pid % 30) * 1_000;
/** A heartbeat every tick would be one write per poll; the staleness window is minutes, so throttle it. */
const HEARTBEAT_MIN_INTERVAL_MS = 5_000;
/** Cap on how long `stop` waits for an in-flight maintenance sweep before disconnecting. */
const MAINTENANCE_DRAIN_MS = 2_000;

const log = logger.child({ component: "executor" });

interface ExecutorRegistry {
  generation: number;
  stop: (graceMs: number) => Promise<void>;
}

const registry = globalThis as unknown as { __foremanExecutor?: ExecutorRegistry };

function sleeper() {
  let wake: (() => void) | undefined;
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    wake: () => wake?.(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function startExecutor(): void {
  const previous = registry.__foremanExecutor;
  if (previous) void previous.stop(config.executor.shutdownGraceMs);
  const generation = (previous?.generation ?? 0) + 1;
  const host = hostname();
  const executorId = `${host}-${process.pid}-g${generation}-${randomUUID().slice(0, 6)}`;
  const runLog = log.child({ executorId });

  let running = true;
  /** runId → the task executing it, so a shutdown knows exactly which leases to hand back. */
  const inFlight = new Map<string, Promise<void>>();
  const { sleep, wake } = sleeper();
  let lastRecovery = 0;
  let lastSchedule = 0;
  let lastHeartbeat = 0;
  let lastMaintenance = Date.now() - MAINTENANCE_INTERVAL_MS + MAINTENANCE_INITIAL_DELAY_MS;
  let maintenanceTask: Promise<unknown> | null = null;

  const launch = (runId: string) => {
    const task: Promise<void> = executeRun(runId, { executorId })
      .then((outcome) => runLog.info("run.finished", { runId, status: outcome.status }))
      .catch((e: unknown) => runLog.error("run.crashed", { runId, err: e }))
      .finally(() => inFlight.delete(runId));
    inFlight.set(runId, task);
  };

  /**
   * Give a lease back to the queue *without* consuming an attempt (audit OPS-02). The guard means we only ever
   * touch a run this executor still owns; a slice that is still mid-flight loses its lock and stops at its next
   * fenced write, and the next executor's recovery tidies the open step.
   */
  const handBack = async (runId: string): Promise<void> => {
    try {
      const { count } = await db.run.updateMany({
        where: { id: runId, status: "RUNNING", lockedBy: executorId },
        data: { status: "QUEUED", availableAt: new Date(), lockedBy: null, lockedAt: null, heartbeatAt: null },
      });
      if (count > 0) runLog.warn("run.handed_back", { runId });
    } catch (e) {
      runLog.error("run.hand_back_failed", { runId, err: e });
    }
  };

  const heartbeat = async (now: number): Promise<void> => {
    if (now - lastHeartbeat < HEARTBEAT_MIN_INTERVAL_MS) return;
    lastHeartbeat = now;
    try {
      await recordHeartbeat(executorId, host, inFlight.size);
    } catch (e) {
      runLog.error("heartbeat.failed", { err: e });
    }
  };

  const tick = async () => {
    const now = Date.now();
    await heartbeat(now);

    if (now - lastRecovery >= config.executor.staleLockMs / 2) {
      lastRecovery = now;
      try {
        const n = await recoverStaleRuns();
        if (n > 0) runLog.warn("runs.recovered", { count: n });
      } catch (e) {
        runLog.error("recovery.failed", { err: e });
      }
    }

    if (now - lastSchedule >= config.executor.schedulerTickMs) {
      lastSchedule = now;
      try {
        const n = await tickScheduler();
        if (n > 0) runLog.info("scheduler.queued", { count: n });
      } catch (e) {
        runLog.error("scheduler.failed", { err: e });
      }
    }

    // Detached: a retention pass must never delay claiming the next run.
    if (!maintenanceTask && now - lastMaintenance >= MAINTENANCE_INTERVAL_MS) {
      lastMaintenance = now;
      maintenanceTask = runMaintenance().finally(() => {
        maintenanceTask = null;
      });
    }

    while (running && inFlight.size < Math.max(1, config.executor.concurrency)) {
      const runId = await claimNextRun(executorId);
      if (!runId) break;
      runLog.info("run.claimed", { runId });
      launch(runId);
    }
  };

  const loop = (async () => {
    runLog.info("executor.started", {
      hostname: host,
      concurrency: config.executor.concurrency,
      pollMs: config.executor.pollMs,
    });
    while (running) {
      try {
        await tick();
      } catch (e) {
        runLog.error("poll.failed", { err: e });
      }
      if (running) await sleep(config.executor.pollMs);
    }
  })();

  /**
   * Shutdown: stop claiming, give in-flight runs `graceMs` to finish on their own, then hand back whatever is
   * left. A container's termination grace period is measured in seconds while a run can take minutes, so waiting
   * for completion would guarantee a SIGKILL — and a SIGKILLed run is only recovered after `staleLockMs`, at the
   * cost of one of its two attempts.
   */
  const stop = async (graceMs: number): Promise<void> => {
    running = false;
    wake();
    await loop;

    if (inFlight.size > 0) {
      runLog.info("executor.draining", { inFlight: inFlight.size, graceMs });
      await Promise.race([Promise.allSettled([...inFlight.values()]), delay(Math.max(0, graceMs))]);
    }
    for (const runId of [...inFlight.keys()]) await handBack(runId);
    if (maintenanceTask) await Promise.race([maintenanceTask, delay(MAINTENANCE_DRAIN_MS)]);

    try {
      await clearHeartbeat(executorId);
    } catch (e) {
      runLog.error("heartbeat.clear_failed", { err: e });
    }
    runLog.info("executor.stopped");
  };

  registry.__foremanExecutor = { generation, stop };
}

/**
 * Stops the polling loop, drains for at most `graceMs` (default `config.executor.shutdownGraceMs`), and returns
 * every still-running lease to the queue without burning a retry attempt.
 */
export async function stopExecutor(opts: { graceMs?: number } = {}): Promise<void> {
  const current = registry.__foremanExecutor;
  if (!current) return;
  registry.__foremanExecutor = undefined;
  await current.stop(opts.graceMs ?? config.executor.shutdownGraceMs);
}
