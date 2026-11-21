import { randomUUID } from "node:crypto";
import type { SessionContext } from "@/server/auth/types";
import { db, toJson } from "@/server/db";
import { parseBlueprint, type DeterministicComponent, type JobSpec, type ModelTier, type WorkerBlueprint, type WorkerProposal } from "@/server/domain";
import { approveJobSpec, buildJobSpec, convertDeterministicToAgents, convertedSteps, hireWorker, proposeWorker, scopeJob } from "@/server/staffing";
import { scopingAnswers, type BaselineId } from "./args";
import { safeErrorText } from "./safety";

/**
 * The benchmark's temporary workspace: one organization (everything a run writes cascades from it), an owner that
 * cannot sign in, and the hired workers (Foreman's design and each baseline). Isolated from anything else using the same database:
 *  - maxConcurrentRuns = 0, so no background executor (`npm run dev`, `npm run worker`) ever claims its runs —
 *    only this script's own executeRun does;
 *  - the workers' nextRunAt is cleared, so the scheduler never queues a run for them;
 *  - its monthly budget is the benchmark's cap (or one cent when simulated), so Foreman's own spend guard backs
 *    up the script's.
 */

export const BENCH_SLUG_PREFIX = "bench-cost-";
const BENCH_ORG_NAME = "Foreman cost benchmark (temporary)";

export interface BenchWorkspace {
  organizationId: string;
  slug: string;
  session: SessionContext;
}

export interface CleanupResult {
  workspaceDeleted: boolean;
  leftoverRows: number;
  note: string;
}

/** How many earlier benchmark workspaces were left behind (by slug AND name, so another tenant's org never matches). */
export async function countLeftoverWorkspaces(): Promise<number> {
  return db.organization.count({ where: { slug: { startsWith: BENCH_SLUG_PREFIX }, name: BENCH_ORG_NAME } });
}

export async function createBenchWorkspace(monthlyBudgetUsd: number): Promise<BenchWorkspace> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `${BENCH_SLUG_PREFIX}${suffix}`;
  const organization = await db.organization.create({
    data: { name: BENCH_ORG_NAME, slug, maxConcurrentRuns: 0, monthlyBudgetUsd },
  });
  try {
    const user = await db.user.create({
      data: { organizationId: organization.id, email: `${slug}@example.test`, name: "Cost benchmark", passwordHash: "not-a-real-hash", role: "OWNER" },
    });
    return {
      organizationId: organization.id,
      slug,
      session: { userId: user.id, organizationId: organization.id, organizationName: organization.name, role: "OWNER", name: user.name, email: user.email },
    };
  } catch (e) {
    await db.organization.delete({ where: { id: organization.id } }).catch(() => undefined);
    throw e;
  }
}

/** Rows still pointing at the workspace after the delete; anything above 0 means the cascade missed something. */
async function leftoverRows(organizationId: string): Promise<number> {
  const where = { organizationId };
  const counts = await Promise.all([
    db.organization.count({ where: { id: organizationId } }),
    db.user.count({ where }),
    db.job.count({ where }),
    db.worker.count({ where }),
    db.run.count({ where }),
    db.modelCall.count({ where }),
    db.usageRecord.count({ where }),
    db.deliverable.count({ where }),
    db.evaluation.count({ where }),
    db.activityEvent.count({ where }),
    db.orgSpendMonth.count({ where }),
  ]);
  return counts.reduce((sum, n) => sum + n, 0);
}

/** Deletes the workspace (all tenant tables cascade from Organization) and verifies nothing is left. Never throws. */
export async function deleteBenchWorkspace(workspace: Pick<BenchWorkspace, "organizationId" | "slug">): Promise<CleanupResult> {
  try {
    await db.organization.deleteMany({ where: { id: workspace.organizationId } });
    const left = await leftoverRows(workspace.organizationId);
    return {
      workspaceDeleted: left === 0,
      leftoverRows: left,
      note:
        left === 0
          ? `Temporary workspace ${workspace.slug} deleted; 0 rows left behind.`
          : `Temporary workspace ${workspace.slug} was deleted but ${left} row(s) still reference it.`,
    };
  } catch (e) {
    return {
      workspaceDeleted: false,
      leftoverRows: -1,
      note: `Could not delete temporary workspace ${workspace.slug} (organization id ${workspace.organizationId}): ${safeErrorText(e)}. Delete that organization to remove everything the benchmark wrote.`,
    };
  }
}

