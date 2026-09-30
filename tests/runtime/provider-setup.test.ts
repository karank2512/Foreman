import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { computeWorkerScore, refreshWorkerScore } from "@/server/evaluation";
import { llm } from "@/server/models";
import { executeRun } from "@/server/runtime";
import { toRunFailure } from "@/server/runtime/failure";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker } from "../helpers/fixtures";
import { enqueue, loadRun, stepsOf, type TestOrg } from "./helpers";

/**
 * A self-hoster's first live run is where a typo'd key or an empty balance shows up. That run must fail once, with
 * the fix in plain words — not retry into the same wall — and must not make the worker look bad: the worker did
 * nothing wrong, the setup did.
 */

const BAD_KEY = "Anthropic rejected the API key — check ANTHROPIC_API_KEY in your .env, then restart Foreman.";
const badKey = () =>
  new AppError("MODEL_ERROR", BAD_KEY, { provider: "anthropic", model: "claude-haiku-4-5", kind: "auth", statusCode: 401 });

describe("toRunFailure: provider setup failures", () => {
  it("does not retry a rejected key, an empty balance, refused access or an unknown model, and flags them", () => {
    for (const kind of ["auth", "quota", "permission", "model_not_found"]) {
      const failure = toRunFailure(new AppError("MODEL_ERROR", "fix it", { kind }));
      expect(failure, kind).toMatchObject({ code: "MODEL_ERROR", retryable: false, providerSetup: true, message: "fix it" });
    }
  });

  it("keeps retrying transient provider trouble, which is no one's setup mistake", () => {
    for (const kind of ["rate_limit", "overloaded", "timeout", "network", undefined]) {
      const failure = toRunFailure(new AppError("MODEL_ERROR", "try later", { kind }));
      expect(failure, String(kind)).toMatchObject({ retryable: true, providerSetup: false });
    }
  });
});

describe("runtime: a run the provider refuses to serve", () => {
  let t: TestOrg;
  beforeAll(async () => {
    t = await createTestOrg("rt-provider-setup");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("fails at once with the fix, and is kept out of the worker's score and health", async () => {
    const hired = await createHiredWorker(t.organization.id);
    const good = await executeRun(await enqueue(t, hired));
    expect(good.status).toBe("SUCCEEDED");
    const before = await db.worker.findUniqueOrThrow({ where: { id: hired.worker.id }, select: { score: true } });
    expect(before.score).not.toBeNull();

    const runId = await enqueue(t, hired);
    const original = llm.generateText;
    const call = vi.spyOn(llm, "generateText").mockImplementation(async (req, tracking) => {
      if (tracking.runId === runId) throw badKey();
      return original(req, tracking);
    });

    const outcome = await executeRun(runId);
    expect(outcome).toMatchObject({ status: "FAILED", willRetry: false, error: BAD_KEY });
    expect(call.mock.calls.filter(([, tracking]) => tracking.runId === runId)).toHaveLength(1);

    const run = await loadRun(runId);
    expect(run).toMatchObject({ status: "FAILED", attempt: 1, error: BAD_KEY });
    const errorStep = (await stepsOf(runId)).find((s) => s.kind === "ERROR");
    expect(errorStep?.output).toMatchObject({ code: "MODEL_ERROR", retryable: false, providerSetup: true });

    // One good run counted, the refused one not: same score, and too few counted runs to call it unhealthy.
    const after = await db.worker.findUniqueOrThrow({ where: { id: hired.worker.id }, select: { score: true, health: true, healthReason: true } });
    expect(after.score).toBe(before.score);
    expect(after.health).not.toBe("NEEDS_ATTENTION");
    expect((await computeWorkerScore(hired.worker.id)).sampleSize.runs).toBe(1);

    // Control: the same failed run WITHOUT the marker counts as the worker's failure.
    await db.runStep.update({ where: { id: errorStep!.id }, data: { output: { code: "MODEL_ERROR", retryable: false } } });
    await refreshWorkerScore(hired.worker.id);
    const counted = await db.worker.findUniqueOrThrow({ where: { id: hired.worker.id }, select: { score: true, health: true } });
    expect(counted.score).toBeLessThan(before.score!);
    expect(counted.health).toBe("NEEDS_ATTENTION");
  });
});
