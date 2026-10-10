import type { Prisma, RunStepStatus, ToolCallStatus } from "@prisma/client";
import { recordActivity } from "@/server/activity";
import { db, toJson } from "@/server/db";
import type { AgentComponent } from "@/server/domain/blueprint";
import type { ChatMessage, ToolCallRequest } from "@/server/models/types";
import { telemetry } from "@/server/telemetry";
import { tools } from "@/server/tools";
import type { InvokeToolResult } from "@/server/tools/types";
import { DECLINED_MESSAGE } from "./approvals";
import { compact } from "./compact";
import { pauseForApproval, type ApprovalRequest } from "./pause";
import type { RunSlice } from "./slice";
import type { StepHandle } from "./steps";
import type { AgentCheckpoint, PendingToolCall } from "./types";

/**
 * Tool-call batches for one assistant turn. Rows first, then a checkpoint that names them, execution last, and
 * every outcome is written to the ToolCall row before the next call starts — that is what makes a resumed batch
 * idempotent: whether the slice paused for approval or the executor died mid-batch, the next slice resumes from
 * the checkpoint's pendingToolCalls and a call that already has an outcome is replayed from its row, never
 * executed (or billed) twice, and the model turn that asked for the batch is never repeated.
 */

export type BatchResult = { paused: false } | { paused: true; approvalIds: string[] };

const UNKNOWN_OUTCOME = "The outcome of this call is unknown: the executor restarted while it was running";

function toolMessage(call: PendingToolCall, output: unknown, isError = false): ChatMessage {
  return { role: "tool", toolCallId: call.callId, toolName: call.toolName, output, ...(isError ? { isError: true } : {}) };
}

function errorMessage(call: PendingToolCall, error: string): ChatMessage {
  return toolMessage(call, { error }, true);
}

/** Contract mapping: ok→SUCCEEDED · error/invalid_input→FAILED · denied/rejected→DENIED · approval_required→PENDING_APPROVAL. */
function statusFor(result: InvokeToolResult): ToolCallStatus {
  switch (result.status) {
    case "ok":
      return "SUCCEEDED";
    case "error":
    case "invalid_input":
      return "FAILED";
    case "denied":
    case "rejected":
      return "DENIED";
    case "approval_required":
      return "PENDING_APPROVAL";
  }
}

interface RowState {
  status: ToolCallStatus;
  output: unknown;
  error: string | null;
  latencyMs: number | null;
  step: StepHandle | null;
  /** The TOOL_CALL step still needs a final status (a replayed outcome must not rewrite a finished step). */
  stepOpen: boolean;
}

const OPEN_STEP_STATUSES: ReadonlySet<RunStepStatus> = new Set<RunStepStatus>(["PENDING", "RUNNING", "WAITING"]);

/**
 * Record a call's outcome on its row — only while the row is still RUNNING, so a slice that lost its run while
 * the tool was executing (a cancel, or a stale executor waking up after recovery) never overwrites what the run's
 * tidy-up or its new owner wrote. The exception is a completed external side effect: that it happened is a fact
 * the record must keep whatever else changed meanwhile.
 */
async function settleRow(call: PendingToolCall, data: Prisma.ToolCallUpdateManyMutationInput, sideEffectDone: boolean): Promise<void> {
  if (sideEffectDone) await db.toolCall.update({ where: { id: call.toolCallId }, data });
  else await db.toolCall.updateMany({ where: { id: call.toolCallId, status: "RUNNING" }, data });
}

async function readRow(call: PendingToolCall): Promise<RowState | null> {
  const row = await db.toolCall.findUnique({
    where: { id: call.toolCallId },
    select: { status: true, output: true, error: true, latencyMs: true, runStep: { select: { id: true, index: true, startedAt: true, status: true } } },
  });
  if (!row) return null;
  const step = row.runStep ? { id: row.runStep.id, index: row.runStep.index, startedAt: row.runStep.startedAt } : null;
  return { status: row.status, output: row.output, error: row.error, latencyMs: row.latencyMs, step, stepOpen: !!row.runStep && OPEN_STEP_STATUSES.has(row.runStep.status) };
}

/** New calls from a model turn: unknown tools get an error message, the rest get RunStep + ToolCall rows. */
export async function startToolBatch(slice: RunSlice, component: AgentComponent, agent: AgentCheckpoint, calls: ToolCallRequest[]): Promise<BatchResult> {
  const granted = new Set(component.tools);
  const allowed: ToolCallRequest[] = [];
  for (const call of calls) {
    if (granted.has(call.name)) allowed.push(call);
    else agent.messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, output: { error: `The tool "${call.name}" is not available to you in this role` }, isError: true });
  }

  if (allowed.length > 0) await slice.enforceLimits({ pendingToolCalls: allowed.length });
  for (const call of allowed) {
    const step = await slice.steps.begin({ kind: "TOOL_CALL", componentId: component.id, title: tools.describe(call.name, call.input).title, input: call.input });
    const row = await db.toolCall.create({
      data: {
        runId: slice.run.id,
        runStepId: step.id,
        workerId: slice.run.workerId,
        toolName: call.name,
        attempt: slice.run.attempt,
        callId: call.id,
        input: toJson(call.input),
        status: "RUNNING",
        simulated: slice.run.simulated,
      },
      select: { id: true },
    });
    agent.pendingToolCalls.push({ toolCallId: row.id, callId: call.id, toolName: call.name, input: call.input });
  }
  // Persist the assistant turn + its pending calls BEFORE anything executes: a crash from here on resumes
  // through resolvePending({ resumed: true }) instead of re-asking the model and re-running the whole batch.
  if (allowed.length > 0) await slice.saveCheckpoint();
  return resolvePending(slice, component, agent, { resumed: false });
}

