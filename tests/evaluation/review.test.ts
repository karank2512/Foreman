import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listActivity } from "@/server/activity";
import { db } from "@/server/db";
import { ReviewMetricsSchema, ReviewNarrativeSchema, type ReviewMetrics, type WorkerScore } from "@/server/domain/evaluation";
import { generatePerformanceReview, recommendFromMetrics } from "@/server/evaluation";
import { emptyMetrics } from "@/server/evaluation/metrics";
import { mockReviewNarrative, type ReviewEvidence } from "@/server/evaluation/review-mock";
import { normalizeReviewNarrative } from "@/server/evaluation/review";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker } from "../helpers/fixtures";
import { createRun, createRunWithDeliverable, goodRecords, goodReport, poorRecords, poorReport, type Hired } from "./helpers";

function metrics(overrides: Partial<ReviewMetrics> = {}): ReviewMetrics {
  return { ...emptyMetrics(30), ...overrides };
}

function workerScore(score: number | null): WorkerScore {
  return {
    score,
    components: { deterministic: score === null ? null : score / 100, judge: score === null ? null : score / 100, user: null },
    weightsUsed: { deterministic: 0.5, judge: 0.5, user: 0 },
    sampleSize: { deterministic: 3, judge: 3, user: 0, runs: 3 },
  };
}

function evidence(score: number | null, m: Partial<ReviewMetrics> = {}, extra: Partial<ReviewEvidence> = {}): ReviewEvidence {
  return { workerName: "Sam", jobTitle: "Competitor pricing tracker", metrics: metrics(m), score: workerScore(score), rejectedFeedback: [], failedRunErrors: [], ...extra };
}

