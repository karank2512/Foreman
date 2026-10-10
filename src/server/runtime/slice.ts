import { db, toJson, type DbOrTx } from "@/server/db";
import { resolveSecret } from "@/server/secrets";
import { checkpointId, telemetry } from "@/server/telemetry";
import type { ToolContext } from "@/server/tools/types";
import { runAgentComponent } from "./agent-loop";
import { cloneContext } from "./checkpoint";
import type { RunBundle } from "./context";
import { ensureDeliverable } from "./deliverable";
import { runDeterministicStep } from "./deterministic-step";
import { LockLost, RunCancelled, toRunFailure, WORKER_RETIRED_REASON } from "./failure";
import { finishCancelled, finishFailure, finishSuccess } from "./finish";
import { enforceLimits } from "./limits";
import type { RunLock } from "./lock";
import { StepWriter } from "./steps";
import type { ExecuteOutcome, RunCheckpoint } from "./types";

/**
 * One executeRun slice: drives the run from its checkpoint through as many components as it can, saving the
 * checkpoint at every component boundary. All state that must survive a crash lives in `cp` (persisted through
 * the fenced lock); everything else here is scratch.
 */
export class RunSlice {
  readonly cp: RunCheckpoint;
  readonly steps: StepWriter;
  /** Wall-clock start of this slice; active time = counters.activeMs at start + elapsed. */
  private readonly startedAt = Date.now();
  private readonly activeMsBefore: number;
  /** Where a retry restarts: the component that was running and the context as it was when it started. */
  componentStart: { index: number; context: Record<string, unknown> };

  constructor(
    readonly bundle: RunBundle,
    readonly lock: RunLock,
    nextStepIndex: number,
  ) {
    this.cp = bundle.run.checkpoint;
    this.activeMsBefore = this.cp.counters.activeMs;
    this.steps = new StepWriter(bundle.run.id, bundle.run.attempt, nextStepIndex, lock.executorId);
    this.componentStart = { index: this.cp.componentIndex, context: cloneContext(this.cp.context) };
  }

  get run() {
    return this.bundle.run;
  }
  get blueprint() {
    return this.bundle.blueprint;
  }
  get spec() {
    return this.bundle.spec;
  }
  get workerName() {
    return this.bundle.worker.name;
  }

  activeMs(): number {
    return this.activeMsBefore + (Date.now() - this.startedAt);
  }

  /** The checkpoint as it should be persisted right now (step index hint + active time refreshed). */
  snapshot(): RunCheckpoint {
    this.cp.nextStepIndex = Math.max(this.cp.nextStepIndex, this.steps.nextIndex);
    this.cp.counters.activeMs = Math.round(this.activeMs());
    return this.cp;
  }

  async saveCheckpoint(tx?: DbOrTx): Promise<void> {
    await this.lock.write({ checkpoint: toJson(this.snapshot()) }, tx);
    telemetry.recordCheckpointed(this.run.id, this.lock.executorId, checkpointId(this.run.id, this.run.attempt, this.cp.nextStepIndex));
  }

  async enforceLimits(extra: { pendingToolCalls?: number } = {}): Promise<void> {
    await enforceLimits({
      runId: this.run.id,
      attempt: this.run.attempt,
      limits: this.blueprint.limits,
      activeMs: this.activeMs(),
      pendingToolCalls: extra.pendingToolCalls,
    });
  }

  toolContext(): ToolContext {
    const { organizationId, workerId, workerVersionId, id: runId, attempt, simulated } = this.run;
    return { organizationId, workerId, workerVersionId, runId, attempt, simulated, getSecret: (name) => resolveSecret(organizationId, name) };
  }

  /**
   * A retired worker's run can never be claimed again (claimNextRun only serves ACTIVE workers), so it must not be
   * parked in QUEUED or WAITING_FOR_APPROVAL. Checked at component boundaries, before an approval pause and before
   * a retry. A PAUSED worker is fine: its runs wait for the resume.
   */
  async assertWorkerNotRetired(): Promise<void> {
    const worker = await db.worker.findUnique({ where: { id: this.run.workerId }, select: { status: true } });
    if (!worker || worker.status === "RETIRED") throw new RunCancelled(WORKER_RETIRED_REASON);
  }

  /** Leftovers of a dead slice can never complete; mark them so the trace is honest and nothing looks in flight. */
  async closeInterruptedWork(): Promise<void> {
    const pendingIds = (this.cp.agent?.pendingToolCalls ?? []).map((p) => p.toolCallId);
    const pendingStepIds = pendingIds.length > 0 ? (await db.toolCall.findMany({ where: { id: { in: pendingIds } }, select: { runStepId: true } })).flatMap((t) => (t.runStepId ? [t.runStepId] : [])) : [];
    const now = new Date();
    await db.runStep.updateMany({
      where: {
        runId: this.run.id,
        id: { notIn: pendingStepIds },
        OR: [{ status: "RUNNING" }, { status: "WAITING", kind: { not: "APPROVAL" } }],
      },
      data: { status: "FAILED", error: "interrupted", finishedAt: now },
    });
    // Pending (approval) calls are resolved by the idempotent resume — it decides whether they may re-run.
    await db.toolCall.updateMany({
      where: { runId: this.run.id, status: "RUNNING", id: { notIn: pendingIds } },
      data: { status: "FAILED", error: "interrupted", finishedAt: now },
    });
  }

  async drive(): Promise<ExecuteOutcome> {
    try {
      const { components } = this.blueprint;
      while (this.cp.componentIndex < components.length) {
        await this.lock.assertHeld();
        await this.assertWorkerNotRetired();
        await this.enforceLimits();
        const component = components[this.cp.componentIndex];
        this.componentStart = { index: this.cp.componentIndex, context: cloneContext(this.cp.context) };

        let output: unknown;
        if (component.type === "agent") {
          const result = await runAgentComponent(this, component);
          if (result.status === "paused") return { status: "WAITING_FOR_APPROVAL", approvalIds: result.approvalIds };
          output = result.output;
        } else {
          output = await runDeterministicStep(this, component);
        }

        this.cp.context[component.outputKey] = output;
        this.cp.componentIndex += 1;
        this.cp.agent = undefined;
        await ensureDeliverable(this);
        await this.saveCheckpoint();
      }
      await ensureDeliverable(this);
      return await finishSuccess(this);
    } catch (e) {
      if (e instanceof LockLost) throw e;
      if (e instanceof RunCancelled) return await finishCancelled(this, e.reason);
      return await finishFailure(this, toRunFailure(e));
    }
  }
}
