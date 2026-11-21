import { db, toJson } from "@/server/db";
import type { WorkerBlueprint } from "@/server/domain";
import { errorMessage } from "@/server/errors";
import { enqueueRun, executeRun, type ReportMeta, type RunCheckpoint } from "@/server/runtime";
import type { BaselineId } from "./args";
import { finalContext, replayCheckpoint, replayContext, type AnswerTap } from "./capture";
import { canonical, mismatchedKeys, walkRun, type PairFidelity } from "./fidelity";
import { measureRun, type ArmId, type RunMeasurement } from "./measure";
import type { PairRecord } from "./report";
import type { BenchWorkspace, HiredWorker, HiredWorkers } from "./workspace";

/**
 * One pair: Foreman's worker end to end, then every baseline from the records its collector returned.
 *
 * The baselines start from a checkpoint (the runtime's own resume mechanism, the one approvals and crash recovery
 * use) whose context holds the collector's output, so they skip the collector and run only what differs. Before
 * that, the replay is proven: AFTER's own code, run on the replayed records, must reproduce the records and stats
 * the AFTER run ended with. A pair that cannot be proven is recorded as unpaired and left out of the comparison.
 */

export interface PairDeps {
  workspace: BenchWorkspace;
  hired: HiredWorkers;
  tap: AnswerTap;
  prefixLength: number;
  stopRequested(): boolean;
  /** The run in flight, so a Ctrl+C can cancel it. */
  setCurrentRun(runId: string | null): void;
  onRun(m: RunMeasurement): void;
}

const pipelineMeta = (bp: WorkerBlueprint): ReportMeta => ({ personaName: bp.persona.name, now: new Date(), pipeline: bp.components.map((c) => c.name), toolUsage: [], recordTrail: [] });

async function runArm(deps: PairDeps, arm: ArmId, worker: HiredWorker, pair: number, checkpoint?: RunCheckpoint): Promise<RunMeasurement> {
  const { organizationId, session } = deps.workspace;
  const { runId } = await enqueueRun({ organizationId, workerId: worker.workerId, trigger: "MANUAL", requestedById: session.userId });
  // One attempt per run: an automatic retry would double-count cost and spend money nobody planned for.
  await db.run.updateMany({ where: { id: runId, organizationId }, data: { maxAttempts: 1, ...(checkpoint ? { checkpoint: toJson(checkpoint) } : {}) } });
  deps.tap.watch(runId);
  deps.setCurrentRun(runId);
  const started = Date.now();
  try {
    await executeRun(runId);
  } catch (e) {
    console.warn(`  run ${runId} did not finish cleanly: ${errorMessage(e)}`);
  }
  const wallMs = Date.now() - started;
  deps.setCurrentRun(null);
  const m = await measureRun({ organizationId, runId, arm, pair, wallMs, weights: worker.blueprint.evaluation.weights });
  deps.onRun(m);
  return m;
}

/** Keys written by the components a walk re-traces. */
const keysFrom = (bp: WorkerBlueprint, start: number) => [...new Set(bp.components.slice(start).map((c) => c.outputKey))];

async function proveReplay(deps: PairDeps, after: RunMeasurement): Promise<{ ok: true; context: Record<string, unknown>; afterFinal: Record<string, unknown> } | { ok: false; note: string }> {
  const { organizationId } = deps.workspace;
  const bp = deps.hired.after.blueprint;
  if (after.status !== "SUCCEEDED") return { ok: false, note: `the AFTER run ended ${after.status}` };
  const [answers, afterFinal] = await Promise.all([deps.tap.finalAnswers(organizationId, after.runId), finalContext(organizationId, after.runId)]);
  if (!afterFinal) return { ok: false, note: "the AFTER run left no checkpoint to compare with" };
  const replay = replayContext(bp, deps.prefixLength, answers);
  if (!replay.ok) return replay;
  const walk = walkRun({ components: bp.components, startIndex: deps.prefixLength, startContext: replay.context, answers, converted: new Map(), meta: pipelineMeta(bp), runFinal: afterFinal });
  if (walk.error) return { ok: false, note: walk.error };
  const differing = mismatchedKeys(walk, afterFinal, keysFrom(bp, deps.prefixLength));
  if (differing.length > 0) return { ok: false, note: `replaying the collector's answer did not reproduce the AFTER run's ${differing.join(", ")}` };
  return { ok: true, context: replay.context, afterFinal };
}

async function fidelityOf(deps: PairDeps, id: BaselineId, run: RunMeasurement, replay: Record<string, unknown>, afterFinal: Record<string, unknown>): Promise<PairFidelity> {
  const baseline = deps.hired.baselines[id];
  const unavailable = (note: string): PairFidelity => ({ available: false, note, steps: [], matchesAfter: {} });
  if (!baseline) return unavailable("baseline not hired");
  if (run.status !== "SUCCEEDED") return unavailable(`run ended ${run.status}`);
  const { organizationId } = deps.workspace;
  const [answers, runFinal] = await Promise.all([deps.tap.finalAnswers(organizationId, run.runId), finalContext(organizationId, run.runId)]);
  if (!runFinal) return unavailable("the run left no checkpoint");
  const bp = baseline.blueprint;
  const walk = walkRun({ components: bp.components, startIndex: deps.prefixLength, startContext: replay, answers, converted: baseline.converted, meta: pipelineMeta(bp), runFinal });
  if (walk.error) return unavailable(walk.error);
  // The walk must land exactly where the run did, or the inputs it compared against are not the model's inputs.
  const differing = mismatchedKeys(walk, runFinal, keysFrom(bp, deps.prefixLength));
  if (differing.length > 0) return unavailable(`could not rebuild the run's ${differing.join(", ")}`);
  const jsonKeys = [...new Set(bp.components.filter((c) => c.type === "agent" && baseline.converted.has(c.id) && c.outputFormat === "json").map((c) => c.outputKey))];
  return {
    available: true,
    note: null,
    steps: walk.steps,
    matchesAfter: Object.fromEntries(jsonKeys.map((k) => [k, canonical(runFinal[k]) === canonical(afterFinal[k])])),
  };
}

export async function runPair(deps: PairDeps, pair: number, order: readonly BaselineId[]): Promise<PairRecord> {
  const afterBp = deps.hired.after.blueprint;
  const after = await runArm(deps, "after", deps.hired.after, pair);
  const sharedIds = afterBp.components.slice(0, deps.prefixLength).map((c) => c.id);
  const record: PairRecord = {
    pair,
    after,
    baselines: {},
    shared: { componentIds: sharedIds, byComponent: Object.fromEntries(sharedIds.filter((id) => after.byComponent[id]).map((id) => [id, after.byComponent[id]])) },
    replay: { ok: false, note: "not attempted" },
    fidelity: {},
  };
  const proven = await proveReplay(deps, after);
  if (!proven.ok) {
    record.replay = { ok: false, note: proven.note };
    console.warn(`  pair ${pair} could not be paired: ${proven.note}; its baselines were not run.`);
    return record;
  }
  record.replay = { ok: true, note: `the collector's ${Object.keys(proven.context).join(", ")} replayed and verified against the AFTER run` };
  for (const id of order) {
    const baseline = deps.hired.baselines[id];
    if (!baseline || deps.stopRequested()) continue;
    const run = await runArm(deps, id, baseline, pair, replayCheckpoint(deps.prefixLength, proven.context));
    record.baselines[id] = run;
    record.fidelity[id] = await fidelityOf(deps, id, run, proven.context, proven.afterFinal);
  }
  return record;
}