describe("evaluation: review recommendation bands (pure)", () => {
  it.each([
    { score: 40, runs: 5, failed: 0, expected: "REPLACE" },
    { score: 64.9, runs: 5, failed: 0, expected: "REPLACE" },
    { score: 65, runs: 5, failed: 0, expected: "IMPROVE" },
    { score: 79.9, runs: 5, failed: 0, expected: "IMPROVE" },
    { score: 80, runs: 5, failed: 0, expected: "KEEP" },
    { score: 95, runs: 5, failed: 0, expected: "KEEP" },
    { score: 95, runs: 5, failed: 3, expected: "REPLACE" }, // 60% failure rate
    { score: 95, runs: 5, failed: 2, expected: "KEEP" }, // 40% is not above the limit
    { score: 95, runs: 1, failed: 1, expected: "KEEP" }, // too few runs to judge failures
    { score: null, runs: 0, failed: 0, expected: "KEEP" },
    { score: null, runs: 2, failed: 2, expected: "REPLACE" },
  ])("score $score, $failed/$runs failed → $expected", ({ score, runs, failed, expected }) => {
    const verdict = recommendFromMetrics(score, metrics({ runs, failed, succeeded: runs - failed }));
    expect(verdict.recommendation).toBe(expected);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("writes a narrative with the actual numbers and quotes rejected-deliverable feedback", () => {
    const narrative = mockReviewNarrative(
      evidence(
        52,
        {
          runs: 8,
          succeeded: 6,
          failed: 2,
          successRate: 0.75,
          deliverables: 6,
          accepted: 3,
          rejected: 3,
          acceptanceRate: 0.5,
          avgJudgeScore: 0.55,
          avgDeterministicScore: 0.6,
          avgRecordsPerRun: 6,
          avgCostPerRunUsd: 0.31,
          totalCostUsd: 2.48,
          kpis: [
            { kpiId: "coverage", name: "Records per report", metric: "records_per_run", unit: "records", target: 10, actual: 6, met: false, direction: "higher_is_better" },
            { kpiId: "cost", name: "Cost per run", metric: "cost_per_run_usd", unit: "$", target: 0.5, actual: 0.31, met: true, direction: "lower_is_better" },
          ],
        },
        {
          rejectedFeedback: [{ title: "Pricing snapshot — Sep 10", feedback: "Half the competitors are missing their enterprise tier." }],
          failedRunErrors: ["Run exceeded the cost limit of $0.50", "Run exceeded the cost limit of $0.50"],
        },
      ),
    );
    expect(ReviewNarrativeSchema.parse(narrative)).toEqual(narrative);
    expect(narrative.recommendation).toBe("REPLACE");
    expect(narrative.summary).toContain("Sam completed 8 runs in the last 30 days (6 succeeded, 2 failed)");
    expect(narrative.summary).toContain("6 deliverables (3 accepted, 3 sent back)");
    expect(narrative.summary).toContain("Overall quality score: 52/100");
    expect(narrative.problems).toContain("2 of 8 runs failed because they hit their cost limit");
    expect(narrative.problems.join(" ")).not.toContain("Run exceeded");
    expect(narrative.problems.some((p) => p.includes("Half the competitors are missing their enterprise tier."))).toBe(true);
    expect(narrative.problems).toContain("Records per report at 6 records misses the target of 10 records");
    expect(narrative.strengths).toContain("Cost per run at $0.31 meets the target of $0.50");
    expect(narrative.summary).toContain("Runs cost $0.31 on average.");
    expect(narrative.recommendationDetail).toContain("Replace Sam because the quality score of 52 is below the 65 threshold");
    expect(narrative.strengths.length).toBeLessThanOrEqual(6);
    expect(narrative.problems.length).toBeLessThanOrEqual(6);
  });

  it("praises a strong record and recommends KEEP; IMPROVE names the band", () => {
    const keep = mockReviewNarrative(
      evidence(91, { runs: 8, succeeded: 8, failed: 0, successRate: 1, deliverables: 8, accepted: 7, rejected: 0, acceptanceRate: 1, avgJudgeScore: 0.92 }),
    );
    expect(keep.recommendation).toBe("KEEP");
    expect(keep.strengths).toContain("Accepted 7 of 7 reviewed deliverables");
    expect(keep.strengths).toContain("8 of 8 runs completed without a failure");
    expect(keep.problems).toEqual([]);
    expect(keep.recommendationDetail).toContain("Keep Sam as is");

    const improve = mockReviewNarrative(evidence(72, { runs: 4, succeeded: 4, failed: 0, successRate: 1 }));
    expect(improve.recommendation).toBe("IMPROVE");
    expect(improve.recommendationDetail).toContain("65–80 band");

    const empty = mockReviewNarrative(evidence(null));
    expect(empty.recommendation).toBe("KEEP");
    expect(empty.summary).toContain("no finished runs in the last 30 days");
    expect(empty.problems).toEqual(["No finished runs in the last 30 days"]);
  });

  it("normalizeReviewNarrative clamps lists to 6 and upper-cases the recommendation", () => {
    const raw = { summary: "s", strengths: Array.from({ length: 9 }, (_, i) => ` s${i} `), problems: ["", 3, "p"], recommendation: " keep ", recommendationDetail: "d" };
    const parsed = ReviewNarrativeSchema.parse(normalizeReviewNarrative(raw));
    expect(parsed.strengths).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    expect(parsed.problems).toEqual(["p"]);
    expect(parsed.recommendation).toBe("KEEP");
    expect(normalizeReviewNarrative("nope")).toBe("nope");
  });
});

describe("evaluation: generatePerformanceReview", () => {
  let t: Awaited<ReturnType<typeof createTestOrg>>;
  let other: Awaited<ReturnType<typeof createTestOrg>>;
  beforeAll(async () => {
    t = await createTestOrg("eval-review");
    other = await createTestOrg("eval-review-other");
  });
  afterAll(async () => {
    await t.cleanup();
    await other.cleanup();
  });

  async function evaluated(hired: Hired, runId: string, deliverableId: string, det: number, judge: number) {
    const base = { organizationId: hired.worker.organizationId, workerId: hired.worker.id, workerVersionId: hired.version.id, runId, deliverableId };
    await db.evaluation.create({ data: { ...base, type: "DETERMINISTIC", score: det, passed: det >= 0.7 } });
    await db.evaluation.create({ data: { ...base, type: "LLM_JUDGE", score: judge, passed: judge >= 0.7 } });
  }

  it("persists a WorkerReview with metrics, score and a REPLACE recommendation for a struggling worker", async () => {
    const hired = await createHiredWorker(t.organization.id, { name: "Sam", collectorTier: "fast", withCleaning: false });
    const now = Date.now();
    const r1 = await createRunWithDeliverable(hired, { finishedAt: new Date(now - 4000) }, { data: poorRecords(), content: poorReport(), status: "REJECTED", feedback: "Half the rows have no amount." });
    await evaluated(hired, r1.run.id, r1.deliverable.id, 0.5, 0.45);
    const r2 = await createRunWithDeliverable(hired, { finishedAt: new Date(now - 3000) }, { data: poorRecords(), content: poorReport(), status: "REJECTED", feedback: "Still missing amounts and sources." });
    await evaluated(hired, r2.run.id, r2.deliverable.id, 0.55, 0.5);
    await createRun(hired, { status: "FAILED", finishedAt: new Date(now - 2000), error: "Run exceeded the cost limit" });
    await createRun(hired, { status: "FAILED", finishedAt: new Date(now - 1000), error: "Run exceeded the cost limit" });

    const { reviewId } = await generatePerformanceReview(t.session, hired.worker.id);
    const review = await db.workerReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review).toMatchObject({
      organizationId: t.organization.id,
      workerId: hired.worker.id,
      workerVersionId: hired.version.id,
      recommendation: "REPLACE",
      requestedById: t.user.id,
    });
    expect(review.overallScore).toBeLessThan(65);
    expect(review.periodEnd.getTime() - review.periodStart.getTime()).toBe(30 * 86_400_000);
    const storedMetrics = ReviewMetricsSchema.parse(review.metrics);
    expect(storedMetrics).toMatchObject({ runs: 4, succeeded: 2, failed: 2, rejected: 2, acceptanceRate: 0 });
    expect(review.summary).toContain("Sam completed 4 runs in the last 30 days (2 succeeded, 2 failed)");
    const problems = review.problems as string[];
    expect(problems).toContain("2 of 4 runs failed because they hit their cost limit");
    expect(`${problems.join(" ")} ${review.recommendationDetail}`).not.toContain("Run exceeded");
    expect(problems.some((p) => p.includes("Still missing amounts and sources."))).toBe(true);
    expect(review.recommendationDetail).toContain("Replace Sam because");

    // Model call attributed to the worker/job; worker score + health refreshed as a side effect.
    const call = await db.modelCall.findFirst({ where: { organizationId: t.organization.id, workerId: hired.worker.id, purpose: "review.narrative" } });
    expect(call).toMatchObject({ tier: "standard", simulated: true, jobId: hired.job.id });
    const worker = await db.worker.findUniqueOrThrow({ where: { id: hired.worker.id } });
    expect(worker.score).toBe(review.overallScore);
    expect(worker.health).toBe("NEEDS_ATTENTION");

    const [event] = await listActivity(t.organization.id, { workerId: hired.worker.id, types: ["REVIEW_GENERATED"] });
    expect(event).toMatchObject({
      actorType: "USER",
      actorName: "Test User",
      jobId: hired.job.id,
      metadata: { reviewId, recommendation: "REPLACE" },
      href: `/workers/${hired.worker.id}`,
    });
    expect(event.title).toBe("Test User reviewed Sam’s performance — recommendation: replace");
  });

  it("recommends KEEP for a strong worker and refuses to review a worker with no score yet", async () => {
    const strong = await createHiredWorker(t.organization.id);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const r = await createRunWithDeliverable(strong, { finishedAt: new Date(now - (3 - i) * 1000) }, { data: goodRecords(), content: goodReport(), status: "ACCEPTED" });
      await evaluated(strong, r.run.id, r.deliverable.id, 1, 0.9);
    }
    const keep = await db.workerReview.findUniqueOrThrow({ where: { id: (await generatePerformanceReview(t.session, strong.worker.id)).reviewId } });
    expect(keep.recommendation).toBe("KEEP");
    expect(keep.overallScore).toBeGreaterThan(90);
    expect(keep.strengths as string[]).toContain("Accepted 3 of 3 reviewed deliverables");

    const event = await db.activityEvent.findFirstOrThrow({ where: { organizationId: t.organization.id, workerId: strong.worker.id, type: "REVIEW_GENERATED" } });
    expect(event.detail).toBe(`Score ${Math.round(keep.overallScore)}/100 over the last 3 finished runs`);

    // Not rated is not 0/100: no review is stored (and nothing claims the worker is underperforming).
    const fresh = await createHiredWorker(t.organization.id);
    await expect(generatePerformanceReview(t.session, fresh.worker.id)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("no evaluated runs yet") });
    expect(await db.workerReview.count({ where: { workerId: fresh.worker.id } })).toBe(0);
  });

  it("is org-scoped and refuses a worker without an active version", async () => {
    const hired = await createHiredWorker(t.organization.id);
    await expect(generatePerformanceReview(other.session, hired.worker.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.worker.update({ where: { id: hired.worker.id }, data: { currentVersionId: null } });
    await expect(generatePerformanceReview(t.session, hired.worker.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
