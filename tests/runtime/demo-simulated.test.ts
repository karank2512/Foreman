import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { isOrgSimulated, llm } from "@/server/models";
import { getShellData } from "@/server/queries/shell";
import { executeRun, tickScheduler } from "@/server/runtime";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker } from "../helpers/fixtures";
import { withModelEnv } from "../models/helpers";
import { loadRun, type TestOrg } from "./helpers";

/**
 * The demo workspace is Simulated by definition. Its seeded workers run on a schedule and anyone can sign into it,
 * so the moment a self-hoster puts a key in .env, a live demo would start spending that key on runs nobody asked
 * for (CLAUDE.md: never spend the user's money by surprise). With a key set, the demo must stay simulated — model
 * calls, tools and badges — while every other workspace goes live.
 */

const LIVE = { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" };

describe("the demo workspace with a provider key set", () => {
  let demo: TestOrg;
  let own: TestOrg;
  beforeAll(async () => {
    demo = await createTestOrg("rt-demo-sim");
    own = await createTestOrg("rt-own-live");
    await db.organization.update({ where: { id: demo.organization.id }, data: { isDemo: true } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await demo.cleanup();
    await own.cleanup();
  });

  it("is simulated, while any other workspace is live", async () => {
    await withModelEnv(LIVE, async () => {
      expect(llm.isSimulated()).toBe(false);
      expect(await isOrgSimulated(demo.organization.id)).toBe(true);
      expect(await isOrgSimulated(own.organization.id)).toBe(false);
      expect((await getShellData(demo.organization.id)).simulated).toBe(true);
      expect((await getShellData(own.organization.id)).simulated).toBe(false);
    });
  });

  it("answers model calls from the simulator and never reaches the provider", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("the demo must not reach a provider"));
    const result = await withModelEnv(LIVE, () =>
      llm.generateText(
        { tier: "fast", messages: [{ role: "user", content: "hello" }], mock: () => ({ text: "simulated reply" }) },
        { organizationId: demo.organization.id, purpose: "test.demo", persist: false },
      ),
    );
    expect(result).toMatchObject({ simulated: true, provider: "mock", text: "simulated reply", costUsd: expect.any(Number) });
    expect(network).not.toHaveBeenCalled();
  });

  it("runs a scheduled demo worker end to end in Simulated mode", async () => {
    const hired = await createHiredWorker(demo.organization.id);
    await db.worker.update({ where: { id: hired.worker.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("the demo must not reach a provider"));

    await withModelEnv(LIVE, async () => {
      expect(await tickScheduler(new Date(), { organizationId: demo.organization.id })).toBe(1);
      const queued = await db.run.findFirstOrThrow({ where: { organizationId: demo.organization.id, workerId: hired.worker.id, trigger: "SCHEDULED" } });
      expect(queued.simulated).toBe(true);

      const outcome = await executeRun(queued.id);
      expect(outcome.status).toBe("SUCCEEDED");
    });

    const run = await loadRun((await db.run.findFirstOrThrow({ where: { workerId: hired.worker.id }, select: { id: true } })).id);
    expect(run.simulated).toBe(true);
    const calls = await db.modelCall.findMany({ where: { runId: run.id }, select: { provider: true, simulated: true } });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.provider === "mock" && c.simulated)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });
});
