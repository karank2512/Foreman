import { recordActivity } from "@/server/activity";
import { db, toJson } from "@/server/db";
import { evaluateRun, PROVIDER_SETUP_FAILURE_MARKER, refreshWorkerScore } from "@/server/evaluation";
import { errorMessage } from "@/server/errors";
import { tools } from "@/server/tools";
import { parseCheckpoint } from "./checkpoint";
import { publicRunError, RunCancelled, RunFailure } from "./failure";
import { log } from "./log";
import type { RunSlice } from "./slice";
import type { AgentCheckpoint, ExecuteOutcome, RunOutput } from "./types";

/** Terminal transitions of a slice: success (with evaluation), failure (retry with backoff, or final), cancel. */

const RETRY_BACKOFF_MS = 15_000;
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export async function finishSuccess(slice: RunSlice): Promise<ExecuteOutcome> {
  const { run } = slice;
  const deliverables = await db.deliverable.findMany({
    where: { runId: run.id, organizationId: run.organizationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, data: true },
  });
  if (deliverables.length === 0) {
    // The blueprint schema guarantees the content key is produced, so this means a component emitted nothing.
    throw new RunFailure("VALIDATION", `No deliverable was produced: the context key "${slice.blueprint.deliverable.contentKey}" is empty`, false);
  }
  const [first] = deliverables;
  const records = Array.isArray(first.data) ? first.data.length : null;

  const [steps, modelCalls, toolCalls, costRow] = await Promise.all([
    db.runStep.count({ where: { runId: run.id } }),
    db.modelCall.count({ where: { runId: run.id } }),
    db.toolCall.count({ where: { runId: run.id } }),
    db.run.findUnique({ where: { id: run.id }, select: { costUsd: true } }),
  ]);
  const output: RunOutput = {
    summary: `Produced “${first.title}”${records !== null ? ` (${plural(records, "record")})` : ""} in ${plural(steps, "step")}`,
    deliverableIds: deliverables.map((d) => d.id),
    stats: { steps, modelCalls, toolCalls },
  };
  const checkpoint = slice.snapshot();
  const activeMs = checkpoint.counters.activeMs;
  await slice.lock.transition("SUCCEEDED", { output: toJson(output), checkpoint: toJson(checkpoint), durationMs: activeMs, finishedAt: new Date(), error: null });
  log.info(`run ${run.id} succeeded: ${output.summary}`);

  // Evaluation never fails a run that already succeeded; its step records what happened either way. It runs
  // after the terminal transition (the lease is released), so it is the one step finished without the fence.
  const evalStep = await slice.steps.begin({ kind: "EVALUATION", title: "Evaluating the deliverable", input: { deliverableId: first.id } });
  try {
    const result = await evaluateRun(run.id);
    const parts: string[] = [];
    if (result.deterministic) parts.push(`Checks ${Math.round(result.deterministic.score * 100)}/100`);
    if (result.judge) parts.push(`Reviewer ${Math.round(result.judge.score * 100)}/100`);
    await slice.steps.finishAfterRelease(evalStep, {
      status: "SUCCEEDED",
      detail: parts.join(" · ") || "Nothing to evaluate",
      output: { deterministic: result.deterministic?.score ?? null, judge: result.judge?.score ?? null },
    });
  } catch (e) {
    log.error(`evaluation of run ${run.id} failed`, e);
    await slice.steps.finishAfterRelease(evalStep, { status: "FAILED", error: errorMessage(e) });
  }

  await db.worker.updateMany({ where: { id: run.workerId, organizationId: run.organizationId }, data: { lastRunAt: new Date() } });
  const detail = [`Delivered “${first.title}”`];
  if (records !== null) detail.push(plural(records, "record"));
  detail.push(plural(steps, "step"), usd(Number(costRow?.costUsd ?? 0)));
  await recordActivity({
    organizationId: run.organizationId,
    type: "RUN_SUCCEEDED",
    title: `${slice.workerName} finished a run`,
    detail: detail.join(" · "),
    workerId: run.workerId,
    jobId: run.jobId,
    runId: run.id,
    actorType: "WORKER",
    actorName: slice.workerName,
    metadata: { deliverableId: first.id },
  });
  return { status: "SUCCEEDED", deliverableIds: output.deliverableIds };
}

/** The run ends here as CANCELLED (e.g. its worker was retired mid-run); same tidy-up as cancelRun. */
export async function finishCancelled(slice: RunSlice, reason: string): Promise<ExecuteOutcome> {
  const { run } = slice;
  const checkpoint = slice.snapshot();
  await slice.lock.transition("CANCELLED", { error: reason, checkpoint: toJson(checkpoint), durationMs: checkpoint.counters.activeMs, finishedAt: new Date() });
  log.warn(`run ${run.id} cancelled: ${reason}`);
  await recordActivity({
    organizationId: run.organizationId,
    type: "RUN_CANCELLED",
    title: `${slice.workerName}’s run was cancelled`,
    detail: reason,
    workerId: run.workerId,
    jobId: run.jobId,
    runId: run.id,
    actorType: "SYSTEM",
  });
  return { status: "CANCELLED" };
}

