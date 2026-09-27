import type { RunStepKind, RunStepStatus, RunTrigger, ToolCallStatus } from "@prisma/client";
import { format } from "date-fns";
import type { StatusTone } from "@/lib/status";

/**
 * Pure lookups shared by the timeline pieces (Prisma enums are type-only imports, so this is client-safe).
 * Labels are contractor-style: a step is something the worker did, not something the system executed. There
 * are deliberately no icons here — the timeline carries state in a single coloured dot per step.
 */

export const STEP_KIND_LABEL: Record<RunStepKind, string> = {
  PLAN: "Plan",
  MODEL_CALL: "Thinking",
  TOOL_CALL: "Tool",
  DETERMINISTIC: "Processing",
  APPROVAL: "Approval",
  DELIVERABLE: "Deliverable",
  EVALUATION: "Evaluation",
  NOTE: "Note",
  ERROR: "Problem",
};

export const STEP_STATUS_META: Record<RunStepStatus, { label: string; tone: StatusTone; pulse?: boolean }> = {
  PENDING: { label: "Pending", tone: "idle" },
  RUNNING: { label: "In progress", tone: "running", pulse: true },
  WAITING: { label: "Waiting for you", tone: "attention", pulse: true },
  SUCCEEDED: { label: "Done", tone: "success" },
  FAILED: { label: "Failed", tone: "failure" },
  SKIPPED: { label: "Skipped", tone: "idle" },
};

export const TOOL_CALL_STATUS_META: Record<ToolCallStatus, { label: string; tone: StatusTone }> = {
  PENDING_APPROVAL: { label: "Awaiting approval", tone: "attention" },
  APPROVED: { label: "Approved", tone: "success" },
  RUNNING: { label: "Running", tone: "running" },
  SUCCEEDED: { label: "Succeeded", tone: "success" },
  FAILED: { label: "Failed", tone: "failure" },
  DENIED: { label: "Declined", tone: "failure" },
};

export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  MANUAL: "Started manually",
  SCHEDULED: "Scheduled run",
  RETRY: "Retry of an earlier run",
  CHAT: "Started from a conversation",
  HIRE: "First run after hiring",
};

/** Deterministic steps report `{ before, after }` record counts when they filter a list. */
export function recordCounts(output: unknown): { before: number; after: number } | null {
  const o = output as { before?: unknown; after?: unknown } | null;
  return typeof o?.before === "number" && typeof o?.after === "number" ? { before: o.before, after: o.after } : null;
}

/** Deliverable steps store the id they created in their output. */
export function deliverableIdOf(output: unknown): string | null {
  const id = (output as { deliverableId?: unknown } | null)?.deliverableId;
  return typeof id === "string" ? id : null;
}

/** The addresses a send-style request goes to, when its payload names them. */
export function recipientsOf(payload: unknown): string[] {
  const raw = (payload as { recipients?: unknown } | null)?.recipients;
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string" && r.trim() !== "") : [];
}

/** The final button of the approve confirmation names the consequence: "Send to 2 recipients". */
export function approveConfirmLabel(payload: unknown): string {
  const n = recipientsOf(payload).length;
  if (n === 0) return "Approve";
  return `Send to ${n} ${n === 1 ? "recipient" : "recipients"}`;
}

/** A run is named by when it happened — the job title already heads the job's own page. */
export function runHeading(startedAt: string | null, createdAt: string): string {
  const when = new Date(startedAt ?? createdAt);
  return Number.isNaN(when.getTime()) ? "Run" : `Run on ${format(when, "MMM d, h:mm a")}`;
}

interface TimelineStepLike {
  id: string;
  kind: RunStepKind;
  status: RunStepStatus;
  componentId: string | null;
}

interface TimelineDetailLike {
  input: unknown;
  toolCalls: Array<{ id: string }>;
}

/**
 * The tool step a WAITING approval is holding back. While the run waits, that step is a duplicate of the approval
 * row — and its label is already written in the past tense ("Sent …") although nothing has been sent — so the
 * timeline shows the approval alone. Linked by the approval step's `toolCallId` when the details are loaded;
 * before that, by being the pending tool step of the same component directly above the approval.
 */
export function heldBackToolStepIds(steps: TimelineStepLike[], details: Record<string, TimelineDetailLike | undefined>): Set<string> {
  const held = new Set<string>();
  steps.forEach((step, i) => {
    if (step.kind !== "APPROVAL" || step.status !== "WAITING") return;
    const toolCallId = (details[step.id]?.input as { toolCallId?: unknown } | null | undefined)?.toolCallId;
    const linked =
      typeof toolCallId === "string"
        ? steps.find((s) => s.kind === "TOOL_CALL" && details[s.id]?.toolCalls.some((c) => c.id === toolCallId))
        : undefined;
    const previous = steps[i - 1];
    const candidate =
      linked ?? (previous && previous.kind === "TOOL_CALL" && previous.componentId === step.componentId ? previous : undefined);
    if (candidate && candidate.status === "PENDING") held.add(candidate.id);
  });
  return held;
}
