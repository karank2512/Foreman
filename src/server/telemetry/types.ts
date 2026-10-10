/**
 * Telemetry contract: the span names, event names and attribute keys Foreman emits, and the allowlist every
 * attribute is filtered through before it can reach an exporter.
 *
 * Event and attribute names follow two proposals to the OpenTelemetry GenAI semantic conventions and are used
 * verbatim so the traces can serve as evidence upstream (docs/OTEL.md):
 *   - open-telemetry/semantic-conventions-genai#535 — the `gen_ai.tool.call.decision` event with
 *     `gen_ai.tool.call.decision.outcome` ∈ require_approval | allow | deny | expired.
 *   - open-telemetry/semantic-conventions-genai#445 — `gen_ai.agent.paused`, `gen_ai.agent.checkpointed` and
 *     `gen_ai.agent.resumed` with `gen_ai.agent.execution.id`, `gen_ai.agent.pause.id`,
 *     `gen_ai.agent.checkpoint.id`, `gen_ai.agent.resumed_from.type` and `gen_ai.agent.resumed_from.id`.
 * Everything under `foreman.*` is a Foreman-specific addition.
 *
 * What is deliberately NOT here: prompts, tool inputs or outputs, deliverable text, worker persona names, user
 * names or emails, approval titles/notes. Actors appear as a role only. Ids are opaque database ids.
 */

export const SPAN_NAMES = {
  /** One per executeRun slice: from claim to pause, finish or interruption. */
  INVOKE_AGENT: "invoke_agent",
  /** One per tool that actually ran (never for a gated, denied or invalid call). Suffixed with the tool name. */
  EXECUTE_TOOL: "execute_tool",
  /** Carrier for a decision made while no slice of the run is executing in this process (a reviewer, a cancel). */
  TOOL_CALL_DECISION: "tool_call_decision",
} as const;

export const EVENT_NAMES = {
  TOOL_CALL_DECISION: "gen_ai.tool.call.decision",
  AGENT_PAUSED: "gen_ai.agent.paused",
  AGENT_CHECKPOINTED: "gen_ai.agent.checkpointed",
  AGENT_RESUMED: "gen_ai.agent.resumed",
} as const;

export const ATTR = {
  // GenAI semantic conventions (stable) ────────────────────────────────────────────────────────────────────
  OPERATION_NAME: "gen_ai.operation.name",
  AGENT_ID: "gen_ai.agent.id",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_TYPE: "gen_ai.tool.type",
  // PR #535 ────────────────────────────────────────────────────────────────────────────────────────────────
  TOOL_CALL_DECISION_OUTCOME: "gen_ai.tool.call.decision.outcome",
  // PR #445 ────────────────────────────────────────────────────────────────────────────────────────────────
  AGENT_EXECUTION_ID: "gen_ai.agent.execution.id",
  AGENT_PAUSE_ID: "gen_ai.agent.pause.id",
  AGENT_CHECKPOINT_ID: "gen_ai.agent.checkpoint.id",
  AGENT_RESUMED_FROM_TYPE: "gen_ai.agent.resumed_from.type",
  AGENT_RESUMED_FROM_ID: "gen_ai.agent.resumed_from.id",
  // General OpenTelemetry ──────────────────────────────────────────────────────────────────────────────────
  ERROR_TYPE: "error.type",
  // Foreman-specific ───────────────────────────────────────────────────────────────────────────────────────
  ORGANIZATION_ID: "foreman.organization.id",
  RUN_ATTEMPT: "foreman.run.attempt",
  RUN_SIMULATED: "foreman.run.simulated",
  /** Run status when the slice ended (QUEUED after a pause-free retry, WAITING_FOR_APPROVAL, SUCCEEDED, …). */
  RUN_STATUS: "foreman.run.status",
  APPROVAL_ID: "foreman.approval.id",
  /** Who made the decision: a human `reviewer`, the platform's `policy`, or the `system` expiring a request. */
  DECISION_SOURCE: "foreman.decision.source",
  /** The reviewer's workspace role (MEMBER | ADMIN | OWNER). Never a name or an email. */
  DECISION_ACTOR_ROLE: "foreman.decision.actor.role",
  /** Machine-readable reason code: call_limit, grant_revoked, run_ended, stale_decision, … */
  DECISION_REASON: "foreman.decision.reason",
  PAUSE_REASON: "foreman.pause.reason",
  PAUSE_APPROVAL_COUNT: "foreman.pause.approval_count",
} as const;

export type ToolCallDecisionOutcome = "require_approval" | "allow" | "deny" | "expired";
export type ResumedFromType = "pause" | "checkpoint";
export type DecisionSource = "reviewer" | "policy" | "system";

/** The only attribute keys that may leave the process. Anything else is dropped by `sanitizeAttributes`. */
export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set<string>(Object.values(ATTR));

/** Ids and enum values are short; a longer string can only be free text that does not belong in a trace. */
export const MAX_ATTRIBUTE_LENGTH = 200;

export interface ToolCallDecisionArgs {
  runId: string;
  /** When set, the event is only attached to the slice held by this executor (a zombie slice stays silent). */
  executorId?: string;
  toolCallId: string;
  toolName: string;
  outcome: ToolCallDecisionOutcome;
  source: DecisionSource;
  approvalId?: string;
  actorRole?: string;
  reason?: string;
  /** When the decision happened (defaults to now). */
  at?: Date;
}

export interface RunSliceStart {
  runId: string;
  executorId: string;
  organizationId: string;
  workerId: string;
  attempt: number;
  simulated: boolean;
  /** The checkpoint the slice starts from, as stored (before the slice recomputes its step index). */
  checkpoint: { componentIndex: number; nextStepIndex: number; pendingToolCallIds: string[] };
}

export interface ToolInvocationRecord {
  runId: string;
  executorId: string;
  toolCallId: string;
  toolName: string;
  /** The `tools.invoke` result status plus what the span needs from it; inputs and outputs never travel here. */
  outcome: { status: "ok"; simulated: boolean } | { status: "denied"; reason: string } | { status: "error" | "approval_required" | "rejected" | "invalid_input" };
  startedAt: number;
  endedAt: number;
}
