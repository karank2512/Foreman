import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunStatus } from "@prisma/client";
import { recordActivity, type ActivityItem } from "@/server/activity";
import { db, toJson } from "@/server/db";
import {
  getWorkerCost,
  getWorkerHeader,
  getWorkerOverview,
  getWorkerPerformance,
  getWorkerReview,
  groupActivityByDay,
  listWorkerActivity,
  listWorkerDeliverables,
  listWorkerRuns,
} from "@/server/queries/worker-profile";
import { tools } from "@/server/tools";
import { recordUsage } from "@/server/usage";
import { hireReplacement, proposeReplacement } from "@/server/workers";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker } from "../helpers/fixtures";

/**
 * Read models behind /workers/[workerId] (header + overview · activity · deliverables · performance · cost).
 * Rows are written directly with `db` so the suite never depends on the runtime; every function must be
 * org-scoped and return plain JSON (numbers, ISO strings) the tabs can hand to client leaves.
 */

type Hired = Awaited<ReturnType<typeof createHiredWorker>>;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function createRun(
  hired: Hired,
  opts: { status?: RunStatus; costUsd?: number; durationMs?: number | null; finishedAt?: Date | null; createdAt?: Date; error?: string; steps?: number } = {},
) {
  const status = opts.status ?? "SUCCEEDED";
  const terminal = status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
  const finishedAt = opts.finishedAt === undefined ? (terminal ? new Date() : null) : opts.finishedAt;
  const createdAt = opts.createdAt ?? finishedAt ?? new Date();
  const run = await db.run.create({
    data: {
      organizationId: hired.worker.organizationId,
      jobId: hired.job.id,
      workerId: hired.worker.id,
      workerVersionId: hired.version.id,
      status,
      trigger: "MANUAL",
      simulated: true,
      costUsd: opts.costUsd ?? 0.12,
      durationMs: opts.durationMs === undefined ? 45_000 : opts.durationMs,
      error: opts.error,
      createdAt,
      startedAt: createdAt,
      finishedAt,
    },
  });
  const steps = opts.steps ?? 0;
  if (steps > 0) {
    await db.runStep.createMany({
      data: Array.from({ length: steps }, (_, index) => ({
        runId: run.id,
        index,
        kind: "MODEL_CALL" as const,
        status: "SUCCEEDED" as const,
        title: `Step ${index + 1}`,
      })),
    });
  }
  return run;
}

async function createDeliverable(
  hired: Hired,
  runId: string,
  opts: { title?: string; status?: "PENDING_REVIEW" | "ACCEPTED" | "REJECTED"; feedback?: string; records?: number | null; createdAt?: Date } = {},
) {
  const records = opts.records === undefined ? 10 : opts.records;
  return db.deliverable.create({
    data: {
      organizationId: hired.worker.organizationId,
      jobId: hired.job.id,
      workerId: hired.worker.id,
      workerVersionId: hired.version.id,
      runId,
      title: opts.title ?? "Weekly AI Infra Funding Report",
      summary: "Ten funded startups, ranked by round size.",
      content: "# Report\n\n## Summary\n\nTen rounds.",
      format: "MARKDOWN",
      status: opts.status ?? "PENDING_REVIEW",
      feedback: opts.feedback,
      reviewedAt: opts.status && opts.status !== "PENDING_REVIEW" ? new Date() : null,
      createdAt: opts.createdAt ?? new Date(),
      ...(records === null ? {} : { data: toJson(Array.from({ length: records }, (_, i) => ({ company: `Company ${i}`, stage: "Seed" }))) }),
    },
  });
}

async function addEvaluations(hired: Hired, runId: string, deliverableId: string, det: number, judge: number, opts: { simulatedJudge?: boolean } = {}) {
  const base = { organizationId: hired.worker.organizationId, workerId: hired.worker.id, workerVersionId: hired.version.id, runId, deliverableId };
  await db.evaluation.create({ data: { ...base, type: "DETERMINISTIC", score: det, passed: det >= 0.7, summary: "3 of 4 checks passed" } });
  await db.evaluation.create({
    data: {
      ...base,
      type: "LLM_JUDGE",
      score: judge,
      passed: judge >= 0.7,
      summary: "Relevant and specific.",
      details: toJson({ kind: "llm_judge", criteria: [], overallReasoning: "ok", model: "mock-standard", simulated: opts.simulatedJudge ?? true }),
    },
  });
}

