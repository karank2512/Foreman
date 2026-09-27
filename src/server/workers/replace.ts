import { assertCan } from "@/server/auth/permissions";
import type { SessionContext } from "@/server/auth/types";
import { db } from "@/server/db";
import {
  ReplacementPlanSchema,
  workerFieldsToCadence,
  type AgentComponent,
  type BlueprintComponent,
  type DeterministicCheck,
  type JobSpec,
  type ReplacementAnalysis,
  type ReplacementPlan,
  type WorkerBlueprint,
} from "@/server/domain";
import { conflict, errorMessage } from "@/server/errors";
import { llm } from "@/server/models";
import { enqueueRun } from "@/server/runtime";
import { assertOrgActive, assertWithinBudget } from "@/server/security";
import { assertHeadcount } from "@/server/staffing";
import { fieldList, fieldPhrase } from "@/server/staffing/labels";
import { activateVersion } from "./activate";
import { gatherEvidence, type ReplacementEvidence } from "./replace-evidence";
import { mockReplacementPlan } from "./replace-mock";
import { PLAN_SYSTEM, normalizePlan, planPrompt } from "./replace-plan";
import { loadWorker, parseStoredBlueprint, parseStoredSpec, recostAndValidate, requiredSpecFields } from "./shared";
import { createProposedVersion } from "./versions";

/**
 * Replace a worker like a contractor: gather the evidence, let the staffing brain plan a better design, assemble
 * and validate the new blueprint in code, and put it in front of the manager as a PROPOSED version. Nothing
 * changes until they hire the replacement.
 */

const VALIDATE_ID = "validate_records";
const DEDUPE_ID = "dedupe";

const isAgent = (c: BlueprintComponent): c is AgentComponent => c.type === "agent";