/**
 * Drain `agent.pendingToolCalls` in order. On resume, rows that already carry an outcome are replayed; a call
 * that was RUNNING when the executor died is re-run only when it has no external side effect.
 */
export async function resolvePending(slice: RunSlice, component: AgentComponent, agent: AgentCheckpoint, opts: { resumed: boolean }): Promise<BatchResult> {
  const stillPending: PendingToolCall[] = [];
  const approvals: ApprovalRequest[] = [];

  for (const call of agent.pendingToolCalls) {
    const row = await readRow(call);
    if (!row) {
      agent.messages.push(errorMessage(call, "The record of this tool call is missing"));
      continue;
    }
    const step = row.step;

    if (opts.resumed) {
      if (row.status === "SUCCEEDED") {
        // The executor died between recording the outcome and closing the step: close it from the row.
        if (step && row.stepOpen) await slice.steps.finish(step, { status: "SUCCEEDED", output: compact(row.output), durationMs: row.latencyMs });
        agent.messages.push(toolMessage(call, row.output));
        continue;
      }
      if (row.status === "FAILED" || row.status === "DENIED") {
        const error = row.error ?? (row.status === "DENIED" ? DECLINED_MESSAGE : "The tool call failed");
        // The tool never ran in this slice (declined, expired or failed earlier): no duration to report.
        if (step && row.stepOpen) await slice.steps.finish(step, { status: "FAILED", error, durationMs: null });
        agent.messages.push(errorMessage(call, error));
        continue;
      }
      if (row.status === "RUNNING" && tools.get(call.toolName)?.sideEffect === "external_write") {
        await db.toolCall.update({ where: { id: call.toolCallId }, data: { status: "FAILED", error: UNKNOWN_OUTCOME, finishedAt: new Date() } });
        if (step && row.stepOpen) await slice.steps.finish(step, { status: "FAILED", error: UNKNOWN_OUTCOME, durationMs: null });
        agent.messages.push(errorMessage(call, "outcome unknown after restart"));
        continue;
      }
    }

    // A cancel (or any loss of the lease) must stop the batch BEFORE the next tool runs, not after it.
    await slice.lock.assertHeld();
    if (opts.resumed) {
      // APPROVED, PENDING_APPROVAL or a re-runnable RUNNING call: execute it now.
      await db.toolCall.update({ where: { id: call.toolCallId }, data: { status: "RUNNING" } });
      if (step) await db.runStep.update({ where: { id: step.id }, data: { status: "RUNNING", detail: null } });
    }

    const invokedAt = Date.now();
    const result = await tools.invoke({ toolName: call.toolName, input: call.input, ctx: slice.toolContext(), toolCallId: call.toolCallId });
    const status = statusFor(result);
    const now = new Date();
    // The step's duration is the call's own execution time: a batch runs its calls one after another and an
    // approval-gated call waits for a human between its step being created and the tool actually running.
    const durationMs = "latencyMs" in result ? result.latencyMs : now.getTime() - invokedAt;
    // Only the outcome kind travels to telemetry — never the input or the output.
    telemetry.recordToolInvocation({
      runId: slice.run.id,
      executorId: slice.lock.executorId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      outcome: result.status === "ok" ? { status: "ok", simulated: result.simulated } : result.status === "denied" ? { status: "denied", reason: result.reason } : { status: result.status },
      startedAt: invokedAt,
      endedAt: now.getTime(),
    });

    const external = tools.get(call.toolName)?.sideEffect === "external_write";

    if (result.status === "approval_required") {
      await settleRow(call, { status }, false);
      if (step) await db.runStep.update({ where: { id: step.id }, data: { status: "PENDING", detail: "Waiting for approval" } });
      stillPending.push(call);
      approvals.push({ call, approval: tools.describe(call.toolName, call.input).approval });
      continue;
    }

    if (result.status === "ok") {
      slice.cp.counters.toolCalls += 1;
      slice.cp.counters.costUsd += result.costUsd;
      await settleRow(
        call,
        { status, error: null, output: toJson(result.output), latencyMs: Math.round(result.latencyMs), costUsd: result.costUsd, simulated: result.simulated, finishedAt: now },
        external,
      );
      // Recorded before the (fenced) step write: a send that happened is in the feed even if the run was
      // cancelled while it was going out.
      if (external) {
        await recordActivity({
          organizationId: slice.run.organizationId,
          type: "TOOL_USED",
          title: `${slice.workerName}: ${tools.describe(call.toolName, call.input).title}`,
          workerId: slice.run.workerId,
          jobId: slice.run.jobId,
          runId: slice.run.id,
          actorType: "WORKER",
          actorName: slice.workerName,
          metadata: { toolName: call.toolName },
        });
      }
      if (step) await slice.steps.finish(step, { status: "SUCCEEDED", output: compact(result.output), detail: result.simulated ? "Simulated" : undefined, durationMs });
      agent.messages.push(toolMessage(call, result.output));
      continue;
    }

    const message = result.message;
    await settleRow(call, { status, error: message, finishedAt: now, ...(result.status === "error" ? { latencyMs: Math.round(result.latencyMs) } : {}) }, false);
    if (step) await slice.steps.finish(step, { status: "FAILED", error: message, durationMs });
    agent.messages.push(errorMessage(call, message));
  }

  agent.pendingToolCalls = stillPending;
  if (stillPending.length === 0) return { paused: false };
  const approvalIds = await pauseForApproval(slice, component, agent, approvals);
  return { paused: true, approvalIds };
}
