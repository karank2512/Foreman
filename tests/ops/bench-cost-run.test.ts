import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBenchArgs } from "../../scripts/bench-cost/args";
import { renderMarkdown } from "../../scripts/bench-cost/markdown";
import { runBenchmark, type BenchControl } from "../../scripts/bench-cost/run";
import { enforceSpendMode } from "../../scripts/bench-cost/safety";

/**
 * The benchmark end to end against the test database, simulated, with fake provider keys in the environment: the
 * runs must go through the real runtime, cost nothing, never touch the network, measure exactly what was metered,
 * pair correctly, and leave no rows behind.
 */

const PAID_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "TAVILY_API_KEY"] as const;
const FAKE = "sk-fake-bench-cost-test-key";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

describe("ops: bench-cost end to end (simulated)", () => {
  const saved = new Map<string, string | undefined>();
  const realFetch = globalThis.fetch;
  const blocked: string[] = [];

  beforeAll(() => {
    for (const key of [...PAID_KEYS, "FORCE_SIMULATED"]) saved.set(key, process.env[key]);
    // Any request to a non-local host fails the run (and is recorded), so a leak cannot pass silently.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!LOCAL_HOSTS.has(url.hostname)) {
        blocked.push(url.hostname);
        throw new Error(`network blocked in test: ${url.hostname}`);
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("pairs Foreman's worker with both baselines through the real runtime, spends nothing and cleans up", async () => {
    for (const key of PAID_KEYS) process.env[key] = FAKE;
    const args = parseBenchArgs(["--runs", "1"]);
    const plan = enforceSpendMode(args, process.env);
    expect(plan).toEqual({ mode: "simulated" });

    // Constructing a Prisma client re-reads .env; the blanked keys must survive it.
    const { PrismaClient } = await import("@prisma/client");
    await new PrismaClient().$disconnect();
    for (const key of PAID_KEYS) expect(process.env[key]).toBe("");
    expect(process.env.FORCE_SIMULATED).toBe("true");

    const control: BenchControl = { stopRequested: () => false };
    let report;
    try {
      const outcome = await runBenchmark(args, plan, control);
      expect(outcome.kind).toBe("report");
      if (outcome.kind !== "report") return;
      report = outcome.report;
    } finally {
      const cleanup = await control.onCleanup?.();
      expect(cleanup).toMatchObject({ workspaceDeleted: true, leftoverRows: 0 });
    }

    expect(report.mode).toBe("SIMULATED");
    expect(blocked).toEqual([]);
    expect(report.environment["Real provider spend"]).toBe("$0.000000");
    expect(report.environment["Live model calls"]).toBe(0);

    const [pair] = report.pairs;
    expect(report.pairs).toHaveLength(1);
    expect(pair.replay.ok).toBe(true);
    expect(report.sharedComponents).toEqual(["collector"]);
    const runs = [pair.after, pair.baselines.per_step!, pair.baselines.merged!];
    for (const run of runs) {
      expect(run.status).toBe("SUCCEEDED");
      expect(run.meteringDriftUsd).toBe(0);
      expect(run.liveModelCalls).toBe(0);
      expect(run.models.every((m) => m.startsWith("mock:"))).toBe(true);
    }
    // Baselines start after the collector: no search, no collector turn of their own.
    expect(pair.baselines.per_step!.toolCalls).toBe(0);
    expect(pair.baselines.per_step!.byComponent.collector).toBeUndefined();

    // 5 converted steps in the per-step baseline, 3 in the merged one, every turn answered by the stand-in.
    expect(report.standIn).toEqual({ answered: 8, fellBack: 0 });
    for (const id of ["per_step", "merged"] as const) {
      const fidelity = pair.fidelity[id]!;
      expect(fidelity.available).toBe(true);
      expect(fidelity.steps.every((s) => s.exact)).toBe(true);
      expect(fidelity.matchesAfter).toEqual({ records: true, stats: true });
    }
    expect(pair.fidelity.per_step!.steps).toHaveLength(5);
    expect(pair.fidelity.merged!.steps).toHaveLength(3);

    const perStep = report.comparisons.per_step!;
    const merged = report.comparisons.merged!;
    expect(perStep.modelCallsRemovedPerRun).toBe(5);
    expect(merged.modelCallsRemovedPerRun).toBe(3);
    expect(perStep.savedUsdPerRun!).toBeGreaterThan(merged.savedUsdPerRun!);
    expect(merged.cutPct!).toBeGreaterThan(0);
    for (const c of [perStep, merged]) {
      expect(c.claimable).toBe(false);
      expect(c.blockers[0]).toContain("simulated");
      expect(c.savedUsdPerRun).toBeCloseTo(c.convertedStepsUsdPerRun!, 2);
    }
    expect(report.headline).toMatch(/^PROJECTION ONLY/);
    expect(report.headline).not.toContain("Foreman cut");
    // The default volume: the scoping question's first suggestion, which the first read covers.
    expect(report.settings.volume).toEqual({ answer: "10", requested: null, target: 10 });
    expect(pair.after.records).toBe(10);
    expect(pair.after.toolCallsByName).toEqual({ web_search: 2, fetch_url: 4, extract_data: 1 });

    const markdown = renderMarkdown(report);
    expect(markdown).toContain("n/a (equal by construction)");
    expect(JSON.stringify(report)).not.toContain(FAKE);
    expect(markdown).not.toContain(FAKE);
  }, 180_000);

  it("asks the scoping step for --records and pairs the baselines on that many collected records", async () => {
    const args = parseBenchArgs(["--runs", "1", "--records", "40", "--baseline", "merged"]);
    const plan = enforceSpendMode(args, process.env);
    const control: BenchControl = { stopRequested: () => false };
    let report;
    try {
      const outcome = await runBenchmark(args, plan, control);
      if (outcome.kind !== "report") throw new Error(`benchmark ended ${outcome.kind}`);
      report = outcome.report;
    } finally {
      expect(await control.onCleanup?.()).toMatchObject({ workspaceDeleted: true, leftoverRows: 0 });
    }
    expect(report.settings.volume).toEqual({ answer: "40", requested: 40, target: 40 });
    expect(report.environment["Scoping answers"]).toMatchObject({ volume: "40" });
    const [pair] = report.pairs;
    expect(pair.replay.ok).toBe(true);
    // Past what its first read finds, the collector reads the full list: one more search and more pages.
    expect(pair.after.toolCallsByName.web_search).toBe(3);
    expect(pair.after.toolCallsByName.fetch_url).toBeGreaterThan(4);
    for (const run of [pair.after, pair.baselines.merged!]) {
      expect(run.status).toBe("SUCCEEDED");
      expect(run.records).toBe(40);
    }
    expect(pair.fidelity.merged!.steps.every((s) => s.exact)).toBe(true);
    expect(report.headline).toContain("40 records per run");
    expect(renderMarkdown(report)).toContain("**40 records per run** asked for");
    expect(blocked).toEqual([]);
  }, 180_000);
});
