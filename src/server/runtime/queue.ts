import { Prisma, type RunTrigger } from "@prisma/client";
import { recordActivity } from "@/server/activity";
import { assertCan } from "@/server/auth/permissions";
import type { SessionContext } from "@/server/auth/types";
import { config } from "@/server/config";
import { db, toJson, type DbTx } from "@/server/db";
import { refreshWorkerScore } from "@/server/evaluation";
import { conflict, notFound } from "@/server/errors";
import { isOrgSimulated } from "@/server/models";
import { assertOrgActive, assertWithinBudget } from "@/server/security";
import { parseCheckpoint } from "./checkpoint";
import { WORKER_RETIRED_REASON } from "./failure";
import { log } from "./log";
import { sweepOrphanedRuns } from "./orphans";
import { closeOpenWork } from "./transitions";
import { RunInputSchema, type EnqueueRunArgs } from "./types";

/** Durable queue: enqueue, fair atomic claim, stale-lease recovery and manual retry. */

/** A run in one of these statuses still owes the org work (and can still spend money). */
export const IN_FLIGHT_STATUSES = ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"] as const;

const STALE_RETRY_MESSAGE = "The executor stopped responding mid-run; the run was re-queued";
const STALE_FINAL_MESSAGE = "The executor stopped responding mid-run and no attempts remain";

function queuedTitle(trigger: RunTrigger, name: string): string {
  switch (trigger) {
    case "MANUAL":
      return `${name} was asked to run now`;
    case "SCHEDULED":
      return `${name}’s scheduled run was queued`;
    case "RETRY":
      return `${name} was asked to try again`;
    case "CHAT":
      return `${name} was asked to run from a chat message`;
    case "HIRE":
      return `${name}’s first run was queued`;
  }
}

/**
 * Platform ceilings on waiting work, checked under the org's advisory lock so they cannot be raced past:
 * one worker may only have a few runs lined up (clicking "Run now" ten times queues three), and the whole
 * workspace is capped by `Organization.maxQueuedRuns` so no tenant can fill the shared queue.
 */
async function assertQueueCapacity(tx: DbTx, organizationId: string, worker: { id: string; name: string }): Promise<void> {
  const maxPerWorker = Math.max(1, config.limits.maxInFlightRunsPerWorker);
  const perWorker = await tx.run.count({ where: { organizationId, workerId: worker.id, status: { in: [...IN_FLIGHT_STATUSES] } } });
  if (perWorker >= maxPerWorker) {
    throw conflict(`${worker.name} already has ${maxPerWorker} run${maxPerWorker === 1 ? "" : "s"} lined up. Let those finish first.`);
  }
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { maxQueuedRuns: true } });
  const maxQueued = org?.maxQueuedRuns ?? 20;
  const perOrg = await tx.run.count({ where: { organizationId, status: { in: [...IN_FLIGHT_STATUSES] } } });
  if (perOrg >= maxQueued) {
    throw conflict(`Your workspace has ${perOrg} runs waiting or in progress — let some finish before starting another.`);
  }
}

