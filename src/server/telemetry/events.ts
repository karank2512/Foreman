import { context, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { db } from "@/server/db";
import { logger } from "@/server/log";
import { findRunSpan, runKey, sanitizeAttributes, state } from "./state";
import { ATTR, EVENT_NAMES, SPAN_NAMES, type ResumedFromType, type RunSliceStart, type ToolCallDecisionArgs, type ToolInvocationRecord } from "./types";

/**
 * The recording API the runtime calls. Every function is a no-op while telemetry is disabled and never throws:
 * a tracing problem must not fail a run.
 *
 * Trace shape (docs/OTEL.md):
 *   invoke_agent                      one span per executeRun slice, gen_ai.agent.execution.id = runId
 *     ├─ gen_ai.agent.resumed         event, when the slice continues an earlier one (pause or checkpoint)
 *     ├─ execute_tool <tool>          child span per tool that actually ran, gen_ai.tool.call.id = ToolCall id
 *     ├─ gen_ai.tool.call.decision    event: require_approval (pause), deny (platform policy)
 *     ├─ gen_ai.agent.checkpointed    event per persisted restore point
 *     └─ gen_ai.agent.paused          event when the run stops for human approval
 *   tool_call_decision                standalone span carrying a decision made outside a slice (reviewer, cancel)
 */

const log = logger.child({ component: "telemetry" });

/**
 * Foreman has no checkpoint table; a restore point is identified by the run, the attempt that wrote it and the
 * step index the run had reached. A resumed slice recomputes the same id from the stored checkpoint.
 */
export function checkpointId(runId: string, attempt: number, stepIndex: number): string {
  return `${runId}:${attempt}:${stepIndex}`;
}

function guard(what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    log.debug(`telemetry.${what}_failed`, { err: e });
  }
}

/**
 * What the slice is continuing, if anything. A pending gated call with an Approval row means the run was paused
 * for a human (resumed_from = pause, id = the pause id emitted by `recordPaused`). Any other stored checkpoint is a
 * crash recovery or a retry (resumed_from = checkpoint). The attempt that wrote the checkpoint is recovered from
 * the step rows it had already written, so the id matches the `gen_ai.agent.checkpointed` event exactly.
 */
async function resolveResumedFrom(start: RunSliceStart): Promise<{ type: ResumedFromType; id: string } | null> {
  const cp = start.checkpoint;
  const fresh = cp.componentIndex === 0 && cp.nextStepIndex === 0 && cp.pendingToolCallIds.length === 0;
  if (fresh) return null;
  if (cp.pendingToolCallIds.length > 0) {
    const approval = await db.approval.findUnique({ where: { toolCallId: cp.pendingToolCallIds[0] }, select: { id: true } });
    if (approval) return { type: "pause", id: approval.id };
  }
  const steps = await db.runStep.aggregate({ where: { runId: start.runId, index: { lt: cp.nextStepIndex } }, _max: { attempt: true } });
  const savedAttempt = steps._max.attempt ?? Math.max(1, start.attempt - 1);
  return { type: "checkpoint", id: checkpointId(start.runId, savedAttempt, cp.nextStepIndex) };
}

/** Open the slice span. Awaited by the runtime, but resolves immediately when telemetry is off. */
export async function beginRunSlice(start: RunSliceStart): Promise<void> {
  const tracer = state.tracer;
  if (!state.enabled || !tracer) return;
  try {
    const resumedFrom = await resolveResumedFrom(start);
    const span = tracer.startSpan(SPAN_NAMES.INVOKE_AGENT, {
      kind: SpanKind.INTERNAL,
      attributes: sanitizeAttributes({
        [ATTR.OPERATION_NAME]: "invoke_agent",
        [ATTR.AGENT_ID]: start.workerId,
        [ATTR.AGENT_EXECUTION_ID]: start.runId,
        [ATTR.ORGANIZATION_ID]: start.organizationId,
        [ATTR.RUN_ATTEMPT]: start.attempt,
        [ATTR.RUN_SIMULATED]: start.simulated,
      }),
    });
    state.runs.set(runKey(start.runId, start.executorId), { runId: start.runId, executorId: start.executorId, span });
    if (resumedFrom) {
      span.addEvent(
        EVENT_NAMES.AGENT_RESUMED,
        sanitizeAttributes({
          [ATTR.AGENT_EXECUTION_ID]: start.runId,
          [ATTR.AGENT_RESUMED_FROM_TYPE]: resumedFrom.type,
          [ATTR.AGENT_RESUMED_FROM_ID]: resumedFrom.id,
        }),
      );
    }
  } catch (e) {
    log.debug("telemetry.begin_slice_failed", { err: e });
  }
}

/** Close the slice span. Idempotent: the runtime calls it on the normal path and again from its `finally`. */
export function endRunSlice(runId: string, executorId: string, outcome: { status: string }): void {
  guard("end_slice", () => {
    const key = runKey(runId, executorId);
    const entry = state.runs.get(key);
    if (!entry) return;
    state.runs.delete(key);
    entry.span.setAttribute(ATTR.RUN_STATUS, outcome.status);
    if (outcome.status === "FAILED") entry.span.setStatus({ code: SpanStatusCode.ERROR });
    entry.span.end();
  });
}

