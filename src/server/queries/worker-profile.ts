import type {
  DeliverableFormat,
  DeliverableStatus,
  EvaluationType,
  ReviewRecommendation,
  RunStatus,
  RunTrigger,
  UserRole,
  VersionChangeReason,
  WorkerHealth,
  WorkerStatus,
} from "@prisma/client";
import { format } from "date-fns";
import { titleCase } from "@/lib/format";
import { listActivity, type ActivityItem } from "@/server/activity";
import { db } from "@/server/db";
import {
  describeCadence,
  safeParseBlueprint,
  workerFieldsToCadence,
  type DeliverableFormatSlug,
  type KpiActual,
  type ModelTier,
  type ReviewMetrics,
  type RunLimits,
  type WorkerBlueprint,
  type WorkerScore,
} from "@/server/domain";
import { notFound } from "@/server/errors";
import { computeWorkerScore, getWorkerMetrics } from "@/server/evaluation";
import { llm } from "@/server/models";
import { renderTitle } from "@/server/runtime";
import { tools } from "@/server/tools";
import { getWorkerCostSummary, type WorkerCostSummary } from "@/server/usage";
import { permissionSubset, WORKER_PERMISSION_KEYS, type WorkerPermissions } from "./permissions";

/**
 * Read models for /workers/[workerId] (header + overview · activity · deliverables · performance · cost tabs).
 * Every function takes the caller's organizationId first, verifies the worker belongs to it (→ NOT_FOUND
 * otherwise) and returns plain JSON: numbers for Decimals, ISO strings for Dates.
 */

const RECENT_RUNS = 5;
const RUNS_LIMIT = 50;
const ACTIVITY_LIMIT = 120;
const DELIVERABLES_LIMIT = 100;
const EVALUATIONS_LIMIT = 40;
const REVIEWS_LIMIT = 10;
const IN_FLIGHT: readonly RunStatus[] = ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"];

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

async function requireWorker(organizationId: string, workerId: string) {
  const worker = await db.worker.findFirst({
    where: { id: workerId, organizationId },
    select: {
      id: true,
      name: true,
      jobId: true,
      job: { select: { title: true } },
      currentVersionId: true,
      currentVersion: { select: { id: true, version: true, changeReason: true, activatedAt: true, blueprint: true } },
    },
  });
  if (!worker) throw notFound("Worker");
  return worker;
}

/** The version the worker runs under today — tabs compare reviews and metrics against it. */
export interface ActiveVersionRef {
  id: string;
  version: number;
  changeReason: VersionChangeReason;
  activatedAt: string | null;
}

function activeVersionOf(worker: Awaited<ReturnType<typeof requireWorker>>): ActiveVersionRef | null {
  const v = worker.currentVersion;
  return v ? { id: v.id, version: v.version, changeReason: v.changeReason, activatedAt: iso(v.activatedAt) } : null;
}