function insertAfter(components: BlueprintComponent[], afterId: string, component: BlueprintComponent): BlueprintComponent[] {
  const index = components.findIndex((c) => c.id === afterId);
  if (index === -1) return [...components, component];
  return [...components.slice(0, index + 1), component, ...components.slice(index + 1)];
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/** PURE: the plan's edits applied to the current blueprint — see docs/CONTRACTS.md § applyReplacementPlan. */
export function applyReplacementPlan(current: WorkerBlueprint, spec: JobSpec, plan: ReplacementPlan): WorkerBlueprint {
  const rewrites = new Map(plan.instructionRewrites.map((r) => [r.componentId, r.instructions.trim()] as const));
  const tiers = new Map(plan.tierChanges.map((t) => [t.componentId, t.modelTier] as const));

  // (1) Instruction rewrites and tier changes apply to AGENT components only; unknown ids are ignored.
  let components: BlueprintComponent[] = current.components.map((c) => {
    if (!isAgent(c)) return c;
    const instructions = rewrites.get(c.id);
    const modelTier = tiers.get(c.id);
    if (instructions === undefined && modelTier === undefined) return c;
    return { ...c, ...(instructions ? { instructions } : {}), ...(modelTier ? { modelTier } : {}) };
  });

  const required = requiredSpecFields(spec);
  const collector = components.find((c): c is AgentComponent => isAgent(c) && c.outputFormat === "json");
  const recordsKey = collector?.outputKey;
  const ids = new Set(components.map((c) => c.id));
  const checks: DeterministicCheck[] = [...current.evaluation.deterministicChecks];
  const hasOperation = (op: "validate_records" | "dedupe") => components.some((c) => c.type === "deterministic" && c.operation === op);

  // (2) Validation right after the collector, when the spec names required fields.
  let validateId: string | null = null;
  if (plan.addValidationStep && collector && recordsKey && required.length > 0 && !hasOperation("validate_records")) {
    validateId = uniqueId(VALIDATE_ID, ids);
    ids.add(validateId);
    components = insertAfter(components, collector.id, {
      type: "deterministic",
      id: validateId,
      name: "Validate records",
      description: `Drops any record missing ${fieldList(required, "or")}.`,
      operation: "validate_records",
      config: { requiredFields: required, dropInvalid: true },
      inputKeys: [recordsKey],
      outputKey: recordsKey,
    });
    if (!checks.some((c) => c.type === "required_fields")) {
      checks.push({
        id: uniqueId("required_fields", new Set(checks.map((c) => c.id))),
        type: "required_fields",
        description: `Required fields are filled (${required.map(fieldPhrase).join(", ")})`,
        config: { fields: required, minCompleteness: 0.9 },
        weight: 2,
      });
    }
  }

  // (3) De-duplication after validation (or after the collector when validation was not added).
  if (plan.addDedupeStep && collector && recordsKey && required.length > 0 && !hasOperation("dedupe")) {
    const keyFields = [required[0]];
    const dedupeId = uniqueId(DEDUPE_ID, ids);
    components = insertAfter(components, validateId ?? components.find((c) => c.type === "deterministic" && c.operation === "validate_records")?.id ?? collector.id, {
      type: "deterministic",
      id: dedupeId,
      name: "Remove duplicates",
      description: `Keeps one record per ${fieldList(keyFields)}.`,
      operation: "dedupe",
      config: { keyFields },
      inputKeys: [recordsKey],
      outputKey: recordsKey,
    });
    if (!checks.some((c) => c.type === "no_duplicates")) {
      checks.push({
        id: uniqueId("no_duplicates", new Set(checks.map((c) => c.id))),
        type: "no_duplicates",
        description: `No repeated ${fieldList(keyFields)}`,
        config: { keyFields },
        weight: 1,
      });
    }
  }

  // (4) Re-price and validate.
  return recostAndValidate({ ...current, components, evaluation: { ...current.evaluation, deterministicChecks: checks } });
}

export function buildAnalysis(plan: ReplacementPlan, evidence: ReplacementEvidence, simulated: boolean): ReplacementAnalysis {
  return {
    summary: plan.summary,
    failurePatterns: plan.failurePatterns,
    rootCauses: plan.rootCauses,
    changes: plan.changes,
    estimatedDeltas: plan.estimatedDeltas,
    basedOn: {
      runs: evidence.runs,
      failedRuns: evidence.failed,
      evaluations: evidence.evaluations,
      rejectedDeliverables: evidence.rejectedDeliverables.length,
      windowDays: evidence.windowDays,
    },
    simulated,
  };
}

export async function proposeReplacement(s: SessionContext, workerId: string): Promise<{ versionId: string }> {
  assertCan(s, "workers.manage");
  await assertOrgActive(s.organizationId);
  await assertWithinBudget(s.organizationId);
  const worker = await loadWorker(s.organizationId, workerId);
  if (worker.status === "RETIRED") throw conflict(`${worker.name} is retired; hire a new worker for this job instead`);
  const version = worker.currentVersion;
  if (!version) throw conflict(`${worker.name} has no active version to replace`);

  // The live schedule is the worker's, not the version's: a replacement must not silently undo a schedule change.
  const current: WorkerBlueprint = { ...parseStoredBlueprint(version.blueprint), schedule: workerFieldsToCadence(worker) };
  const spec = parseStoredSpec(version.jobSpec.spec);
  const evidence = await gatherEvidence({
    organizationId: s.organizationId,
    workerId: worker.id,
    versionId: version.id,
    blueprint: current,
    workerName: worker.name,
    jobTitle: worker.job.title,
  });

  const agentIds = new Set(current.components.filter(isAgent).map((c) => c.id));
  const planned = await llm.generateObject<ReplacementPlan>(
    {
      tier: "reasoning",
      system: PLAN_SYSTEM,
      prompt: planPrompt({ blueprint: current, spec, evidence }),
      schema: ReplacementPlanSchema,
      schemaName: "ReplacementPlan",
      normalize: normalizePlan(agentIds),
      mock: () => mockReplacementPlan(current, spec, evidence),
    },
    { organizationId: s.organizationId, purpose: "replace.plan", workerId: worker.id, jobId: worker.jobId },
  );

  const blueprint = applyReplacementPlan(current, spec, planned.object);
  const analysis = buildAnalysis(planned.object, evidence, planned.simulated);
  const { versionId } = await createProposedVersion({
    organizationId: s.organizationId,
    workerId: worker.id,
    blueprint,
    changeReason: "REPLACEMENT",
    changeSummary: planned.object.summary,
    analysis,
    userId: s.userId,
  });
  return { versionId };
}

/** "Hire" the proposed replacement: activate it and, unless told otherwise, put its first run on the queue. */
export async function hireReplacement(
  s: SessionContext,
  versionId: string,
  opts: { newName?: string; startFirstRun?: boolean } = {},
): Promise<{ runId?: string }> {
  assertCan(s, "workers.hire");
  await assertOrgActive(s.organizationId);
  const seat = await db.workerVersion.findFirst({
    where: { id: versionId, worker: { organizationId: s.organizationId } },
    select: { workerId: true },
  });
  // The seat this replacement takes over is already on the roster, so it is excluded from the headcount cap:
  // an org sitting exactly at its limit must still be able to replace a worker (audit F-004).
  await assertHeadcount(s.organizationId, seat ? { excludeWorkerId: seat.workerId } : {});

  await activateVersion(s, versionId, { newName: opts.newName });
  if (opts.startFirstRun === false || !seat) return {};

  try {
    const { runId } = await enqueueRun({ organizationId: s.organizationId, workerId: seat.workerId, trigger: "HIRE", requestedById: s.userId });
    return { runId };
  } catch (e) {
    // The replacement is hired either way (a paused worker, for instance, cannot take a run yet).
    console.error(`[workers] hired replacement ${versionId} but could not queue the first run: ${errorMessage(e)}`);
    return {};
  }
}
