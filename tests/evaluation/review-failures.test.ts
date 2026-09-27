import { describe, expect, it } from "vitest";
import type { ReviewMetrics, WorkerScore } from "@/server/domain/evaluation";
import { emptyMetrics } from "@/server/evaluation/metrics";
import { describeRunFailure, mockReviewNarrative, type ReviewEvidence } from "@/server/evaluation/review-mock";

/** The exact shapes the runtime writes to Run.error (runtime/limits, agent-loop, finish, context, queue, models). */
const ERRORS = {
  json: "Researcher did not return valid JSON: no valid JSON array or object was found in the answer",
  toolLimit: "The run would exceed its limit of 30 tool calls (28 used, 3 more requested)",
  toolLimitOther: "The run would exceed its limit of 30 tool calls (29 used, 2 more requested)",
  cost: "The run exceeded its $0.50 cost limit ($0.52 spent)",
  time: "The run exceeded its 300s time limit (312s of active work)",
  turns: "Researcher could not finish within 12 turns",
  noDeliverable: 'No deliverable was produced: the context key "report" is empty',
  setup: "The worker’s blueprint is invalid: Required; Expected array, received string",
  interrupted: "The executor stopped responding mid-run and no attempts remain",
  provider: "OpenAI could not complete the request (429)",
  repair: "The model could not produce a valid WorkerBlueprint after one correction",
  step: "Compile report failed: Cannot read properties of undefined (reading 'map')",
  unknown: "ECONNRESET socket hang up at TLSSocket.onConnectEnd",
};

function evidence(m: Partial<ReviewMetrics>, failedRunErrors: string[], score: number | null = 90): ReviewEvidence {
  const workerScore: WorkerScore = {
    score,
    components: { deterministic: score === null ? null : score / 100, judge: null, user: null },
    weightsUsed: { deterministic: 1, judge: 0, user: 0 },
    sampleSize: { deterministic: 3, judge: 0, user: 0, runs: 3 },
  };
  return { workerName: "Sam", jobTitle: "Competitor pricing tracker", metrics: { ...emptyMetrics(30), ...m }, score: workerScore, rejectedFeedback: [], failedRunErrors };
}

const failureLine = (e: ReviewEvidence) => mockReviewNarrative(e).problems.find((p) => / runs? failed/.test(p));

describe("evaluation: failed runs are described by cause, never by raw error text", () => {
  it.each([
    [ERRORS.json, "the Researcher returned unreadable results", "the Researcher returned unreadable results"],
    [ERRORS.toolLimit, "it hit its tool-use limit", "they hit their tool-use limit"],
    ["The run would exceed its limit of 1 tool call (1 used, 1 more requested)", "it hit its tool-use limit", "they hit their tool-use limit"],
    [ERRORS.cost, "it hit its cost limit", "they hit their cost limit"],
    [ERRORS.time, "it hit its time limit", "they hit their time limit"],
    [ERRORS.turns, "the Researcher ran out of steps before finishing", "the Researcher ran out of steps before finishing"],
    [ERRORS.noDeliverable, "it finished without producing a deliverable", "they finished without producing a deliverable"],
    [ERRORS.setup, "its setup could not be loaded", "their setup could not be loaded"],
    [ERRORS.interrupted, "it was interrupted mid-run", "they were interrupted mid-run"],
    [ERRORS.provider, "the AI model was unavailable", "the AI model was unavailable"],
    [ERRORS.repair, "the AI model returned unreadable results", "the AI model returned unreadable results"],
    [ERRORS.step, "the Compile report step could not process its input", "the Compile report step could not process its input"],
    [ERRORS.unknown, "it ran into an unexpected error", "they ran into an unexpected error"],
    ["unknown error", "it ran into an unexpected error", "they ran into an unexpected error"],
    ["", "it ran into an unexpected error", "they ran into an unexpected error"],
  ])("%s", (raw, one, many) => {
    expect(describeRunFailure(raw)).toMatchObject({ one, many });
  });

  it("names the cause with the counts, grouping messages that differ only in their numbers", () => {
    expect(failureLine(evidence({ runs: 6, succeeded: 4, failed: 2 }, [ERRORS.toolLimit, ERRORS.toolLimitOther]))).toBe(
      "2 of 6 runs failed because they hit their tool-use limit",
    );
    expect(failureLine(evidence({ runs: 5, succeeded: 4, failed: 1 }, [ERRORS.cost]))).toBe("1 of 5 runs failed because it hit its cost limit");
    expect(failureLine(evidence({ runs: 1, succeeded: 0, failed: 1 }, [ERRORS.json]))).toBe("1 of 1 run failed because the Researcher returned unreadable results");
  });

  it("splits mixed causes (most frequent first) and says when the evidence covers only the latest failures", () => {
    expect(failureLine(evidence({ runs: 8, succeeded: 5, failed: 3 }, [ERRORS.toolLimit, ERRORS.json, ERRORS.toolLimitOther]))).toBe(
      "3 of 8 runs failed — 2 because they hit their tool-use limit and 1 because the Researcher returned unreadable results",
    );
    expect(failureLine(evidence({ runs: 12, succeeded: 5, failed: 7 }, Array(5).fill(ERRORS.cost)))).toBe(
      "7 of 12 runs failed — the last 5 because they hit their cost limit",
    );
    expect(failureLine(evidence({ runs: 20, succeeded: 11, failed: 9 }, [ERRORS.cost, ERRORS.json, ERRORS.cost, ERRORS.time, ERRORS.unknown]))).toBe(
      "9 of 20 runs failed — of the last 5, 2 because they hit their cost limit, 1 because the Researcher returned unreadable results and 2 for other reasons",
    );
    expect(failureLine(evidence({ runs: 5, succeeded: 3, failed: 2 }, []))).toBe("2 of 5 runs failed");
  });

  it("keeps raw error text out of the whole narrative, including the recommendation's “Start with”", () => {
    const all = Object.values(ERRORS);
    const narrative = mockReviewNarrative(evidence({ runs: 5, succeeded: 2, failed: 3 }, [ERRORS.toolLimit, ERRORS.toolLimitOther, ERRORS.step]));
    expect(narrative.recommendation).toBe("REPLACE");
    expect(narrative.recommendationDetail).toContain(
      "Start with: 3 of 5 runs failed — 2 because they hit their tool-use limit and 1 because the Compile report step could not process its input.",
    );
    const text = [narrative.summary, ...narrative.problems, narrative.recommendationDetail].join("\n");
    for (const fragment of ["tool calls (", "28 used", "reading 'map'", "Cannot read", "“"]) expect(text).not.toContain(fragment);

    const every = mockReviewNarrative(evidence({ runs: 13, succeeded: 0, failed: 13 }, all));
    const everyText = [...every.problems, every.recommendationDetail].join("\n");
    for (const raw of all) expect(everyText).not.toContain(raw);
    expect(everyText).not.toMatch(/\$0\.52|312s|\(429\)|ECONNRESET|JSON/);
  });
});
