import type { EvaluationType, RunStatus } from "@prisma/client";
import { db } from "@/server/db";
import { DEFAULT_EVALUATION_WEIGHTS, safeParseBlueprint } from "@/server/domain/blueprint";
import { HEALTH_THRESHOLDS, type WorkerScore } from "@/server/domain/evaluation";
import { notFound } from "@/server/errors";
import { assessHealth, type FinishedStatus } from "./health";

/**
 * Worker scoring. `combineScores` and `runScore` are PURE; the rest reads the DB and caches the result on the
 * Worker row (the only writer of Worker.score / health / healthReason — see CONTRACTS "Who writes what").
 */

export type EvaluationWeights = { deterministic: number; judge: number; user: number };
export type ScoreParts = { deterministic: number[]; judge: number[]; user: number[] };
export type ScoreSource = keyof ScoreParts;

const SOURCES: readonly ScoreSource[] = ["deterministic", "judge", "user"];
/** Default window of finished runs a worker is scored over. */
export const DEFAULT_SCORE_RUN_WINDOW = 10;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function mean(values: readonly number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return clamp01(finite.reduce((sum, v) => sum + v, 0) / finite.length);
}

/**
 * Mean per source, then a weighted blend where the weights are re-normalized over the sources that actually
 * have data (a worker nobody has reviewed yet is not penalized for the missing user component).
 * No data at all, or zero total weight over the sources with data → score null. Never NaN.
 */
export function combineScores(parts: ScoreParts, weights: EvaluationWeights, runs = 0): WorkerScore {
  const components = {
    deterministic: mean(parts.deterministic),
    judge: mean(parts.judge),
    user: mean(parts.user),
  };
  const safeWeight = (source: ScoreSource) => {
    const w = weights[source];
    return Number.isFinite(w) && w > 0 ? w : 0;
  };
  const withData = SOURCES.filter((source) => components[source] !== null && safeWeight(source) > 0);
  const totalWeight = withData.reduce((sum, source) => sum + safeWeight(source), 0);

  const weightsUsed = { deterministic: 0, judge: 0, user: 0 };
  let score: number | null = null;
  if (totalWeight > 0) {
    let blended = 0;
    for (const source of withData) {
      weightsUsed[source] = safeWeight(source) / totalWeight;
      blended += (components[source] ?? 0) * weightsUsed[source];
    }
    score = Math.round(clamp01(blended) * 1000) / 10;
  }

  return {
    score,
    components,
    weightsUsed,
    sampleSize: {
      deterministic: parts.deterministic.length,
      judge: parts.judge.length,
      user: parts.user.length,
      runs,
    },
  };
}

export interface EvaluationPart {
  type: EvaluationType;
  /** 0..1 */
  score: number;
}

/** Group evaluation rows of ONE run into score parts. */
export function partsFromEvaluations(evaluations: readonly EvaluationPart[]): ScoreParts {
  const parts: ScoreParts = { deterministic: [], judge: [], user: [] };
  for (const e of evaluations) {
    if (e.type === "DETERMINISTIC") parts.deterministic.push(e.score);
    else if (e.type === "LLM_JUDGE") parts.judge.push(e.score);
    else parts.user.push(e.score);
  }
  return parts;
}

/**
 * Score of a single run, 0..100: SUCCEEDED → blend of its evaluations with the version's weights (null when it
 * has none yet) · FAILED → 0 · anything else (cancelled, still running) → null, i.e. excluded from trends.
 */
export function runScore(status: RunStatus, evaluations: readonly EvaluationPart[], weights: EvaluationWeights): number | null {
  if (status === "FAILED") return 0;
  if (status !== "SUCCEEDED") return null;
  return combineScores(partsFromEvaluations(evaluations), weights, 1).score;
}

/** Evaluation weights of a stored blueprint. A blueprint that fails to parse must not break scoring: defaults. */
export function weightsOfBlueprint(blueprint: unknown): EvaluationWeights {
  const parsed = safeParseBlueprint(blueprint);
  return parsed.success ? parsed.data.evaluation.weights : { ...DEFAULT_EVALUATION_WEIGHTS };
}

const EMPTY_PARTS: ScoreParts = { deterministic: [], judge: [], user: [] };