export async function enqueueRun(args: EnqueueRunArgs): Promise<{ runId: string }> {
  const { organizationId, workerId } = args;
  const now = new Date();

  // Quotas first: a suspended or over-budget workspace queues nothing, whoever asked and whatever the trigger.
  await assertOrgActive(organizationId);
  await assertWithinBudget(organizationId);
  // The run's tools follow this flag. Model calls check the workspace themselves; the demo is always simulated.
  const simulated = await isOrgSimulated(organizationId);

  const created = await db.$transaction(async (tx) => {
    // Serialize every enqueue of this org so two clicks (or a click racing the scheduler) cannot both pass the
    // caps below. The lock is released when the transaction ends, successfully or not.
    // $executeRaw, not $queryRaw: the lock function returns void, which Prisma cannot deserialize as a column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;

    const worker = await tx.worker.findFirst({
      where: { id: workerId, organizationId },
      select: { id: true, name: true, jobId: true, status: true, currentVersionId: true, job: { select: { title: true } } },
    });
    if (!worker) throw notFound("Worker");
    if (worker.status !== "ACTIVE") throw conflict(`${worker.name} is ${worker.status.toLowerCase()} and cannot take on a run`);
    if (!worker.currentVersionId) throw conflict(`${worker.name} has no active version to run`);
    const version = await tx.workerVersion.findFirst({ where: { id: worker.currentVersionId, workerId: worker.id }, select: { id: true } });
    if (!version) throw conflict(`${worker.name} has no active version to run`);

    await assertQueueCapacity(tx, organizationId, worker);

    // First run locks the version forever (rule 5: WorkerVersions are immutable once lockedAt is set).
    await tx.workerVersion.updateMany({ where: { id: version.id, lockedAt: null }, data: { lockedAt: now } });

    const pendingInstructions = await tx.workerMessage.findMany({
      where: { organizationId, workerId: worker.id, classification: "TEMPORARY_INSTRUCTION", instructionActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, content: true },
    });
    // De-duplicated: a retry of a cancelled run carries its instructions AND gets them back from the messages.
    const instructions = [...(args.input?.instructions ?? []), ...pendingInstructions.map((m) => m.content.trim())].filter((s) => s.length > 0);
    const input = RunInputSchema.parse({ ...args.input, instructions: [...new Set(instructions)] });

    const run = await tx.run.create({
      data: {
        organizationId,
        jobId: worker.jobId,
        workerId: worker.id,
        workerVersionId: version.id,
        status: "QUEUED",
        trigger: args.trigger,
        input: toJson(input),
        simulated,
        requestedById: args.requestedById ?? null,
        availableAt: args.availableAt ?? now,
      },
      select: { id: true },
    });
    if (pendingInstructions.length > 0) {
      await tx.workerMessage.updateMany({
        where: { id: { in: pendingInstructions.map((m) => m.id) } },
        data: { instructionActive: false, appliedToRunId: run.id },
      });
    }
    return { runId: run.id, worker, instructions: input.instructions.length };
  });

  const requester = args.requestedById
    ? await db.user.findFirst({ where: { id: args.requestedById, organizationId }, select: { name: true } })
    : null;
  const details = [created.worker.job.title];
  if (created.instructions > 0) details.push(`${created.instructions} one-off instruction${created.instructions === 1 ? "" : "s"}`);
  await recordActivity({
    organizationId,
    type: "RUN_QUEUED",
    title: queuedTitle(args.trigger, created.worker.name),
    detail: details.join(" · "),
    workerId: created.worker.id,
    jobId: created.worker.jobId,
    runId: created.runId,
    actorType: requester ? "USER" : "SYSTEM",
    actorName: requester?.name,
  });
  return { runId: created.runId };
}

export interface ClaimCandidate {
  id: string;
  organizationId: string;
  workerId: string;
  jobId: string;
  startedAt: Date | null;
  worker: { name: string };
}

export const CLAIM_SELECT = {
  id: true,
  organizationId: true,
  workerId: true,
  jobId: true,
  startedAt: true,
  worker: { select: { name: true } },
} as const;

/** Only the very first start makes the feed; retries and approval resumes are continuations of the same run. */
async function recordRunStarted(run: ClaimCandidate): Promise<void> {
  await recordActivity({
    organizationId: run.organizationId,
    type: "RUN_STARTED",
    title: `${run.worker.name} started working`,
    workerId: run.workerId,
    jobId: run.jobId,
    runId: run.id,
    actorType: "WORKER",
    actorName: run.worker.name,
  });
}

/**
 * Guarded QUEUED → RUNNING for one run. Returns false when someone else moved it first. Shared by the executor's
 * claimNextRun and by executeRun's inline claim so both stamp the lease identically.
 */
export async function claimRun(run: ClaimCandidate, executorId: string): Promise<boolean> {
  const now = new Date();
  const result = await db.run.updateMany({
    where: { id: run.id, status: "QUEUED" },
    data: {
      status: "RUNNING",
      lockedBy: executorId,
      lockedAt: now,
      heartbeatAt: now,
      ...(run.startedAt ? {} : { startedAt: now }),
    },
  });
  if (result.count !== 1) return false;
  if (!run.startedAt) await recordRunStarted(run);
  return true;
}