const EXTERNAL_WRITE_TOOLS = () =>
  tools
    .list()
    .filter((t) => t.sideEffect === "external_write")
    .map((t) => t.name);

/**
 * The conversation a retry must continue instead of restarting the component: once an agent has changed the
 * outside world (a notification went out), starting it from scratch would ask to do it again — a second approval
 * for a message that was already delivered. The persisted agent checkpoint is used (never the in-memory one,
 * which may be mid-batch): it either contains the side effect's result or still lists the call as pending, which
 * the resume replays from its SUCCEEDED row.
 */
async function agentToKeep(slice: RunSlice, componentId: string): Promise<AgentCheckpoint | undefined> {
  const component = slice.blueprint.components.find((c) => c.id === componentId);
  if (!component || component.type !== "agent") return undefined;
  const names = EXTERNAL_WRITE_TOOLS().filter((n) => component.tools.includes(n));
  if (names.length === 0) return undefined;
  const sent = await db.toolCall.findFirst({
    where: { runId: slice.run.id, status: "SUCCEEDED", toolName: { in: names }, runStep: { componentId } },
    select: { id: true },
  });
  if (!sent) return undefined;
  const row = await db.run.findUnique({ where: { id: slice.run.id }, select: { checkpoint: true } });
  const agent = parseCheckpoint(row?.checkpoint)?.agent;
  return agent?.componentId === componentId ? agent : undefined;
}

export async function finishFailure(slice: RunSlice, failure: RunFailure): Promise<ExecuteOutcome> {
  const { run, cp } = slice;
  // Everything a member can read about the failure is redacted and clipped; the raw text stays in the log.
  const message = publicRunError(failure.message);
  await slice.steps.record({
    kind: "ERROR",
    title: message,
    status: "FAILED",
    error: message,
    componentId: slice.blueprint.components[slice.componentStart.index]?.id,
    output: {
      code: failure.code,
      retryable: failure.retryable,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      // Read by evaluation/score.ts: a provider-setup failure is not held against the worker.
      ...(failure.providerSetup ? { [PROVIDER_SETUP_FAILURE_MARKER]: true } : {}),
    },
  });

  const willRetry = failure.retryable && run.attempt < run.maxAttempts;
  if (willRetry) {
    // A retired worker's re-queued run would never be claimed again.
    try {
      await slice.assertWorkerNotRetired();
    } catch (e) {
      if (e instanceof RunCancelled) return await finishCancelled(slice, e.reason);
      throw e;
    }
    // Restart the failed component from its own beginning (the step index keeps counting up) — unless it
    // already had an external side effect, in which case the retry continues its conversation after it.
    const failedComponentId = slice.blueprint.components[slice.componentStart.index]?.id;
    const kept = failedComponentId ? await agentToKeep(slice, failedComponentId) : undefined;
    cp.componentIndex = slice.componentStart.index;
    cp.context = slice.componentStart.context;
    cp.agent = kept;
    if (kept) log.info(`run ${run.id}: ${failedComponentId} already had an external side effect; the retry resumes its conversation`);
    await slice.lock.transition("QUEUED", {
      attempt: run.attempt + 1,
      availableAt: new Date(Date.now() + RETRY_BACKOFF_MS * run.attempt),
      error: message,
      checkpoint: toJson(slice.snapshot()),
    });
    log.warn(`run ${run.id} failed on attempt ${run.attempt}/${run.maxAttempts}, retrying: ${failure.message}`);
    return { status: "FAILED", error: message, willRetry: true };
  }

  const checkpoint = slice.snapshot();
  await slice.lock.transition("FAILED", { error: message, checkpoint: toJson(checkpoint), durationMs: checkpoint.counters.activeMs, finishedAt: new Date() });
  log.warn(`run ${run.id} failed (${failure.code}): ${failure.message}`);
  try {
    await refreshWorkerScore(run.workerId);
  } catch (e) {
    log.error(`could not refresh the score of worker ${run.workerId}`, e);
  }
  await recordActivity({
    organizationId: run.organizationId,
    type: "RUN_FAILED",
    title: `${slice.workerName} could not finish a run`,
    detail: message,
    workerId: run.workerId,
    jobId: run.jobId,
    runId: run.id,
    actorType: "WORKER",
    actorName: slice.workerName,
  });
  return { status: "FAILED", error: message, willRetry: false };
}