/** Records behind a deliverable, when `data` is the conventional array of flat objects. */
function recordCount(data: unknown): number | null {
  return Array.isArray(data) ? data.length : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ── Header ──────────────────────────────────────────────────────────────────

export interface WorkerHeaderView {
  id: string;
  name: string;
  title: string;
  avatarColor: string;
  status: WorkerStatus;
  health: WorkerHealth;
  healthReason: string | null;
  score: number | null;
  scoreUpdatedAt: string | null;
  hiredAt: string;
  retiredAt: string | null;
  lastRunAt: string | null;
  job: { id: string; title: string };
  /** Human schedule ("Weekly on Monday at 9am") + the next scheduled start, if any. */
  schedule: { kind: string; description: string; nextRunAt: string | null };
  currentVersion: { id: string; version: number; changeReason: VersionChangeReason; activatedAt: string | null } | null;
  /** Persona bio from the current blueprint. */
  summary: string | null;
  /** True when the platform has no live model provider (everything this worker does is simulated). */
  simulated: boolean;
  /** The newest run that is still going (queued, running or waiting on a human), for the live banner. */
  inFlightRun: { id: string; status: RunStatus; trigger: RunTrigger; createdAt: string } | null;
  /** Approvals this worker is waiting on right now. */
  pendingApprovals: number;
  /** An undecided replacement / spec-change proposal, if one exists. */
  openProposal: { versionId: string; version: number; changeReason: VersionChangeReason } | null;
  /** What the viewer's role may do with this worker; the server enforces the same rules regardless. */
  permissions: WorkerPermissions;
}

export async function getWorkerHeader(
  organizationId: string,
  workerId: string,
  opts: { role?: UserRole } = {},
): Promise<WorkerHeaderView> {
  const worker = await db.worker.findFirst({
    where: { id: workerId, organizationId },
    include: {
      job: { select: { id: true, title: true } },
      currentVersion: { select: { id: true, version: true, changeReason: true, activatedAt: true, blueprint: true } },
    },
  });
  if (!worker) throw notFound("Worker");

  const [inFlight, pendingApprovals, proposal] = await Promise.all([
    db.run.findFirst({
      where: { organizationId, workerId: worker.id, status: { in: [...IN_FLIGHT] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, trigger: true, createdAt: true },
    }),
    db.approval.count({ where: { organizationId, workerId: worker.id, status: "PENDING", run: { status: "WAITING_FOR_APPROVAL" } } }),
    db.workerVersion.findFirst({
      where: { workerId: worker.id, status: "PROPOSED" },
      orderBy: { version: "desc" },
      select: { id: true, version: true, changeReason: true },
    }),
  ]);

  const cadence = workerFieldsToCadence(worker);
  const blueprint = worker.currentVersion ? safeParseBlueprint(worker.currentVersion.blueprint) : null;

  return {
    id: worker.id,
    name: worker.name,
    title: worker.title,
    avatarColor: worker.avatarColor,
    status: worker.status,
    health: worker.health,
    healthReason: worker.healthReason,
    score: worker.score,
    scoreUpdatedAt: iso(worker.scoreUpdatedAt),
    hiredAt: worker.hiredAt.toISOString(),
    retiredAt: iso(worker.retiredAt),
    lastRunAt: iso(worker.lastRunAt),
    job: { id: worker.job.id, title: worker.job.title },
    schedule: { kind: cadence.kind, description: describeCadence(cadence), nextRunAt: iso(worker.nextRunAt) },
    currentVersion: worker.currentVersion
      ? {
          id: worker.currentVersion.id,
          version: worker.currentVersion.version,
          changeReason: worker.currentVersion.changeReason,
          activatedAt: iso(worker.currentVersion.activatedAt),
        }
      : null,
    summary: blueprint?.success ? blueprint.data.persona.summary : null,
    simulated: llm.isSimulated(),
    inFlightRun: inFlight ? { id: inFlight.id, status: inFlight.status, trigger: inFlight.trigger, createdAt: inFlight.createdAt.toISOString() } : null,
    pendingApprovals,
    openProposal: proposal ? { versionId: proposal.id, version: proposal.version, changeReason: proposal.changeReason } : null,
    permissions: permissionSubset(opts.role, WORKER_PERMISSION_KEYS),
  };
}

// ── Runs ────────────────────────────────────────────────────────────────────

export interface WorkerRunRow {
  id: string;
  status: RunStatus;
  trigger: RunTrigger;
  simulated: boolean;
  attempt: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Active executing time (ms) — null until the run finishes. */
  durationMs: number | null;
  costUsd: number;
  stepsCount: number;
  deliverableCount: number;
  /** Version that produced it ("v2"). */
  version: number;
}

export async function listWorkerRuns(organizationId: string, workerId: string, opts: { limit?: number } = {}): Promise<WorkerRunRow[]> {
  await requireWorker(organizationId, workerId);
  const rows = await db.run.findMany({
    where: { organizationId, workerId },
    orderBy: { createdAt: "desc" },
    take: Math.min(RUNS_LIMIT, Math.max(1, opts.limit ?? RUNS_LIMIT)),
    select: {
      id: true,
      status: true,
      trigger: true,
      simulated: true,
      attempt: true,
      error: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      costUsd: true,
      workerVersion: { select: { version: true } },
      _count: { select: { steps: true, deliverables: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    simulated: r.simulated,
    attempt: r.attempt,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationMs: r.durationMs,
    costUsd: Number(r.costUsd),
    stepsCount: r._count.steps,
    deliverableCount: r._count.deliverables,
    version: r.workerVersion.version,
  }));
}

// ── Activity ────────────────────────────────────────────────────────────────

export interface WorkerActivityDay {
  /** yyyy-MM-dd in server local time. */
  date: string;
  /** "Today" · "Yesterday" · "Sep 12, 2026". */
  label: string;
  items: ActivityItem[];
}

function dayLabel(date: Date, now: Date): string {
  const key = format(date, "yyyy-MM-dd");
  if (key === format(now, "yyyy-MM-dd")) return "Today";
  if (key === format(new Date(now.getTime() - 86_400_000), "yyyy-MM-dd")) return "Yesterday";
  return format(date, "EEEE, MMM d");
}

/** The worker's feed, newest first, grouped by local calendar day. Pure grouping — exported for tests. */
export function groupActivityByDay(items: ActivityItem[], now: Date = new Date()): WorkerActivityDay[] {
  const days: WorkerActivityDay[] = [];
  for (const item of items) {
    const at = new Date(item.createdAt);
    const date = format(at, "yyyy-MM-dd");
    const last = days[days.length - 1];
    if (last && last.date === date) last.items.push(item);
    else days.push({ date, label: dayLabel(at, now), items: [item] });
  }
  return days;
}

export async function listWorkerActivity(organizationId: string, workerId: string, opts: { limit?: number } = {}): Promise<WorkerActivityDay[]> {
  await requireWorker(organizationId, workerId);
  const items = await listActivity(organizationId, { workerId, limit: opts.limit ?? ACTIVITY_LIMIT });
  return groupActivityByDay(items);
}

// ── Deliverables ────────────────────────────────────────────────────────────

export interface WorkerDeliverableRow {
  id: string;
  title: string;
  summary: string | null;
  format: DeliverableFormat;
  status: DeliverableStatus;
  runId: string;
  createdAt: string;
  reviewedAt: string | null;
  feedback: string | null;
  recordCount: number | null;
  version: number;
}

export async function listWorkerDeliverables(
  organizationId: string,
  workerId: string,
  opts: { status?: DeliverableStatus; limit?: number } = {},
): Promise<WorkerDeliverableRow[]> {
  await requireWorker(organizationId, workerId);
  const rows = await db.deliverable.findMany({
    where: { organizationId, workerId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(DELIVERABLES_LIMIT, Math.max(1, opts.limit ?? DELIVERABLES_LIMIT)),
    select: {
      id: true,
      title: true,
      summary: true,
      format: true,
      status: true,
      runId: true,
      createdAt: true,
      reviewedAt: true,
      feedback: true,
      data: true,
      workerVersion: { select: { version: true } },
    },
  });
  return rows.map((d) => ({
    id: d.id,
    title: d.title,
    summary: d.summary,
    format: d.format,
    status: d.status,
    runId: d.runId,
    createdAt: d.createdAt.toISOString(),
    reviewedAt: iso(d.reviewedAt),
    feedback: d.feedback,
    recordCount: recordCount(d.data),
    version: d.workerVersion.version,
  }));
}

// ── Reviews & evaluations ───────────────────────────────────────────────────

export interface WorkerReviewRow {
  id: string;
  overallScore: number;
  summary: string;
  strengths: string[];
  problems: string[];
  recommendation: ReviewRecommendation;
  recommendationDetail: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  version: number;
  /**
   * False once the worker has moved to a newer version: the verdict describes a design that is no longer running,
   * so pages show it as history instead of repeating its "replace" / "improve" call-to-action.
   */
  forCurrentVersion: boolean;
}

export interface WorkerEvaluationRow {
  id: string;
  type: EvaluationType;
  /** 0..1 */
  score: number;
  passed: boolean;
  summary: string | null;
  runId: string | null;
  deliverableId: string | null;
  deliverableTitle: string | null;
  createdAt: string;
  simulated: boolean;
}

interface ReviewRecord {
  id: string;
  workerVersionId: string;
  overallScore: number;
  summary: string;
  strengths: unknown;
  problems: unknown;
  recommendation: ReviewRecommendation;
  recommendationDetail: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  workerVersion: { version: number };
}

function toReviewRow(r: ReviewRecord, currentVersionId: string | null): WorkerReviewRow {
  return {
    id: r.id,
    overallScore: r.overallScore,
    summary: r.summary,
    strengths: stringList(r.strengths),
    problems: stringList(r.problems),
    recommendation: r.recommendation,
    recommendationDetail: r.recommendationDetail,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    createdAt: r.createdAt.toISOString(),
    version: r.workerVersion.version,
    forCurrentVersion: currentVersionId !== null && r.workerVersionId === currentVersionId,
  };
}

async function listReviews(organizationId: string, workerId: string, currentVersionId: string | null, limit: number): Promise<WorkerReviewRow[]> {
  const rows = await db.workerReview.findMany({
    where: { organizationId, workerId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { workerVersion: { select: { version: true } } },
  });
  return rows.map((r) => toReviewRow(r, currentVersionId));
}

/** One review by id — used by the "Performance review" action to describe what it just generated. */
export async function getWorkerReview(organizationId: string, reviewId: string): Promise<WorkerReviewRow> {
  const row = await db.workerReview.findFirst({
    where: { id: reviewId, organizationId },
    include: { workerVersion: { select: { version: true } }, worker: { select: { currentVersionId: true } } },
  });
  if (!row) throw notFound("Performance review");
  return toReviewRow(row, row.worker.currentVersionId);
}

// ── Overview ────────────────────────────────────────────────────────────────

export interface PipelineStep {
  id: string;
  name: string;
  description: string;
  kind: "agent" | "deterministic";
  /** Agent steps only. */
  tier: ModelTier | null;
  /** Deterministic steps only ("validate_records"). */
  operation: string | null;
  tools: Array<{ name: string; label: string }>;
  inputKeys: string[];
  outputKey: string;
}

export interface WorkerOverviewView {
  summary: string | null;
  responsibilities: string[];
  jobFamily: string | null;
  pipeline: PipelineStep[];
  /**
   * `titleTemplate` is filled in the way the next run fills it ("… — 2026-09-28"): this view only ever shows it in a
   * sentence, and a raw `{{date}}` placeholder is not something a manager should read.
   */
  deliverable: { titleTemplate: string; format: DeliverableFormatSlug } | null;
  tools: Array<{ name: string; label: string; reason: string; requiresApproval: boolean }>;
  limits: RunLimits | null;
  /** KPI targets vs actuals over the metrics window (current version). */
  kpis: KpiActual[];
  metrics: Pick<ReviewMetrics, "windowDays" | "runs" | "succeeded" | "failed" | "deliverables" | "accepted" | "rejected" | "totalCostUsd" | "avgCostPerRunUsd">;
  recentRuns: WorkerRunRow[];
  latestDeliverable: WorkerDeliverableRow | null;
  /** Newest review across all versions — check `forCurrentVersion` before treating its verdict as current. */
  latestReview: WorkerReviewRow | null;
  activeVersion: ActiveVersionRef | null;
  cost: { estimatedPerRunUsd: number | null; estimatedMonthlyUsd: number | null; actualAvgPerRunUsd: number | null; runsPerMonth: number | null };
}

function toolLabel(name: string): string {
  return tools.get(name)?.displayName ?? name;
}

function pipelineOf(blueprint: WorkerBlueprint): PipelineStep[] {
  return blueprint.components.map((c) =>
    c.type === "agent"
      ? {
          id: c.id,
          name: c.name,
          description: c.description,
          kind: "agent" as const,
          tier: c.modelTier,
          operation: null,
          tools: c.tools.map((name) => ({ name, label: toolLabel(name) })),
          inputKeys: c.inputKeys,
          outputKey: c.outputKey,
        }
      : {
          id: c.id,
          name: c.name,
          description: c.description,
          kind: "deterministic" as const,
          tier: null,
          operation: c.operation,
          tools: [],
          inputKeys: c.inputKeys,
          outputKey: c.outputKey,
        },
  );
}

export async function getWorkerOverview(organizationId: string, workerId: string): Promise<WorkerOverviewView> {
  const worker = await requireWorker(organizationId, workerId);
  const parsed = worker.currentVersion ? safeParseBlueprint(worker.currentVersion.blueprint) : null;
  const blueprint = parsed?.success ? parsed.data : null;

  const [metrics, recentRuns, latestDeliverable, reviews] = await Promise.all([
    getWorkerMetrics(organizationId, worker.id),
    listWorkerRuns(organizationId, worker.id, { limit: RECENT_RUNS }),
    listWorkerDeliverables(organizationId, worker.id, { limit: 1 }),
    listReviews(organizationId, worker.id, worker.currentVersionId, 1),
  ]);

  return {
    summary: blueprint?.persona.summary ?? null,
    responsibilities: blueprint?.responsibilities ?? [],
    jobFamily: blueprint?.jobFamily ?? null,
    pipeline: blueprint ? pipelineOf(blueprint) : [],
    deliverable: blueprint
      ? { titleTemplate: renderTitle(blueprint.deliverable.titleTemplate, { jobTitle: worker.job.title, now: new Date() }), format: blueprint.deliverable.format }
      : null,
    tools: blueprint?.tools.map((t) => ({ name: t.toolName, label: toolLabel(t.toolName), reason: t.reason, requiresApproval: t.requiresApproval })) ?? [],
    limits: blueprint?.limits ?? null,
    kpis: metrics.kpis,
    metrics: {
      windowDays: metrics.windowDays,
      runs: metrics.runs,
      succeeded: metrics.succeeded,
      failed: metrics.failed,
      deliverables: metrics.deliverables,
      accepted: metrics.accepted,
      rejected: metrics.rejected,
      totalCostUsd: metrics.totalCostUsd,
      avgCostPerRunUsd: metrics.avgCostPerRunUsd,
    },
    recentRuns,
    latestDeliverable: latestDeliverable[0] ?? null,
    latestReview: reviews[0] ?? null,
    activeVersion: activeVersionOf(worker),
    cost: {
      estimatedPerRunUsd: blueprint?.costEstimate.perRunUsd ?? null,
      estimatedMonthlyUsd: blueprint?.costEstimate.monthlyUsd ?? null,
      actualAvgPerRunUsd: metrics.avgCostPerRunUsd,
      runsPerMonth: blueprint?.costEstimate.runsPerMonth ?? null,
    },
  };
}

// ── Performance ─────────────────────────────────────────────────────────────

export interface WorkerPerformanceView {
  score: WorkerScore;
  metrics: ReviewMetrics;
  evaluations: WorkerEvaluationRow[];
  /** Newest first, across versions; rows for earlier versions have `forCurrentVersion: false`. */
  reviews: WorkerReviewRow[];
  currentVersion: number | null;
  activeVersion: ActiveVersionRef | null;
  /** Evaluation weights the current blueprint asks for (before re-normalization over sources with data). */
  weights: { deterministic: number; judge: number; user: number } | null;
}

function judgeSimulated(details: unknown): boolean {
  return typeof details === "object" && details !== null && (details as { simulated?: unknown }).simulated === true;
}

export async function getWorkerPerformance(organizationId: string, workerId: string): Promise<WorkerPerformanceView> {
  const worker = await requireWorker(organizationId, workerId);
  const parsed = worker.currentVersion ? safeParseBlueprint(worker.currentVersion.blueprint) : null;

  const [score, metrics, evaluations, reviews] = await Promise.all([
    computeWorkerScore(worker.id),
    getWorkerMetrics(organizationId, worker.id),
    db.evaluation.findMany({
      where: { organizationId, workerId: worker.id },
      orderBy: { createdAt: "desc" },
      take: EVALUATIONS_LIMIT,
      select: {
        id: true,
        type: true,
        score: true,
        passed: true,
        summary: true,
        runId: true,
        deliverableId: true,
        details: true,
        createdAt: true,
        deliverable: { select: { title: true } },
      },
    }),
    listReviews(organizationId, worker.id, worker.currentVersionId, REVIEWS_LIMIT),
  ]);

  return {
    score,
    metrics,
    evaluations: evaluations.map((e) => ({
      id: e.id,
      type: e.type,
      score: e.score,
      passed: e.passed,
      summary: e.summary,
      runId: e.runId,
      deliverableId: e.deliverableId,
      deliverableTitle: e.deliverable?.title ?? null,
      createdAt: e.createdAt.toISOString(),
      simulated: e.type === "LLM_JUDGE" && judgeSimulated(e.details),
    })),
    reviews,
    currentVersion: worker.currentVersion?.version ?? null,
    activeVersion: activeVersionOf(worker),
    weights: parsed?.success ? parsed.data.evaluation.weights : null,
  };
}

// ── Cost ────────────────────────────────────────────────────────────────────

export interface WorkerCostResourceRow {
  /** Human name: the tool's registry displayName ("Notifications"), or the model id for models. */
  label: string;
  /** Raw ledger resource — tool registry name ("send_notification") or model id ("mock-standard"). */
  resource: string;
  kind: "MODEL" | "TOOL";
  calls: number;
  costUsd: number;
}

export interface WorkerCostView extends Omit<WorkerCostSummary, "byResource"> {
  byResource: WorkerCostResourceRow[];
  /** Blueprint's planned monthly spend for the current version. */
  estimatedMonthlyUsd: number | null;
  modelCostUsd: number;
  toolCostUsd: number;
  /** Share (0..1) of ledger spend in the window that came from simulated calls; 1 = nothing was really spent. */
  simulatedShare: number | null;
  simulated: boolean;
}

export async function getWorkerCost(organizationId: string, workerId: string, days?: number): Promise<WorkerCostView> {
  const worker = await requireWorker(organizationId, workerId);
  const summary = await getWorkerCostSummary(organizationId, worker.id, days);

  const since = new Date(Date.now() - summary.days * 86_400_000);
  const simulatedRows = await db.usageRecord.groupBy({
    by: ["simulated"],
    where: { organizationId, workerId: worker.id, occurredAt: { gte: since } },
    _sum: { costUsd: true },
  });
  let ledgerTotal = 0;
  let simulatedTotal = 0;
  for (const row of simulatedRows) {
    const cost = Number(row._sum.costUsd ?? 0);
    ledgerTotal += cost;
    if (row.simulated) simulatedTotal += cost;
  }

  const parsed = worker.currentVersion ? safeParseBlueprint(worker.currentVersion.blueprint) : null;
  const modelCostUsd = summary.byResource.filter((r) => r.kind === "MODEL").reduce((s, r) => s + r.costUsd, 0);
  const toolCostUsd = summary.byResource.filter((r) => r.kind === "TOOL").reduce((s, r) => s + r.costUsd, 0);

  return {
    ...summary,
    // The usage module labels rows with the raw ledger resource; tools read better by their registry name (as on /usage).
    byResource: summary.byResource.map((r) => ({
      ...r,
      resource: r.label,
      label: r.kind === "TOOL" ? (tools.get(r.label)?.displayName ?? titleCase(r.label)) : r.label,
    })),
    estimatedMonthlyUsd: parsed?.success ? parsed.data.costEstimate.monthlyUsd : null,
    modelCostUsd: Math.round(modelCostUsd * 1e6) / 1e6,
    toolCostUsd: Math.round(toolCostUsd * 1e6) / 1e6,
    simulatedShare: ledgerTotal > 0 ? Math.round((simulatedTotal / ledgerTotal) * 1e4) / 1e4 : null,
    simulated: llm.isSimulated(),
  };
}