/**
 * Key the runtime sets to `true` on a run's ERROR step output when the model provider refused the setup (a rejected
 * key, no credits, no access, an unknown model id). Such a run still shows as failed, but it says nothing about
 * the worker's quality, so it is left out of the score and of the recent-failure health check.
 */
export const PROVIDER_SETUP_FAILURE_MARKER = "providerSetup";

/** Prisma filter for runs that count towards a worker's score and health. */
const COUNTS_TOWARDS_QUALITY = {
  status: { in: ["SUCCEEDED", "FAILED"] as RunStatus[] },
  steps: { none: { kind: "ERROR" as const, output: { path: [PROVIDER_SETUP_FAILURE_MARKER], equals: true } } },
};

/**
 * Current score of a worker over its last N finished runs (default: current version, last 10). Every FAILED run
 * contributes a 0 to the deterministic component so a worker that keeps crashing cannot hide behind a few good
 * deliverables. CANCELLED and unfinished runs are ignored, and so are runs the provider refused to serve
 * (PROVIDER_SETUP_FAILURE_MARKER).
 */
export async function computeWorkerScore(
  workerId: string,
  opts: { workerVersionId?: string; lastNRuns?: number } = {},
): Promise<WorkerScore> {
  const worker = await db.worker.findUnique({
    where: { id: workerId },
    select: { id: true, organizationId: true, currentVersionId: true },
  });
  if (!worker) throw notFound("Worker");

  const versionId = opts.workerVersionId ?? worker.currentVersionId;
  if (!versionId) return combineScores(EMPTY_PARTS, { ...DEFAULT_EVALUATION_WEIGHTS }, 0);

  const version = await db.workerVersion.findFirst({
    where: { id: versionId, workerId: worker.id },
    select: { blueprint: true },
  });
  if (!version) throw notFound("Worker version");
  const weights = weightsOfBlueprint(version.blueprint);

  const runs = await db.run.findMany({
    where: { organizationId: worker.organizationId, workerId: worker.id, workerVersionId: versionId, ...COUNTS_TOWARDS_QUALITY },
    orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: Math.max(1, Math.floor(opts.lastNRuns ?? DEFAULT_SCORE_RUN_WINDOW)),
    select: { id: true, status: true },
  });
  if (runs.length === 0) return combineScores(EMPTY_PARTS, weights, 0);

  const succeededIds = runs.filter((r) => r.status === "SUCCEEDED").map((r) => r.id);
  const evaluations =
    succeededIds.length === 0
      ? []
      : await db.evaluation.findMany({
          where: { organizationId: worker.organizationId, workerId: worker.id, runId: { in: succeededIds } },
          select: { type: true, score: true },
        });

  const parts = partsFromEvaluations(evaluations);
  for (const run of runs) if (run.status === "FAILED") parts.deterministic.push(0);
  return combineScores(parts, weights, runs.length);
}

/** Recompute the worker's score, cache it on the row, then re-assess health from it. */
export async function refreshWorkerScore(workerId: string): Promise<WorkerScore> {
  const score = await computeWorkerScore(workerId);
  await db.worker.update({
    where: { id: workerId },
    data: { score: score.score, scoreUpdatedAt: new Date() },
  });
  await refreshWorkerHealth(workerId);
  return score;
}

/**
 * Worker.health / healthReason from HEALTH_THRESHOLDS and the cached score. Retired workers keep the health
 * they had when they left — their record is history, not a live status.
 */
export async function refreshWorkerHealth(workerId: string): Promise<void> {
  const worker = await db.worker.findUnique({
    where: { id: workerId },
    select: { id: true, organizationId: true, status: true, score: true, currentVersionId: true },
  });
  if (!worker) throw notFound("Worker");
  if (worker.status === "RETIRED") return;

  const recent = worker.currentVersionId
    ? await db.run.findMany({
        where: {
          organizationId: worker.organizationId,
          workerId: worker.id,
          workerVersionId: worker.currentVersionId,
          ...COUNTS_TOWARDS_QUALITY,
        },
        orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take: Math.max(HEALTH_THRESHOLDS.recentRunWindow, HEALTH_THRESHOLDS.minRunsForHealth),
        select: { status: true },
      })
    : [];

  const verdict = assessHealth({
    score: worker.score,
    recentStatuses: recent.map((r) => r.status as FinishedStatus),
  });
  await db.worker.update({
    where: { id: worker.id },
    data: { health: verdict.health, healthReason: verdict.reason },
  });
}
