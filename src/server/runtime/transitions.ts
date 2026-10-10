import type { Prisma, RunStatus } from "@prisma/client";
import { db, type DbOrTx } from "@/server/db";
import { AppError, notFound } from "@/server/errors";
import { telemetry } from "@/server/telemetry";
import { canTransition, isTerminal } from "./types";

/**
 * The single door through which a Run changes status. Every transition is a guarded `updateMany` on the status
 * the caller observed (and optionally on `lockedBy`), so two writers can never both believe they moved the run.
 */

const LABEL: Record<RunStatus, string> = {
  QUEUED: "queued",
  RUNNING: "running",
  WAITING_FOR_APPROVAL: "waiting for approval",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

export const EXPIRED_APPROVAL_NOTE = "The run ended before this request was decided";
export const RUN_ENDED_CALL_NOTE = "The run ended before this call finished";
export const RUN_ENDED_UNRUN_NOTE = "The run ended before this call could run";

/**
 * A run that ends (or is cancelled) can leave nothing open behind it: PENDING approvals expire, their tool calls
 * are denied, tool calls still RUNNING fail, approved-but-never-executed ones are denied, and RunSteps still
 * RUNNING / WAITING / PENDING are skipped. Same rule for cancelRun, stale recovery and every terminal transition.
 */
export async function closeOpenWork(client: DbOrTx, runId: string, now: Date): Promise<void> {
  const pending = await client.approval.findMany({ where: { runId, status: "PENDING" }, select: { id: true, toolCallId: true, toolName: true } });
  if (pending.length > 0) {
    await client.approval.updateMany({
      where: { id: { in: pending.map((a) => a.id) } },
      data: { status: "EXPIRED", decidedAt: now, decisionNote: EXPIRED_APPROVAL_NOTE },
    });
    await client.toolCall.updateMany({
      where: { id: { in: pending.map((a) => a.toolCallId) }, status: { in: ["PENDING_APPROVAL", "APPROVED"] } },
      data: { status: "DENIED", error: EXPIRED_APPROVAL_NOTE, finishedAt: now },
    });
    // Recorded here rather than after the commit so every caller (cancel, retire, stale recovery, a terminal
    // slice) reports the expiry the same way; a rolled-back transaction leaves at most a spurious event behind.
    for (const a of pending) {
      telemetry.recordToolCallDecision({ runId, toolCallId: a.toolCallId, toolName: a.toolName, approvalId: a.id, outcome: "expired", source: "system", reason: "run_ended", at: now });
    }
  }
  // Calls a cancelled slice created but never finished (a batch is created up front and run one by one), and
  // gated calls whose run ended between the decision and the resume. A call that is executing right now keeps
  // its truthful outcome: the slice's own write lands after this one.
  await client.toolCall.updateMany({ where: { runId, status: "RUNNING" }, data: { status: "FAILED", error: RUN_ENDED_CALL_NOTE, finishedAt: now } });
  await client.toolCall.updateMany({
    where: { runId, status: { in: ["PENDING_APPROVAL", "APPROVED"] } },
    data: { status: "DENIED", error: RUN_ENDED_UNRUN_NOTE, finishedAt: now },
  });
  await client.runStep.updateMany({
    where: { runId, status: { in: ["RUNNING", "WAITING", "PENDING"] } },
    data: { status: "SKIPPED", finishedAt: now },
  });
}

export async function transitionRun(
  runId: string,
  to: RunStatus,
  patch: Prisma.RunUpdateManyMutationInput = {},
  opts: { expectLockedBy?: string; tx?: DbOrTx } = {},
): Promise<void> {
  const client = opts.tx ?? db;
  const run = await client.run.findUnique({ where: { id: runId }, select: { status: true } });
  if (!run) throw notFound("Run");
  if (!canTransition(run.status, to)) {
    throw new AppError("INVALID_TRANSITION", `A ${LABEL[run.status]} run cannot become ${LABEL[to]}`, { from: run.status, to });
  }

  const now = new Date();
  const data: Prisma.RunUpdateManyMutationInput = { ...patch, status: to };
  // Leaving RUNNING releases the executor lease, whatever the destination.
  if (run.status === "RUNNING" && to !== "RUNNING") {
    data.lockedBy = null;
    data.lockedAt = null;
    data.heartbeatAt = null;
  }
  if (isTerminal(to) && patch.finishedAt === undefined) data.finishedAt = now;

  const result = await client.run.updateMany({
    where: { id: runId, status: run.status, ...(opts.expectLockedBy ? { lockedBy: opts.expectLockedBy } : {}) },
    data,
  });
  if (result.count === 0) {
    throw new AppError("INVALID_TRANSITION", `The run changed while it was being moved to ${LABEL[to]}`, {
      from: run.status,
      to,
      expectLockedBy: opts.expectLockedBy,
    });
  }
  if (isTerminal(to)) await closeOpenWork(client, runId, now);
}
