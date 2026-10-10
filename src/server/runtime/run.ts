import { randomUUID } from "node:crypto";
import type { RunStatus } from "@prisma/client";
import { recordActivity } from "@/server/activity";
import { db } from "@/server/db";
import { refreshWorkerScore } from "@/server/evaluation";
import { conflict, notFound } from "@/server/errors";
import { telemetry } from "@/server/telemetry";
import { loadRunBundle } from "./context";
import { LockLost, publicRunError, RunFailure } from "./failure";
import { RunLock } from "./lock";
import { log } from "./log";
import { claimRun, CLAIM_SELECT } from "./queue";
import { RunSlice } from "./slice";
import { maxStepIndex } from "./steps";
import { transitionRun } from "./transitions";
import type { ExecuteOutcome } from "./types";

/**
 * Drive one run as far as it can go right now. The executor loop calls this with the run already claimed; tests
 * and inline execution call it on a QUEUED run and it claims the run itself. Anything else (finished, waiting,
 * held by another executor) returns the current state without side effects.
 */

const inlineExecutorId = () => `inline-${process.pid}-${randomUUID().slice(0, 8)}`;

async function outcomeFor(runId: string, status: RunStatus): Promise<ExecuteOutcome | null> {
  switch (status) {
    case "SUCCEEDED": {
      const deliverables = await db.deliverable.findMany({ where: { runId }, orderBy: { createdAt: "asc" }, select: { id: true } });
      return { status, deliverableIds: deliverables.map((d) => d.id) };
    }
    case "WAITING_FOR_APPROVAL": {
      const approvals = await db.approval.findMany({ where: { runId, status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { id: true } });
      return { status, approvalIds: approvals.map((a) => a.id) };
    }
    case "FAILED": {
      const run = await db.run.findUnique({ where: { id: runId }, select: { error: true } });
      return { status, error: run?.error ?? "Unknown error", willRetry: false };
    }
    case "CANCELLED":
      return { status };
    default:
      return null;
  }
}

/** A blueprint/spec that no longer parses: the run cannot even start, so it fails right away (no retry). */
async function failUnstartable(runId: string, executorId: string, failure: RunFailure): Promise<ExecuteOutcome> {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: { organizationId: true, workerId: true, jobId: true, worker: { select: { name: true } } },
  });
  if (!run) throw notFound("Run");
  // Redacted + clipped: this text is read by every member of the org (audit F-009).
  const message = publicRunError(failure.message);
  await transitionRun(runId, "FAILED", { error: message, finishedAt: new Date(), durationMs: 0 }, { expectLockedBy: executorId });
  log.warn(`run ${runId} could not start: ${failure.message}`);
  try {
    await refreshWorkerScore(run.workerId);
  } catch (e) {
    log.error(`could not refresh the score of worker ${run.workerId}`, e);
  }
  await recordActivity({
    organizationId: run.organizationId,
    type: "RUN_FAILED",
    title: `${run.worker.name} could not start a run`,
    detail: message,
    workerId: run.workerId,
    jobId: run.jobId,
    runId,
    actorType: "SYSTEM",
  });
  return { status: "FAILED", error: message, willRetry: false };
}

export async function executeRun(runId: string, opts: { executorId?: string } = {}): Promise<ExecuteOutcome> {
  const executorId = opts.executorId ?? inlineExecutorId();
  const current = await db.run.findUnique({ where: { id: runId }, select: { ...CLAIM_SELECT, status: true, lockedBy: true } });
  if (!current) throw notFound("Run");

  if (current.status === "QUEUED") {
    if (!(await claimRun(current, executorId))) {
      const after = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
      if (!after) throw notFound("Run");
      const outcome = await outcomeFor(runId, after.status);
      if (outcome) return outcome;
      throw conflict("The run was picked up by another executor");
    }
  } else if (current.status !== "RUNNING") {
    const outcome = await outcomeFor(runId, current.status);
    if (outcome) return outcome;
    throw conflict(`The run is ${current.status.toLowerCase()} and cannot be executed`);
  } else if (current.lockedBy !== executorId) {
    throw conflict("The run is being executed by another executor");
  }

  const lock = new RunLock(runId, executorId);
  lock.start();
  try {
    let bundle;
    try {
      bundle = await loadRunBundle(runId);
    } catch (e) {
      if (e instanceof RunFailure && !e.retryable) return await failUnstartable(runId, executorId, e);
      throw e;
    }
    const checkpoint = bundle.run.checkpoint;
    const nextStepIndex = Math.max(checkpoint.nextStepIndex, (await maxStepIndex(runId)) + 1);
    const slice = new RunSlice(bundle, lock, nextStepIndex);
    await lock.assertHeld();
    await slice.closeInterruptedWork();
    // The stored checkpoint (not the recomputed step index) tells telemetry what this slice is resuming from.
    await telemetry.beginRunSlice({
      runId,
      executorId,
      organizationId: bundle.run.organizationId,
      workerId: bundle.run.workerId,
      attempt: bundle.run.attempt,
      simulated: bundle.run.simulated,
      checkpoint: {
        componentIndex: checkpoint.componentIndex,
        nextStepIndex: checkpoint.nextStepIndex,
        pendingToolCallIds: checkpoint.agent?.pendingToolCalls.map((p) => p.toolCallId) ?? [],
      },
    });
    log.info(`run ${runId} slice started (attempt ${bundle.run.attempt}, component ${checkpoint.componentIndex}, step ${nextStepIndex})`);
    const outcome = await slice.drive();
    telemetry.endRunSlice(runId, executorId, { status: outcome.status });
    return outcome;
  } catch (e) {
    if (e instanceof LockLost) {
      // Someone else owns the run now (cancel, recovery, a second executor): report its state, write nothing.
      const after = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
      const outcome = after ? await outcomeFor(runId, after.status) : null;
      if (outcome) return outcome;
      throw conflict("The run was taken over by another executor");
    }
    throw e;
  } finally {
    // No-op when the slice already ended its span; closes it when drive() threw (lock lost, unexpected error).
    telemetry.endRunSlice(runId, executorId, { status: "INTERRUPTED" });
    lock.stop();
  }
}
