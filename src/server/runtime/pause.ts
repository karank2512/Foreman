import { recordActivity } from "@/server/activity";
import { db, toJson } from "@/server/db";
import type { AgentComponent } from "@/server/domain/blueprint";
import { checkpointId, telemetry } from "@/server/telemetry";
import type { RunSlice } from "./slice";
import type { AgentCheckpoint, PendingToolCall } from "./types";

export interface ApprovalRequest {
  call: PendingToolCall;
  approval: { title: string; description?: string };
}

function stepApprovalId(input: unknown): string | undefined {
  const id = (input as { approvalId?: unknown } | null)?.approvalId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Pause the run for human approval in ONE transaction: Approval rows, WAITING APPROVAL steps, the agent
 * checkpoint (conversation + pending calls) and the RUNNING → WAITING_FOR_APPROVAL transition either all land
 * or none do. A lost lock rolls everything back.
 */
export async function pauseForApproval(slice: RunSlice, component: AgentComponent, agent: AgentCheckpoint, requests: ApprovalRequest[]): Promise<string[]> {
  const { run } = slice;
  // Asking a human to approve work for a retired worker would leave a request nobody can act on.
  await slice.assertWorkerNotRetired();
  const created = await db.$transaction(async (tx) => {
    const waiting = await tx.runStep.findMany({ where: { runId: run.id, kind: "APPROVAL", status: "WAITING" }, select: { input: true } });
    const stepsFor = new Set(waiting.map((s) => stepApprovalId(s.input)).filter((id): id is string => !!id));
    const ids: Array<{ approvalId: string; title: string; toolName: string; toolCallId: string }> = [];
    for (const { call, approval } of requests) {
      // An approval may already exist when a previous pause was interrupted before it committed the checkpoint.
      const existing = await tx.approval.findUnique({ where: { toolCallId: call.toolCallId }, select: { id: true, status: true } });
      const approvalId =
        existing && existing.status === "PENDING"
          ? existing.id
          : (
              await tx.approval.create({
                data: {
                  organizationId: run.organizationId,
                  runId: run.id,
                  workerId: run.workerId,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  title: approval.title,
                  description: approval.description ?? null,
                  payload: toJson(call.input),
                  status: "PENDING",
                },
                select: { id: true },
              })
            ).id;
      if (!stepsFor.has(approvalId)) {
        await slice.steps.begin(
          { kind: "APPROVAL", componentId: component.id, title: approval.title, status: "WAITING", input: { approvalId, toolCallId: call.toolCallId } },
          tx,
        );
      }
      ids.push({ approvalId, title: approval.title, toolName: call.toolName, toolCallId: call.toolCallId });
    }
    slice.cp.agent = agent;
    await slice.lock.transition("WAITING_FOR_APPROVAL", { checkpoint: toJson(slice.snapshot()) }, tx);
    return ids;
  });

  // Telemetry after the commit, in the order things happened: each gated call was referred to a human, the
  // conversation was checkpointed, then the run paused. The pause id is the first request's Approval id — the
  // resumed slice finds it again through its first pending call (telemetry/events.ts).
  for (const { approvalId, toolName, toolCallId } of created) {
    telemetry.recordToolCallDecision({ runId: run.id, executorId: slice.lock.executorId, toolCallId, toolName, approvalId, outcome: "require_approval", source: "policy" });
  }
  telemetry.recordCheckpointed(run.id, slice.lock.executorId, checkpointId(run.id, run.attempt, slice.cp.nextStepIndex));
  if (created.length > 0) telemetry.recordPaused(run.id, slice.lock.executorId, { pauseId: created[0].approvalId, approvalCount: created.length });

  for (const { approvalId, title, toolName } of created) {
    await recordActivity({
      organizationId: run.organizationId,
      type: "APPROVAL_REQUESTED",
      title: `${slice.workerName} is asking for approval`,
      detail: title,
      workerId: run.workerId,
      jobId: run.jobId,
      runId: run.id,
      actorType: "WORKER",
      actorName: slice.workerName,
      metadata: { approvalId, toolName },
    });
  }
  return created.map((c) => c.approvalId);
}