export interface HiredWorker {
  workerId: string;
  blueprint: WorkerBlueprint;
}

export interface HiredBaseline extends HiredWorker {
  /** Converted agent id → the deterministic steps of Foreman's worker it performs. */
  converted: Map<string, DeterministicComponent[]>;
}

export interface HiredWorkers {
  spec: JobSpec;
  answers: Record<string, string>;
  after: HiredWorker;
  baselines: Partial<Record<BaselineId, HiredBaseline>>;
}

async function storedBlueprint(organizationId: string, workerId: string): Promise<WorkerBlueprint> {
  const worker = await db.worker.findFirstOrThrow({ where: { id: workerId, organizationId }, select: { currentVersion: { select: { blueprint: true } } } });
  return parseBlueprint(worker.currentVersion?.blueprint);
}

/**
 * AFTER goes through Foreman's normal hire flow (scope → spec → approve → propose → hire). Each baseline is a
 * further job with the same description and answers — so the same spec, checked — whose proposal is the AFTER
 * blueprint converted by convertDeterministicToAgents, hired under the same name so every shared prompt matches.
 * `records` (--records) is the customer's answer to the volume question; the spec must come back with that target.
 */
export async function hireBenchWorkers(workspace: BenchWorkspace, description: string, beforeTier: ModelTier, baselines: readonly BaselineId[], records?: number): Promise<HiredWorkers> {
  const { session, organizationId } = workspace;

  const scoped = await scopeJob(session, description);
  const answers = scopingAnswers(scoped.questions.questions, records);
  const built = await buildJobSpec(session, scoped.jobId, answers);
  if (records !== undefined && built.spec.deliverable.targetCount !== records) {
    throw new Error(`Scoping turned the answer "${records} per run" into a target of ${built.spec.deliverable.targetCount ?? "no fixed number"}, so --records cannot be honoured.`);
  }
  await approveJobSpec(session, built.jobSpecId);
  const proposal = await proposeWorker(session, scoped.jobId);
  const hiredAfter = await hireWorker(session, scoped.jobId, { startFirstRun: false });
  const workerIds = [hiredAfter.workerId];

  const hiredBaselines: Partial<Record<BaselineId, HiredBaseline>> = {};
  for (const shape of baselines) {
    const scopedBaseline = await scopeJob(session, description);
    const builtBaseline = await buildJobSpec(session, scopedBaseline.jobId, scopingAnswers(scopedBaseline.questions.questions, records));
    if (JSON.stringify(builtBaseline.spec) !== JSON.stringify(built.spec)) {
      throw new Error("The benchmark jobs were scoped into different specs, so their costs would not be comparable.");
    }
    await approveJobSpec(session, builtBaseline.jobSpecId);
    const baselineProposal: WorkerProposal = {
      jobSpecId: builtBaseline.jobSpecId,
      blueprint: convertDeterministicToAgents(proposal.blueprint, { tier: beforeTier, shape }),
      rationale: [`All-agent baseline (${shape}) for the cost benchmark: Foreman's design with its mechanical steps done by a model.`],
      simulated: proposal.simulated,
      generatedAt: new Date().toISOString(),
    };
    await db.job.updateMany({ where: { id: scopedBaseline.jobId, organizationId }, data: { pendingProposal: toJson(baselineProposal) } });
    const hired = await hireWorker(session, scopedBaseline.jobId, { name: proposal.blueprint.persona.name, startFirstRun: false });
    workerIds.push(hired.workerId);
    hiredBaselines[shape] = {
      workerId: hired.workerId,
      blueprint: await storedBlueprint(organizationId, hired.workerId),
      converted: new Map(convertedSteps(proposal.blueprint, { shape }).map((s) => [s.componentId, s.replaces])),
    };
  }

  await db.worker.updateMany({ where: { organizationId, id: { in: workerIds } }, data: { nextRunAt: null } });

  // What the runs will execute, read back and validated against the domain schema.
  return {
    spec: built.spec,
    answers,
    after: { workerId: hiredAfter.workerId, blueprint: await storedBlueprint(organizationId, hiredAfter.workerId) },
    baselines: hiredBaselines,
  };
}