async function createReview(
  hired: Hired,
  recommendation: "KEEP" | "IMPROVE" | "REPLACE",
  overallScore: number,
  createdAt = new Date(),
  workerVersionId = hired.version.id,
) {
  return db.workerReview.create({
    data: {
      organizationId: hired.worker.organizationId,
      workerId: hired.worker.id,
      workerVersionId,
      periodStart: new Date(createdAt.getTime() - 30 * 86_400_000),
      periodEnd: createdAt,
      overallScore,
      summary: `${hired.worker.name} has been steady.`,
      strengths: toJson(["Cites sources", "Ranks by round size"]),
      problems: toJson(recommendation === "KEEP" ? [] : ["Misses required fields"]),
      recommendation,
      recommendationDetail: recommendation === "REPLACE" ? "Hire a replacement with validation steps." : "Keep going.",
      metrics: toJson({}),
      createdAt,
    },
  });
}

describe("queries/worker-profile", () => {
  let t: Awaited<ReturnType<typeof createTestOrg>>;
  let other: Awaited<ReturnType<typeof createTestOrg>>;

  beforeAll(async () => {
    t = await createTestOrg("worker-profile");
    other = await createTestOrg("worker-profile-other");
    // This suite seats far more workers than a default workspace may hire (Organization.maxActiveWorkers = 10),
    // and hireWorker / hireReplacement now enforce that ceiling.
    await db.organization.update({ where: { id: t.organization.id }, data: { maxActiveWorkers: 100 } });
  });
  afterAll(async () => {
    await t.cleanup();
    await other.cleanup();
  });

  describe("getWorkerHeader", () => {
    it("describes the worker, its schedule, version and simulated mode, and is org-scoped", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const header = await getWorkerHeader(t.organization.id, hired.worker.id);

      expect(header).toMatchObject({
        id: hired.worker.id,
        name: "Alex",
        title: "AI Market Researcher",
        avatarColor: "violet",
        status: "ACTIVE",
        health: "UNKNOWN",
        healthReason: null,
        score: null,
        job: { id: hired.job.id, title: hired.spec.title },
        schedule: { kind: "weekly", description: "Weekly on Monday at 9am", nextRunAt: null },
        currentVersion: { id: hired.version.id, version: 1, changeReason: "INITIAL_HIRE" },
        summary: hired.blueprint.persona.summary,
        simulated: true,
        inFlightRun: null,
        pendingApprovals: 0,
        openProposal: null,
      });
      expect(new Date(header.hiredAt).toISOString()).toBe(header.hiredAt);
      expect(header.retiredAt).toBeNull();
      expect(header.lastRunAt).toBeNull();

      await expect(getWorkerHeader(other.organization.id, hired.worker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(getWorkerHeader(t.organization.id, "wrk_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("surfaces the newest in-flight run, pending approvals and an open proposal", async () => {
      const hired = await createHiredWorker(t.organization.id);
      await createRun(hired, { status: "SUCCEEDED", finishedAt: minutesAgo(30) });
      const waiting = await createRun(hired, { status: "WAITING_FOR_APPROVAL", createdAt: minutesAgo(5) });
      const toolCall = await db.toolCall.create({
        data: { runId: waiting.id, workerId: hired.worker.id, toolName: "send_notification", input: toJson({ channel: "email" }), status: "PENDING_APPROVAL" },
      });
      await db.approval.create({
        data: {
          organizationId: t.organization.id,
          runId: waiting.id,
          workerId: hired.worker.id,
          toolCallId: toolCall.id,
          toolName: "send_notification",
          title: "Send the report",
          payload: toJson({}),
          status: "PENDING",
        },
      });
      const proposal = await db.workerVersion.create({
        data: { workerId: hired.worker.id, jobSpecId: hired.jobSpec.id, version: 2, status: "PROPOSED", changeReason: "REPLACEMENT", blueprint: toJson(hired.blueprint) },
      });

      const header = await getWorkerHeader(t.organization.id, hired.worker.id);
      expect(header.inFlightRun).toMatchObject({ id: waiting.id, status: "WAITING_FOR_APPROVAL", trigger: "MANUAL" });
      expect(header.pendingApprovals).toBe(1);
      expect(header.openProposal).toEqual({ versionId: proposal.id, version: 2, changeReason: "REPLACEMENT" });
    });
  });

  describe("listWorkerRuns", () => {
    it("lists newest first with numeric cost, step and deliverable counts, and honours the limit", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const older = await createRun(hired, { finishedAt: minutesAgo(60), costUsd: 0.25, steps: 4 });
      await createDeliverable(hired, older.id);
      const failed = await createRun(hired, { status: "FAILED", finishedAt: minutesAgo(20), error: "Run exceeded the cost limit", steps: 2 });
      const queued = await createRun(hired, { status: "QUEUED", createdAt: minutesAgo(1) });

      const rows = await listWorkerRuns(t.organization.id, hired.worker.id);
      expect(rows.map((r) => r.id)).toEqual([queued.id, failed.id, older.id]);
      expect(rows[2]).toMatchObject({ status: "SUCCEEDED", trigger: "MANUAL", simulated: true, costUsd: 0.25, stepsCount: 4, deliverableCount: 1, version: 1, durationMs: 45_000 });
      expect(rows[1]).toMatchObject({ status: "FAILED", error: "Run exceeded the cost limit", stepsCount: 2, deliverableCount: 0 });
      expect(rows[0].finishedAt).toBeNull();
      expect(typeof rows[2].costUsd).toBe("number");
      for (const r of rows) expect(new Date(r.createdAt).toISOString()).toBe(r.createdAt);

      expect(await listWorkerRuns(t.organization.id, hired.worker.id, { limit: 2 })).toHaveLength(2);
      await expect(listWorkerRuns(other.organization.id, hired.worker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("activity", () => {
    it("groups a feed by local day with Today / Yesterday labels (pure)", () => {
      const now = new Date(2026, 8, 20, 15, 0, 0); // Sep 20 2026, 3pm local
      const item = (id: string, at: Date): ActivityItem => ({
        id,
        type: "RUN_SUCCEEDED",
        title: "Alex finished a run",
        detail: null,
        actorType: "WORKER",
        actorName: "Alex",
        workerId: "w",
        jobId: null,
        runId: null,
        worker: null,
        metadata: {},
        createdAt: at.toISOString(),
        href: null,
      });
      const days = groupActivityByDay(
        [item("a", new Date(2026, 8, 20, 14)), item("b", new Date(2026, 8, 20, 9)), item("c", new Date(2026, 8, 19, 23)), item("d", new Date(2026, 8, 12, 8))],
        now,
      );
      expect(days.map((d) => [d.label, d.items.map((i) => i.id)])).toEqual([
        ["Today", ["a", "b"]],
        ["Yesterday", ["c"]],
        ["Saturday, Sep 12", ["d"]],
      ]);
      expect(groupActivityByDay([], now)).toEqual([]);
    });

    it("returns only this worker's events, newest first, with links", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const stranger = await createHiredWorker(t.organization.id, { name: "Maya" });
      const run = await createRun(hired, { finishedAt: minutesAgo(10) });
      await recordActivity({ organizationId: t.organization.id, type: "WORKER_HIRED", title: "Alex joined the team", workerId: hired.worker.id, actorType: "USER", actorName: "Test User" });
      await recordActivity({ organizationId: t.organization.id, type: "RUN_SUCCEEDED", title: "Alex finished a run", workerId: hired.worker.id, runId: run.id, actorType: "WORKER", actorName: "Alex" });
      await recordActivity({ organizationId: t.organization.id, type: "WORKER_HIRED", title: "Maya joined the team", workerId: stranger.worker.id });

      const days = await listWorkerActivity(t.organization.id, hired.worker.id);
      const items = days.flatMap((d) => d.items);
      expect(items.map((i) => i.title)).toEqual(["Alex finished a run", "Alex joined the team"]);
      expect(items[0].href).toBe(`/runs/${run.id}`);
      expect(days[0].label).toBe("Today");
      await expect(listWorkerActivity(other.organization.id, hired.worker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("listWorkerDeliverables", () => {
    it("lists newest first with record counts and filters by status", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const r1 = await createRun(hired, { finishedAt: minutesAgo(90) });
      const r2 = await createRun(hired, { finishedAt: minutesAgo(60) });
      const r3 = await createRun(hired, { finishedAt: minutesAgo(30) });
      const accepted = await createDeliverable(hired, r1.id, { status: "ACCEPTED", createdAt: minutesAgo(90), records: 12 });
      const rejected = await createDeliverable(hired, r2.id, { status: "REJECTED", feedback: "Too many gaps", createdAt: minutesAgo(60), records: null });
      const pending = await createDeliverable(hired, r3.id, { createdAt: minutesAgo(30), records: 7 });

      const all = await listWorkerDeliverables(t.organization.id, hired.worker.id);
      expect(all.map((d) => d.id)).toEqual([pending.id, rejected.id, accepted.id]);
      expect(all[0]).toMatchObject({ status: "PENDING_REVIEW", format: "MARKDOWN", runId: r3.id, recordCount: 7, version: 1, reviewedAt: null, feedback: null });
      expect(all[1]).toMatchObject({ status: "REJECTED", feedback: "Too many gaps", recordCount: null });
      expect(all[1].reviewedAt).not.toBeNull();
      expect(all[2].recordCount).toBe(12);

      expect((await listWorkerDeliverables(t.organization.id, hired.worker.id, { status: "ACCEPTED" })).map((d) => d.id)).toEqual([accepted.id]);
      expect(await listWorkerDeliverables(t.organization.id, hired.worker.id, { limit: 1 })).toHaveLength(1);
      await expect(listWorkerDeliverables(other.organization.id, hired.worker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("getWorkerOverview", () => {
    it("reads the blueprint into a pipeline with tiers and tool labels, plus KPIs, recent runs, latest deliverable and review", async () => {
      const hired = await createHiredWorker(t.organization.id, { withNotifier: true });
      for (let i = 0; i < 7; i++) await createRun(hired, { finishedAt: minutesAgo(100 - i * 10), costUsd: 0.2 });
      const latestRun = await createRun(hired, { finishedAt: minutesAgo(5), costUsd: 0.3 });
      const deliverable = await createDeliverable(hired, latestRun.id, { createdAt: minutesAgo(5) });
      await createReview(hired, "IMPROVE", 72, minutesAgo(200));
      const latestReview = await createReview(hired, "REPLACE", 55, minutesAgo(3));

      const o = await getWorkerOverview(t.organization.id, hired.worker.id);

      expect(o.summary).toBe(hired.blueprint.persona.summary);
      expect(o.responsibilities).toEqual(hired.blueprint.responsibilities);
      expect(o.jobFamily).toBe("market_research");
      expect(o.pipeline.map((s) => [s.id, s.kind, s.tier, s.operation])).toEqual([
        ["collector", "agent", "standard", null],
        ["validate_records", "deterministic", null, "validate_records"],
        ["dedupe", "deterministic", null, "dedupe"],
        ["rank", "deterministic", null, "rank"],
        ["analyst", "agent", "standard", null],
        ["compile_report", "deterministic", null, "compile_report"],
        ["notifier", "agent", "fast", null],
      ]);
      const collector = o.pipeline[0];
      expect(collector.tools.map((tool) => tool.name)).toEqual(["web_search", "fetch_url", "extract_data"]);
      expect(collector.tools.every((tool) => tool.label.length > 0 && tool.label !== tool.name)).toBe(true);
      expect(collector.inputKeys).toEqual(["job_brief", "instructions"]);
      expect(collector.outputKey).toBe("records");
      // The overview shows the title the way the next run writes it, never the raw {{date}} placeholder.
      expect(o.deliverable).toEqual({ titleTemplate: expect.stringMatching(/^Weekly AI Infra Funding Report — \d{4}-\d{2}-\d{2}$/), format: "markdown" });
      expect(o.tools.find((tool) => tool.name === "send_notification")).toMatchObject({ requiresApproval: true });
      expect(o.limits).toEqual(hired.blueprint.limits);

      expect(o.kpis.map((k) => k.kpiId)).toEqual(["acceptance", "coverage", "cost"]);
      expect(o.metrics).toMatchObject({ windowDays: 30, runs: 8, succeeded: 8, failed: 0, deliverables: 1 });
      expect(o.recentRuns).toHaveLength(5);
      expect(o.recentRuns[0].id).toBe(latestRun.id);
      expect(o.latestDeliverable).toMatchObject({ id: deliverable.id, runId: latestRun.id, recordCount: 10 });
      expect(o.latestReview).toMatchObject({
        id: latestReview.id,
        recommendation: "REPLACE",
        overallScore: 55,
        strengths: ["Cites sources", "Ranks by round size"],
        version: 1,
        forCurrentVersion: true,
      });
      expect(o.activeVersion).toEqual({ id: hired.version.id, version: 1, changeReason: "INITIAL_HIRE", activatedAt: expect.any(String) });
      expect(o.cost).toMatchObject({ estimatedPerRunUsd: 0.18, estimatedMonthlyUsd: 0.78, runsPerMonth: 4.33 });
      expect(o.cost.actualAvgPerRunUsd).toBeCloseTo((7 * 0.2 + 0.3) / 8, 4);
      await expect(getWorkerOverview(other.organization.id, hired.worker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("degrades gracefully for a worker without a current version", async () => {
      const hired = await createHiredWorker(t.organization.id);
      await db.worker.update({ where: { id: hired.worker.id }, data: { currentVersionId: null } });
      const o = await getWorkerOverview(t.organization.id, hired.worker.id);
      expect(o).toMatchObject({
        summary: null,
        responsibilities: [],
        pipeline: [],
        deliverable: null,
        tools: [],
        limits: null,
        recentRuns: [],
        latestDeliverable: null,
        latestReview: null,
        activeVersion: null,
      });
      expect(o.cost).toEqual({ estimatedPerRunUsd: null, estimatedMonthlyUsd: null, actualAvgPerRunUsd: null, runsPerMonth: null });
    });
  });

  describe("getWorkerPerformance", () => {
    it("combines score, metrics, evaluations (with the judge's simulated flag) and reviews", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const r1 = await createRun(hired, { finishedAt: minutesAgo(40), costUsd: 0.4, durationMs: 60_000 });
      const d1 = await createDeliverable(hired, r1.id, { status: "ACCEPTED", createdAt: minutesAgo(40) });
      await addEvaluations(hired, r1.id, d1.id, 1, 0.9, { simulatedJudge: true });
      const r2 = await createRun(hired, { finishedAt: minutesAgo(20), costUsd: 0.2, durationMs: 30_000 });
      const d2 = await createDeliverable(hired, r2.id, { status: "REJECTED", feedback: "Gaps", createdAt: minutesAgo(20) });
      await addEvaluations(hired, r2.id, d2.id, 0.5, 0.5, { simulatedJudge: false });
      const review = await createReview(hired, "KEEP", 84);

      const p = await getWorkerPerformance(t.organization.id, hired.worker.id);

      expect(p.currentVersion).toBe(1);
      expect(p.weights).toEqual(hired.blueprint.evaluation.weights);
      expect(p.score.sampleSize.runs).toBe(2);
      expect(p.score.score).not.toBeNull();
      expect(p.score.components.deterministic).toBeCloseTo(0.75, 4);
      expect(p.score.components.judge).toBeCloseTo(0.7, 4);
      expect(p.metrics).toMatchObject({ runs: 2, succeeded: 2, deliverables: 2, accepted: 1, rejected: 1, acceptanceRate: 0.5, successRate: 1 });
      expect(p.metrics.scoreTrend.map((s) => s.runId)).toEqual([r1.id, r2.id]);

      expect(p.evaluations).toHaveLength(4);
      const judgeRows = p.evaluations.filter((e) => e.type === "LLM_JUDGE");
      expect(judgeRows.map((e) => [e.runId, e.simulated]).sort()).toEqual([[r1.id, true], [r2.id, false]].sort());
      expect(p.evaluations.every((e) => e.type === "LLM_JUDGE" || e.simulated === false)).toBe(true);
      expect(p.evaluations.find((e) => e.deliverableId === d1.id)).toMatchObject({ deliverableTitle: "Weekly AI Infra Funding Report", passed: true });
      for (const e of p.evaluations) expect(new Date(e.createdAt).toISOString()).toBe(e.createdAt);

      expect(p.reviews).toHaveLength(1);
      expect(p.reviews[0]).toMatchObject({ id: review.id, recommendation: "KEEP", overallScore: 84, problems: [], version: 1, forCurrentVersion: true });
      expect(p.activeVersion).toMatchObject({ id: hired.version.id, version: 1, changeReason: "INITIAL_HIRE" });
      await expect(getWorkerPerformance(other.organization.id, hired.worker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns an empty, null-safe view for a worker that has never run", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const p = await getWorkerPerformance(t.organization.id, hired.worker.id);
      expect(p.score.score).toBeNull();
      expect(p.metrics.scoreTrend).toEqual([]);
      expect(p.evaluations).toEqual([]);
      expect(p.reviews).toEqual([]);
    });
  });

  describe("reviews after a replacement", () => {
    it("treats the replaced version's verdict as history, and a review of the new version as current again", async () => {
      const hired = await createHiredWorker(t.organization.id, { userId: t.user.id });
      const oldReview = await createReview(hired, "REPLACE", 53, minutesAgo(60));
      expect((await getWorkerOverview(t.organization.id, hired.worker.id)).latestReview).toMatchObject({ id: oldReview.id, forCurrentVersion: true });

      const { versionId } = await proposeReplacement(t.session, hired.worker.id);
      // A proposal is not live yet: the v1 verdict still describes how the worker works today.
      expect((await getWorkerOverview(t.organization.id, hired.worker.id)).latestReview?.forCurrentVersion).toBe(true);
      await hireReplacement(t.session, versionId, { startFirstRun: false });

      const o = await getWorkerOverview(t.organization.id, hired.worker.id);
      expect(o.activeVersion).toEqual({ id: versionId, version: 2, changeReason: "REPLACEMENT", activatedAt: expect.any(String) });
      // Still the newest review, but about v1 — the overview must not keep saying "Time to replace".
      expect(o.latestReview).toMatchObject({ id: oldReview.id, version: 1, recommendation: "REPLACE", forCurrentVersion: false });

      let p = await getWorkerPerformance(t.organization.id, hired.worker.id);
      expect(p.currentVersion).toBe(2);
      expect(p.activeVersion).toMatchObject({ id: versionId, version: 2, changeReason: "REPLACEMENT" });
      expect(p.reviews.map((r) => [r.id, r.version, r.forCurrentVersion])).toEqual([[oldReview.id, 1, false]]);
      expect((await getWorkerReview(t.organization.id, oldReview.id)).forCurrentVersion).toBe(false);

      const newReview = await createReview(hired, "KEEP", 97, new Date(), versionId);
      p = await getWorkerPerformance(t.organization.id, hired.worker.id);
      expect(p.reviews.map((r) => [r.id, r.version, r.forCurrentVersion])).toEqual([
        [newReview.id, 2, true],
        [oldReview.id, 1, false],
      ]);
      expect((await getWorkerOverview(t.organization.id, hired.worker.id)).latestReview).toMatchObject({ id: newReview.id, forCurrentVersion: true });
      expect((await getWorkerReview(t.organization.id, newReview.id)).forCurrentVersion).toBe(true);
    });
  });

  describe("getWorkerReview", () => {
    it("returns one review by id, org-scoped", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const review = await createReview(hired, "REPLACE", 40);
      expect(await getWorkerReview(t.organization.id, review.id)).toMatchObject({ id: review.id, recommendation: "REPLACE", overallScore: 40, strengths: ["Cites sources", "Ranks by round size"] });
      await expect(getWorkerReview(other.organization.id, review.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("getWorkerCost", () => {
    it("adds model/tool split, simulated share and the blueprint's monthly estimate to the usage summary", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const run = await createRun(hired, { finishedAt: minutesAgo(10), costUsd: 0 });
      const base = { organizationId: t.organization.id, workerId: hired.worker.id, jobId: hired.job.id, runId: run.id };
      await recordUsage({ ...base, kind: "MODEL", provider: "mock", resource: "mock-standard", inputTokens: 1000, outputTokens: 200, costUsd: 0.03, simulated: true });
      await recordUsage({ ...base, kind: "MODEL", provider: "mock", resource: "mock-fast", inputTokens: 500, outputTokens: 50, costUsd: 0.01, simulated: true });
      await recordUsage({ ...base, kind: "TOOL", provider: "tool", resource: "web_search", costUsd: 0.01, simulated: false });

      const c = await getWorkerCost(t.organization.id, hired.worker.id);
      // Tools read by their registry name (as on /usage), keeping the id for the mono sub-label; models stay as-is.
      expect(c.byResource.find((r) => r.kind === "TOOL")).toMatchObject({ resource: "web_search", label: tools.get("web_search")!.displayName });
      expect(tools.get("web_search")!.displayName).not.toBe("web_search");
      expect(c.byResource.find((r) => r.resource === "mock-standard")).toMatchObject({ kind: "MODEL", label: "mock-standard" });

      expect(c.days).toBe(30);
      expect(c.runs).toBe(1);
      expect(c.totalCostUsd).toBeCloseTo(0.05, 6);
      expect(c.modelCostUsd).toBeCloseTo(0.04, 6);
      expect(c.toolCostUsd).toBeCloseTo(0.01, 6);
      expect(c.simulatedShare).toBeCloseTo(0.8, 4);
      expect(c.simulated).toBe(true);
      expect(c.estimatedPerRunUsd).toBe(0.18);
      expect(c.estimatedMonthlyUsd).toBe(0.78);
      expect(c.avgCostPerRunUsd).toBeCloseTo(0.05, 6); // recordUsage rolls the cost up into Run.costUsd
      expect(c.byDay).toHaveLength(30);
      expect(c.byDay.at(-1)?.costUsd).toBeCloseTo(0.05, 6);
      expect(c.byVersion).toEqual([{ workerVersionId: hired.version.id, version: 1, runs: 1, totalCostUsd: 0.05, avgCostPerRunUsd: 0.05 }]);
      expect(c.byResource.map((r) => [r.kind, r.label, r.calls])).toEqual(
        expect.arrayContaining([
          ["MODEL", expect.any(String), 1],
          ["TOOL", expect.any(String), 1],
        ]),
      );

      expect((await getWorkerCost(t.organization.id, hired.worker.id, 7)).days).toBe(7);
      await expect(getWorkerCost(other.organization.id, hired.worker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("falls back to a title-cased label for a tool the registry no longer knows", async () => {
      const hired = await createHiredWorker(t.organization.id);
      await recordUsage({ organizationId: t.organization.id, workerId: hired.worker.id, jobId: hired.job.id, kind: "TOOL", provider: "tool", resource: "legacy_scraper", costUsd: 0.002, simulated: false });
      const c = await getWorkerCost(t.organization.id, hired.worker.id);
      expect(c.byResource).toEqual([{ kind: "TOOL", resource: "legacy_scraper", label: "Legacy Scraper", calls: 1, costUsd: 0.002 }]);
    });

    it("reports a null simulated share when nothing was spent", async () => {
      const hired = await createHiredWorker(t.organization.id);
      const c = await getWorkerCost(t.organization.id, hired.worker.id);
      expect(c.totalCostUsd).toBe(0);
      expect(c.simulatedShare).toBeNull();
      expect(c.modelCostUsd).toBe(0);
      expect(c.toolCostUsd).toBe(0);
    });
  });
});