/**
 * Fair, multi-tenant claim (audit INF-03). One raw SELECT picks the next run the executor is allowed to take:
 *  - the org is not suspended and is below its own `maxConcurrentRuns` RUNNING runs, so no tenant can hold the
 *    whole pool;
 *  - least-recently-served org first (oldest `max(startedAt)`, orgs that never ran first), then oldest run —
 *    an org that queues 10,000 runs can no longer starve everyone else;
 *  - `FOR UPDATE … SKIP LOCKED` hands concurrent executors different rows instead of making them queue.
 * The guarded QUEUED → RUNNING update runs in the same transaction, under that row lock.
 *
 * `opts.organizationId` (one org) and `opts.organizationIds` (a set of them) narrow the queue so tests can share
 * a database; the executor itself always claims unscoped.
 */
export async function claimNextRun(
  executorId: string,
  opts: { organizationId?: string; organizationIds?: string[] } = {},
): Promise<string | null> {
  // The row lock makes a lost race nearly impossible, but a run cancelled between select and update still leaves
  // count === 0 — loop so the executor moves on to the next candidate instead of idling a whole poll interval.
  const scope = opts.organizationIds ?? (opts.organizationId ? [opts.organizationId] : []);
  for (let attempt = 0; attempt < 25; attempt++) {
    const now = new Date();
    const orgFilter = scope.length > 0 ? Prisma.sql`AND r."organizationId" IN (${Prisma.join(scope)})` : Prisma.empty;
    const outcome = await db.$transaction(async (tx) => {
      const picked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT r."id"
        FROM "Run" r
        JOIN "Worker" w ON w."id" = r."workerId"
        JOIN "Organization" o ON o."id" = r."organizationId"
        WHERE r."status" = 'QUEUED'::"RunStatus"
          AND r."availableAt" <= ${now}
          AND w."status" = 'ACTIVE'::"WorkerStatus"
          AND o."suspendedAt" IS NULL
          ${orgFilter}
          AND (SELECT count(*) FROM "Run" x WHERE x."organizationId" = r."organizationId" AND x."status" = 'RUNNING'::"RunStatus") < o."maxConcurrentRuns"
        ORDER BY (SELECT max(y."startedAt") FROM "Run" y WHERE y."organizationId" = r."organizationId") ASC NULLS FIRST,
                 r."availableAt" ASC, r."createdAt" ASC
        LIMIT 1
        FOR UPDATE OF r SKIP LOCKED`;
      if (picked.length === 0) return null;
      const candidate = await tx.run.findFirst({ where: { id: picked[0].id }, select: CLAIM_SELECT });
      if (!candidate) return null;
      const claimedAt = new Date();
      const result = await tx.run.updateMany({
        where: { id: candidate.id, status: "QUEUED" },
        data: {
          status: "RUNNING",
          lockedBy: executorId,
          lockedAt: claimedAt,
          heartbeatAt: claimedAt,
          ...(candidate.startedAt ? {} : { startedAt: claimedAt }),
        },
      });
      return result.count === 1 ? candidate : undefined;
    });

    if (outcome === null) return null;
    if (outcome === undefined) continue;
    // After the commit: the feed must never mention a run whose claim rolled back.
    if (!outcome.startedAt) await recordRunStarted(outcome);
    return outcome.id;
  }
  return null;
}

/**
 * RUNNING runs whose heartbeat is older than staleLockMs belong to a dead executor. Each one is re-queued for its
 * next attempt (or failed when none remain) with a guard on the exact stale heartbeat, so a live executor that
 * heartbeats in between keeps its run.
 */
export async function recoverStaleRuns(opts: { organizationId?: string } = {}): Promise<number> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - config.executor.staleLockMs);
  const stale = await db.run.findMany({
    where: {
      status: "RUNNING",
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      OR: [
        { heartbeatAt: { lt: staleBefore } },
        { heartbeatAt: null, lockedAt: { lt: staleBefore } },
        { heartbeatAt: null, lockedAt: null, updatedAt: { lt: staleBefore } },
      ],
    },
    select: {
      id: true,
      organizationId: true,
      workerId: true,
      jobId: true,
      attempt: true,
      maxAttempts: true,
      heartbeatAt: true,
      checkpoint: true,
      worker: { select: { name: true, status: true } },
    },
  });

  let recovered = 0;
  for (const run of stale) {
    const guard = { id: run.id, status: "RUNNING" as const, heartbeatAt: run.heartbeatAt };
    if (run.worker.status === "RETIRED") {
      // Re-queueing would strand it: a retired worker's run is never claimed again.
      if (await cancelStale(run, guard, now)) recovered += 1;
      continue;
    }
    if (run.attempt < run.maxAttempts) {
      const result = await db.run.updateMany({
        where: guard,
        data: { status: "QUEUED", attempt: run.attempt + 1, availableAt: now, lockedBy: null, lockedAt: null, heartbeatAt: null, error: STALE_RETRY_MESSAGE },
      });
      if (result.count === 0) continue;
      recovered += 1;
      log.warn(`recovered stale run ${run.id} → QUEUED (attempt ${run.attempt + 1}/${run.maxAttempts})`);
      continue;
    }

    const activeMs = parseCheckpoint(run.checkpoint)?.counters.activeMs ?? 0;
    const result = await db.run.updateMany({
      where: guard,
      data: { status: "FAILED", error: STALE_FINAL_MESSAGE, finishedAt: now, durationMs: Math.round(activeMs), lockedBy: null, lockedAt: null, heartbeatAt: null },
    });
    if (result.count === 0) continue;
    recovered += 1;
    // Same tidy-up as every other terminal transition: nothing may look in flight on a finished run.
    await closeOpenWork(db, run.id, now);
    log.warn(`stale run ${run.id} failed: attempts exhausted`);
    try {
      await refreshWorkerScore(run.workerId);
    } catch (e) {
      log.error(`could not refresh the score of worker ${run.workerId}`, e);
    }
    await recordActivity({
      organizationId: run.organizationId,
      type: "RUN_FAILED",
      title: `${run.worker.name} could not finish a run`,
      detail: STALE_FINAL_MESSAGE,
      workerId: run.workerId,
      jobId: run.jobId,
      runId: run.id,
      actorType: "SYSTEM",
    });
  }
  return recovered + (await sweepOrphanedRuns(opts));
}

type StaleRun = { id: string; organizationId: string; workerId: string; jobId: string; checkpoint: unknown; worker: { name: string } };

async function cancelStale(run: StaleRun, guard: { id: string; status: "RUNNING"; heartbeatAt: Date | null }, now: Date): Promise<boolean> {
  const activeMs = parseCheckpoint(run.checkpoint)?.counters.activeMs ?? 0;
  const result = await db.run.updateMany({
    where: guard,
    data: { status: "CANCELLED", error: WORKER_RETIRED_REASON, finishedAt: now, durationMs: Math.round(activeMs), lockedBy: null, lockedAt: null, heartbeatAt: null },
  });
  if (result.count === 0) return false;
  await closeOpenWork(db, run.id, now);
  log.warn(`stale run ${run.id} cancelled: its worker was retired`);
  await recordActivity({
    organizationId: run.organizationId,
    type: "RUN_CANCELLED",
    title: `${run.worker.name}’s run was cancelled`,
    detail: WORKER_RETIRED_REASON,
    workerId: run.workerId,
    jobId: run.jobId,
    runId: run.id,
    actorType: "SYSTEM",
  });
  return true;
}

/** A fresh Run (trigger RETRY) for a FAILED or CANCELLED one, carrying the original input. */
export async function retryRun(s: SessionContext, runId: string): Promise<{ runId: string }> {
  assertCan(s, "workers.run");
  const run = await db.run.findFirst({
    where: { id: runId, organizationId: s.organizationId },
    select: { status: true, workerId: true, input: true },
  });
  if (!run) throw notFound("Run");
  if (run.status !== "FAILED" && run.status !== "CANCELLED") throw conflict("Only failed or cancelled runs can be retried");
  const input = RunInputSchema.safeParse(run.input);
  return enqueueRun({
    organizationId: s.organizationId,
    workerId: run.workerId,
    trigger: "RETRY",
    input: input.success ? input.data : undefined,
    requestedById: s.userId,
  });
}