export function recordCheckpointed(runId: string, executorId: string, id: string): void {
  guard("checkpointed", () => {
    findRunSpan(runId, executorId)?.span.addEvent(
      EVENT_NAMES.AGENT_CHECKPOINTED,
      sanitizeAttributes({ [ATTR.AGENT_EXECUTION_ID]: runId, [ATTR.AGENT_CHECKPOINT_ID]: id }),
    );
  });
}

/** The run stopped for human approval. `pauseId` is the Approval id of the first gated call (see docs/OTEL.md). */
export function recordPaused(runId: string, executorId: string, pause: { pauseId: string; approvalCount: number }): void {
  guard("paused", () => {
    findRunSpan(runId, executorId)?.span.addEvent(
      EVENT_NAMES.AGENT_PAUSED,
      sanitizeAttributes({
        [ATTR.AGENT_EXECUTION_ID]: runId,
        [ATTR.AGENT_PAUSE_ID]: pause.pauseId,
        [ATTR.PAUSE_REASON]: "approval",
        [ATTR.PAUSE_APPROVAL_COUNT]: pause.approvalCount,
      }),
    );
  });
}

/**
 * A policy decision about one tool call (PR #535). Attached to the slice span when a slice of the run is executing
 * here (the pause itself, a platform denial, a cancel from inside the slice); otherwise — a reviewer deciding in
 * another request, a cancel from the UI — it gets a short span of its own, correlated by the execution id.
 */
export function recordToolCallDecision(args: ToolCallDecisionArgs): void {
  guard("decision", () => {
    const tracer = state.tracer;
    if (!state.enabled || !tracer) return;
    const at = args.at ?? new Date();
    const attributes = sanitizeAttributes({
      [ATTR.AGENT_EXECUTION_ID]: args.runId,
      [ATTR.TOOL_NAME]: args.toolName,
      [ATTR.TOOL_CALL_ID]: args.toolCallId,
      [ATTR.TOOL_CALL_DECISION_OUTCOME]: args.outcome,
      [ATTR.APPROVAL_ID]: args.approvalId,
      [ATTR.DECISION_SOURCE]: args.source,
      [ATTR.DECISION_ACTOR_ROLE]: args.actorRole,
      [ATTR.DECISION_REASON]: args.reason,
    });
    const entry = findRunSpan(args.runId, args.executorId);
    if (entry) {
      entry.span.addEvent(EVENT_NAMES.TOOL_CALL_DECISION, attributes, at);
      return;
    }
    const span = tracer.startSpan(SPAN_NAMES.TOOL_CALL_DECISION, {
      kind: SpanKind.INTERNAL,
      startTime: at,
      attributes: sanitizeAttributes({ [ATTR.AGENT_EXECUTION_ID]: args.runId, [ATTR.TOOL_NAME]: args.toolName, [ATTR.TOOL_CALL_ID]: args.toolCallId }),
    });
    span.addEvent(EVENT_NAMES.TOOL_CALL_DECISION, attributes, at);
    span.end(at);
  });
}

/**
 * What `tools.invoke` did with one call. Only an executed tool (ok or error) gets an `execute_tool` span, created
 * after the fact with the real start and end times so a gated, denied or invalid call never produces one. A denial
 * by the platform's own policy (grant revoked, call limit) is a `deny` decision; `require_approval` is recorded by
 * the pause, and a reviewer's `deny` by the decision itself, so neither is repeated here.
 */
export function recordToolInvocation(rec: ToolInvocationRecord): void {
  guard("tool_invocation", () => {
    const tracer = state.tracer;
    if (!state.enabled || !tracer) return;
    const { outcome } = rec;
    if (outcome.status === "denied") {
      recordToolCallDecision({ runId: rec.runId, executorId: rec.executorId, toolCallId: rec.toolCallId, toolName: rec.toolName, outcome: "deny", source: "policy", reason: outcome.reason, at: new Date(rec.endedAt) });
      return;
    }
    if (outcome.status !== "ok" && outcome.status !== "error") return;

    const parent = findRunSpan(rec.runId, rec.executorId);
    const attributes: Attributes = sanitizeAttributes({
      [ATTR.OPERATION_NAME]: "execute_tool",
      [ATTR.TOOL_NAME]: rec.toolName,
      [ATTR.TOOL_CALL_ID]: rec.toolCallId,
      [ATTR.TOOL_TYPE]: "function",
      [ATTR.AGENT_EXECUTION_ID]: rec.runId,
      [ATTR.RUN_SIMULATED]: outcome.status === "ok" ? outcome.simulated : undefined,
      [ATTR.ERROR_TYPE]: outcome.status === "error" ? "tool_error" : undefined,
    });
    const span: Span = tracer.startSpan(
      `${SPAN_NAMES.EXECUTE_TOOL} ${rec.toolName}`,
      { kind: SpanKind.INTERNAL, startTime: rec.startedAt, attributes },
      parent ? trace.setSpan(context.active(), parent.span) : undefined,
    );
    if (outcome.status === "error") span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(rec.endedAt);
  });
}
