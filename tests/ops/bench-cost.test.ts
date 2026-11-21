import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { buildInitialMessage } from "@/server/runtime";
import { BenchUsageError, DEFAULT_OUT, DEFAULT_RUNS, MAX_RECORDS, MAX_RUNS, MIN_PAIRS_FOR_CLAIM, parseBenchArgs, scopingAnswers } from "../../scripts/bench-cost/args";
import { compareOutputs } from "../../scripts/bench-cost/fidelity";
import { emptyComponentCost, type ComponentCost, type RunMeasurement } from "../../scripts/bench-cost/measure";
import { armPairCost, compareBaseline, modeOf, QUALITY_MARGIN_POINTS, type BenchMode, type PairRecord } from "../../scripts/bench-cost/report";
import {
  assertSimulatedEnvironment,
  BenchRefusal,
  capCoversFirstPair,
  enforceSpendMode,
  estimateNextRunUsd,
  FIRST_RUN_SAFETY_FACTOR,
  gateNextRun,
  OBSERVED_SAFETY_FACTOR,
  workspaceBudgetUsd,
} from "../../scripts/bench-cost/safety";
import { parseInitialMessage } from "../../scripts/bench-cost/stand-in";
import { bootstrapRatio95, median, pctChange, tInterval95 } from "../../scripts/bench-cost/stats";
import { baselineHeadline } from "../../scripts/bench-cost/wording";

/**
 * scripts/bench-cost.ts may be pointed at a real provider key, so its spend rules and the arithmetic behind its
 * headline are tested like product code. The end-to-end simulated run is in bench-cost-run.test.ts.
 */

/** A stand-in for process.env: enforceSpendMode mutates what it is given, and these tests never touch the real one. */
const fakeEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...extra, NODE_ENV: "test" });
const PAID_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "TAVILY_API_KEY"];
const FAKE_KEYS = { ANTHROPIC_API_KEY: "sk-ant-test-not-real", OPENAI_API_KEY: "sk-test-not-real", GOOGLE_GENERATIVE_AI_API_KEY: "AIza-not-real", TAVILY_API_KEY: "tvly-not-real" };

describe("ops: bench-cost flags", () => {
  it("defaults to 3 simulated pairs against both baselines on the fast tier", () => {
    expect(parseBenchArgs([])).toEqual({ runs: DEFAULT_RUNS, out: DEFAULT_OUT, beforeTier: "fast", baselines: ["per_step", "merged"], live: false, allowFixtureWeb: false, yes: false, help: false });
    expect(DEFAULT_RUNS).toBe(3);
  });

  it("parses every flag, in both --flag value and --flag=value form", () => {
    expect(parseBenchArgs(["--runs", "5", "--out=/tmp/x/report.md", "--before-tier", "standard", "--baseline=merged", "--live", "--budget-usd=$2.50", "--allow-fixture-web", "--yes"])).toEqual({
      runs: 5,
      out: "/tmp/x/report",
      beforeTier: "standard",
      baselines: ["merged"],
      live: true,
      budgetUsd: 2.5,
      allowFixtureWeb: true,
      yes: true,
      help: false,
    });
    expect(parseBenchArgs(["--baseline", "per-step"]).baselines).toEqual(["per_step"]);
  });

  it("takes --records as the answer to the scoping volume question, and nothing else", () => {
    expect(parseBenchArgs([]).records).toBeUndefined();
    expect(parseBenchArgs(["--records", "50"]).records).toBe(50);
    expect(parseBenchArgs([`--records=${MAX_RECORDS}`]).records).toBe(MAX_RECORDS);

    const questions = [
      { id: "focus", question: "Which segments?", why: "w", suggestions: ["AI infrastructure, seed to Series B", "Europe"] },
      { id: "volume", question: "How many records per run is ideal?", why: "w", suggestions: ["10", "15", "25"] },
      { id: "recipients", question: "Who gets it?", why: "w", suggestions: [] },
    ];
    expect(scopingAnswers(questions)).toEqual({ focus: "AI infrastructure, seed to Series B", volume: "10", recipients: "" });
    expect(scopingAnswers(questions, 100)).toEqual({ focus: "AI infrastructure, seed to Series B", volume: "100", recipients: "" });
    expect(() => scopingAnswers(questions.filter((q) => q.id !== "volume"), 25)).toThrow(BenchUsageError);
  });

  it("rejects bad values and unknown flags instead of guessing", () => {
    for (const argv of [["--runs", "0"], ["--runs", String(MAX_RUNS + 1)], ["--runs", "2.5"], ["--records", "0"], ["--records", String(MAX_RECORDS + 1)], ["--records", "12.5"], ["--records", "ten"], ["--records"], ["--before-tier", "cheap"], ["--budget-usd", "0"], ["--budget-usd", "abc"], ["--runs"], ["--spend"], ["--baseline", "all"]]) {
      expect(() => parseBenchArgs(argv), argv.join(" ")).toThrow();
    }
  });

  it("never reads a switch given a value as on: --live=false and --yes=no are errors, not a live run without a prompt", () => {
    for (const arg of ["--live=false", "--live=", "--yes=no", "-y=1", "--help=x", "--allow-fixture-web=1"]) {
      expect(() => parseBenchArgs([arg, "--budget-usd", "2"]), arg).toThrow(/takes no value/);
    }
  });
});

describe("ops: bench-cost spend mode", () => {
  it("without --live forces Simulated mode and BLANKS every paid key (a deleted key would come back from .env)", () => {
    const env = fakeEnv(FAKE_KEYS);
    expect(enforceSpendMode({ live: false, budgetUsd: 5, allowFixtureWeb: false }, env)).toEqual({ mode: "simulated" });
    expect(env.FORCE_SIMULATED).toBe("true");
    for (const key of PAID_KEYS) expect(env[key]).toBe("");
    expect(() => assertSimulatedEnvironment(env)).not.toThrow();
  });

  it("keeps the keys blank when a .env loader runs afterwards, as the Prisma client does when it is constructed", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-cost-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, Object.entries({ ...FAKE_KEYS, FORCE_SIMULATED: "false" }).map(([k, v]) => `${k}="${v}"`).join("\n"));
      const blanked = fakeEnv(FAKE_KEYS);
      enforceSpendMode({ live: false, allowFixtureWeb: false }, blanked);
      dotenv.config({ path: file, processEnv: blanked as Record<string, string>, quiet: true });
      for (const key of PAID_KEYS) expect(blanked[key]).toBe("");
      expect(blanked.FORCE_SIMULATED).toBe("true");
      expect(() => assertSimulatedEnvironment(blanked)).not.toThrow();

      // Why the keys are blanked rather than deleted: a missing variable is filled straight back in.
      const deleted: NodeJS.ProcessEnv = fakeEnv();
      dotenv.config({ path: file, processEnv: deleted as Record<string, string>, quiet: true });
      expect(deleted.ANTHROPIC_API_KEY).toBe(FAKE_KEYS.ANTHROPIC_API_KEY);
      expect(() => assertSimulatedEnvironment(deleted)).toThrow(BenchRefusal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertSimulatedEnvironment refuses a key that came back or a FORCE_SIMULATED that was lifted", () => {
    const env = fakeEnv();
    enforceSpendMode({ live: false, allowFixtureWeb: false }, env);
    expect(() => assertSimulatedEnvironment({ ...env, TAVILY_API_KEY: "tvly-x" })).toThrow(/TAVILY_API_KEY/);
    expect(() => assertSimulatedEnvironment({ ...env, FORCE_SIMULATED: undefined })).toThrow(/FORCE_SIMULATED/);
  });

  it("refuses --live without a budget, without a key, without Tavily (unless --allow-fixture-web), or against FORCE_SIMULATED", () => {
    const live = (env: NodeJS.ProcessEnv, extra: { budgetUsd?: number; allowFixtureWeb?: boolean } = { budgetUsd: 1 }) =>
      enforceSpendMode({ live: true, allowFixtureWeb: false, ...extra }, env);
    expect(() => live(fakeEnv(FAKE_KEYS), {})).toThrow(BenchRefusal);
    expect(() => live(fakeEnv())).toThrow(/provider key/);
    expect(() => live(fakeEnv({ ANTHROPIC_API_KEY: " " }))).toThrow(/provider key/);
    expect(() => live(fakeEnv({ ...FAKE_KEYS, FORCE_SIMULATED: "true" }))).toThrow(/FORCE_SIMULATED/);
    expect(() => live(fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" }))).toThrow(/TAVILY_API_KEY/);
    expect(live(fakeEnv({ ANTHROPIC_API_KEY: "sk-ant-test-not-real" }), { budgetUsd: 1, allowFixtureWeb: true })).toMatchObject({ mode: "live", liveWebSearch: false });
  });

  it("allows --live with a budget and keys, and reports key NAMES only", () => {
    const env = fakeEnv({ OPENAI_API_KEY: "sk-test-not-real", TAVILY_API_KEY: "tvly-not-real" });
    const plan = enforceSpendMode({ live: true, budgetUsd: 2, allowFixtureWeb: false }, env);
    expect(plan).toEqual({ mode: "live", budgetUsd: 2, providerKeys: ["OPENAI_API_KEY"], liveWebSearch: true });
    expect(JSON.stringify(plan)).not.toContain("not-real");
    expect(env.OPENAI_API_KEY).toBe("sk-test-not-real");
  });
});

describe("ops: bench-cost budget gate", () => {
  it("prices the first pair from Foreman's estimate with a margin, later pairs from the most expensive one so far", () => {
    expect(estimateNextRunUsd({ observedUsd: [], foremanEstimateUsd: 0.2 })).toBeCloseTo(0.2 * FIRST_RUN_SAFETY_FACTOR, 10);
    expect(estimateNextRunUsd({ observedUsd: [0.1, 0.3, 0.2], foremanEstimateUsd: 0.05 })).toBeCloseTo(0.3 * OBSERVED_SAFETY_FACTOR, 10);
  });

  it("never starts a pair whose estimate would pass the cap, and refuses a cap that cannot cover the first pair", () => {
    expect(gateNextRun({ budgetUsd: 1, spentUsd: 0.5, nextEstimateUsd: 0.5 })).toEqual({ allowed: true });
    expect(gateNextRun({ budgetUsd: 1, spentUsd: 0.6, nextEstimateUsd: 0.5 }).allowed).toBe(false);
    expect(gateNextRun({ budgetUsd: 1, spentUsd: 1.01, nextEstimateUsd: 0 }).allowed).toBe(false);
    expect(capCoversFirstPair(0.05, 0.13).allowed).toBe(false);
    expect(capCoversFirstPair(2, 0.19)).toEqual({ allowed: true });
  });

  it("sets the workspace's own budget to the cap rounded DOWN to cents (0 would mean no cap)", () => {
    expect(workspaceBudgetUsd(2.509)).toBe(2.5);
    expect(workspaceBudgetUsd(0.01)).toBe(0.01);
    expect(workspaceBudgetUsd(1.1)).toBe(1.1);
  });
});

describe("ops: bench-cost simulated stand-in input parsing", () => {
  it("reads back exactly the context the runtime rendered into the first message", () => {
    const context = {
      records: [{ company: "Vectorloom", amount_usd: 12_000_000, lead_investor: null }],
      stats: { total: 1, groups: [{ key: "vector databases", count: 1, share: 1 }], numeric: {} },
      insights: "## Not a section\nPlain markdown with a | pipe.",
      empty: "",
    };
    const keys = ["insights", "records", "stats", "empty", "missing"];
    const message = buildInitialMessage({ inputKeys: keys }, context);
    expect(parseInitialMessage(message, keys)).toEqual({ ...context, missing: undefined });
  });

  it("refuses anything it cannot reproduce byte for byte", () => {
    const message = buildInitialMessage({ inputKeys: ["records"] }, { records: [{ a: 1 }] });
    expect(parseInitialMessage(message, ["stats"])).toBeNull();
    expect(parseInitialMessage(`${message}\nextra`, ["records"])).toBeNull();
    expect(parseInitialMessage(message.replace("[", "{"), ["records"])).toBeNull();
  });
});

describe("ops: bench-cost statistics", () => {
  it("computes Student's t intervals and a reproducible paired bootstrap", () => {
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(pctChange(1, 0)).toBeNull();
    expect(tInterval95([1])).toBeNull();
    const t = tInterval95([1, 2, 3])!;
    expect(t.low).toBeCloseTo(2 - 4.303 / Math.sqrt(3), 3);
    expect(t.high).toBeCloseTo(2 + 4.303 / Math.sqrt(3), 3);
    expect(tInterval95([0.5, 0.5, 0.5])).toEqual({ low: 0.5, high: 0.5 });
    const pairs = [0.1, 0.12, 0.09, 0.11, 0.1].map((n, i) => ({ numerator: n, denominator: 1 + i / 10 }));
    expect(bootstrapRatio95(pairs)).toEqual(bootstrapRatio95(pairs));
    const ci = bootstrapRatio95(pairs)!;
    expect(ci.low).toBeLessThan(ci.high);
    expect(bootstrapRatio95([{ numerator: 1, denominator: 4 }, { numerator: 1, denominator: 4 }])).toEqual({ low: 0.25, high: 0.25 });
  });
});

// ── Paired accounting and the headline ─────────────────────────────────────

const cost = (over: Partial<ComponentCost>): ComponentCost => ({ ...emptyComponentCost(), ...over });

function measurement(over: Partial<RunMeasurement> & Pick<RunMeasurement, "arm" | "costUsd">): RunMeasurement {
  return {
    pair: 1,
    runId: "r",
    status: "SUCCEEDED",
    error: null,
    simulated: false,
    inputTokens: 1000,
    outputTokens: 100,
    modelCalls: 2,
    failedModelCalls: 0,
    liveModelCalls: 2,
    toolCalls: 0,
    simulatedToolCalls: 0,
    toolCallsByName: {},
    toolFeesUsd: 0,
    simulatedToolFeesUsd: 0,
    judgeUsd: 0.008,
    wallMs: 1000,
    activeMs: 900,
    checksScore: 100,
    judgeScore: 90,
    runScore: 95,
    records: 10,
    deliverableChars: 500,
    byComponent: {},
    models: ["anthropic:claude-haiku-4-5 (fast)"],
    meteringDriftUsd: 0,
    ...over,
  };
}

/** A live pair: collector $0.06 + $0.018 fees (shared), AFTER $0.093 in total, the baseline's own run $0.033 + noise. */
function livePair(i: number, over: { baseline?: Partial<RunMeasurement>; after?: Partial<RunMeasurement>; fees?: { simulated: boolean } } = {}): PairRecord {
  const simulatedFees = over.fees?.simulated ?? false;
  const collector = cost({ modelUsd: 0.06 + i * 0.001, toolFeesUsd: 0.018, simulatedToolFeesUsd: simulatedFees ? 0.018 : 0, modelCalls: 4, toolCalls: 6, simulatedToolCalls: simulatedFees ? 6 : 0, inputTokens: 17000, outputTokens: 2500 });
  const after = measurement({
    arm: "after",
    pair: i,
    costUsd: 0.093 + i * 0.001,
    toolCalls: 6,
    toolFeesUsd: 0.018,
    simulatedToolCalls: simulatedFees ? 6 : 0,
    simulatedToolFeesUsd: simulatedFees ? 0.018 : 0,
    byComponent: { collector, analyst: cost({ modelUsd: 0.0063, modelCalls: 1 }) },
    ...over.after,
  });
  const baseline = measurement({
    arm: "per_step",
    pair: i,
    costUsd: 0.0333 + (i % 2) * 0.0008,
    modelCalls: 7,
    liveModelCalls: 7,
    byComponent: { validate_records: cost({ modelUsd: 0.0035, modelCalls: 1 }), rank: cost({ modelUsd: 0.0036, modelCalls: 1 }), analyst: cost({ modelUsd: 0.0063, modelCalls: 1 }) },
    ...over.baseline,
  });
  return {
    pair: i,
    after,
    baselines: { per_step: baseline },
    shared: { componentIds: ["collector"], byComponent: { collector } },
    replay: { ok: true, note: "replayed" },
    fidelity: { per_step: { available: true, note: null, steps: [{ componentId: "rank", replaces: ["rank"], kind: "records", exact: true }], matchesAfter: { records: true } } },
  };
}

const pairsOf = (n: number, f: (i: number) => PairRecord = livePair) => Array.from({ length: n }, (_, k) => f(k + 1));
const compare = (pairs: PairRecord[], mode: BenchMode = "LIVE", opts: { runsRequested?: number; stoppedEarly?: string | null } = {}) =>
  compareBaseline(pairs, "per_step", mode, { runsRequested: opts.runsRequested ?? pairs.length, stoppedEarly: opts.stoppedEarly ?? null, convertedIds: new Set(["validate_records", "rank"]) });

describe("ops: bench-cost paired accounting", () => {
  it("prices a baseline as the shared collector from AFTER plus its own run, and AFTER as its own run", () => {
    const pair = livePair(1);
    expect(armPairCost(pair, "after", "LIVE")!.totalUsd).toBeCloseTo(0.094, 6);
    const baseline = armPairCost(pair, "per_step", "LIVE", new Set(["validate_records", "rank"]))!;
    expect(baseline.totalUsd).toBeCloseTo(0.061 + 0.018 + 0.0341, 6);
    expect(baseline.convertedUsd).toBeCloseTo(0.0071, 6);
    expect(baseline.modelCalls).toBe(7 + 4);
    expect(baseline.breakdown.collector).toBeCloseTo(0.061, 6);
  });

  it("leaves out tool fees no service billed (fixture web) unless the whole benchmark is a projection", () => {
    const pair = livePair(1, { fees: { simulated: true } });
    expect(armPairCost(pair, "after", "LIVE_MODELS_FIXTURE_WEB")!.totalUsd).toBeCloseTo(0.094 - 0.018, 6);
    expect(armPairCost(pair, "per_step", "LIVE_MODELS_FIXTURE_WEB")!.totalUsd).toBeCloseTo(0.061 + 0.0341, 6);
    expect(armPairCost(pair, "after", "SIMULATED")!.totalUsd).toBeCloseTo(0.094, 6);
  });

  it("labels a run LIVE only when its model calls AND its tool calls were live", () => {
    expect(modeOf([measurement({ arm: "after", costUsd: 1, toolCalls: 3 })])).toBe("LIVE");
    expect(modeOf([measurement({ arm: "after", costUsd: 1, toolCalls: 3, simulatedToolCalls: 3 })])).toBe("LIVE_MODELS_FIXTURE_WEB");
    expect(modeOf([measurement({ arm: "after", costUsd: 1, liveModelCalls: 1 })])).toBe("MIXED");
    expect(modeOf([measurement({ arm: "after", costUsd: 1, simulated: true, liveModelCalls: 0 })])).toBe("SIMULATED");
  });
});

describe("ops: bench-cost headline", () => {
  it(`allows a launch figure only for ${MIN_PAIRS_FOR_CLAIM}+ complete live pairs whose intervals exclude zero, with the denominator stated`, () => {
    const c = compare(pairsOf(MIN_PAIRS_FOR_CLAIM));
    expect(c.blockers).toEqual([]);
    expect(c.claimable).toBe(true);
    expect(c.pairsCompared).toBe(MIN_PAIRS_FOR_CLAIM);
    expect(c.savedUsdPerRun).toBeGreaterThan(0);
    expect(c.savedUsdCi95!.low).toBeGreaterThan(0);
    expect(c.cutPctCi95!.low).toBeGreaterThan(0);
    expect(c.cutPct).toBeGreaterThan(c.cutPctCi95!.low - 0.1);
    const info = { label: "x", workerName: "Alex", pipeline: [], modelSteps: 2, codeSteps: 5, codeOperations: [], converted: {}, foremanEstimatePerRunUsd: 0 };
    const headline = baselineHeadline(c, "LIVE", { after: info, baseline: { ...info, converted: { validate_records: ["validate_records"], rank: ["rank"] } }, models: ["anthropic:claude-haiku-4-5 (fast)"], date: "2026-10-03" });
    expect(headline).toMatch(/^On the funding-tracker benchmark \(5 paired live runs on anthropic:claude-haiku-4-5 \(fast\), 2026-10-03\)/);
    expect(headline).toContain("95% CI");
    expect(headline).toContain("saved per run");
    expect(headline).not.toContain("Foreman cut");
    expect(headline).toContain("reproduced the code's output exactly");
  });

  it("is a projection, never a claim, when simulated — and says what blocks it otherwise", () => {
    const simulated = compare(pairsOf(MIN_PAIRS_FOR_CLAIM), "SIMULATED");
    expect(simulated.claimable).toBe(false);
    expect(simulated.checksDelta).toBeNull(); // equal by construction: not compared
    const info = { label: "x", workerName: "Alex", pipeline: [], modelSteps: 2, codeSteps: 5, codeOperations: [], converted: {}, foremanEstimatePerRunUsd: 0 };
    expect(baselineHeadline(simulated, "SIMULATED", { after: info, baseline: info, models: [], date: "" })).toMatch(/^PROJECTION ONLY/);
    const fixture = compare(pairsOf(MIN_PAIRS_FOR_CLAIM), "LIVE_MODELS_FIXTURE_WEB");
    expect(fixture.blockers.join()).toContain("fixture web");
    expect(baselineHeadline(fixture, "LIVE_MODELS_FIXTURE_WEB", { after: info, baseline: info, models: [], date: "" })).toMatch(/^NOT A LAUNCH FIGURE/);
  });

  it("blocks the claim when the benchmark stopped early or ran fewer pairs than asked", () => {
    expect(compare(pairsOf(MIN_PAIRS_FOR_CLAIM), "LIVE", { stoppedEarly: "interrupted by the user" }).blockers.join()).toContain("stopped early");
    const short = compare(pairsOf(MIN_PAIRS_FOR_CLAIM), "LIVE", { runsRequested: MIN_PAIRS_FOR_CLAIM + 1 });
    expect(short.claimable).toBe(false);
    expect(short.blockers.join()).toContain(`only ${MIN_PAIRS_FOR_CLAIM} of ${MIN_PAIRS_FOR_CLAIM + 1} pairs ran`);
    expect(compare(pairsOf(3)).blockers.join()).toContain(`needs at least ${MIN_PAIRS_FOR_CLAIM}`);
  });

  it("blocks the claim when a run failed (and counts the failure's spend per successful deliverable)", () => {
    const pairs = pairsOf(MIN_PAIRS_FOR_CLAIM + 1, (i) => (i === 2 ? livePair(i, { baseline: { status: "FAILED", costUsd: 0.01 } }) : livePair(i)));
    const c = compare(pairs);
    expect(c.pairsCompared).toBe(MIN_PAIRS_FOR_CLAIM);
    expect(c.claimable).toBe(false);
    expect(c.blockers.join()).toContain("1 pair(s) failed");
  });

  it("blocks the claim when the baseline's quality is lower, the saving is noise, or its steps could not be checked", () => {
    const worse = compare(pairsOf(MIN_PAIRS_FOR_CLAIM, (i) => livePair(i, { baseline: { checksScore: 100 - QUALITY_MARGIN_POINTS - 3 } })));
    expect(worse.blockers.join()).toContain("checks scored");
    const noisy = compare(pairsOf(MIN_PAIRS_FOR_CLAIM, (i) => livePair(i, { baseline: { costUsd: i % 2 === 0 ? 0.001 : 0.03 } })));
    expect(noisy.blockers.join()).toContain("includes zero");
    const unchecked = compare(pairsOf(MIN_PAIRS_FOR_CLAIM, (i) => ({ ...livePair(i), fidelity: {} })));
    expect(unchecked.blockers.join()).toContain("could not be checked");
  });
});

describe("ops: bench-cost output fidelity", () => {
  it("compares records exactly and says how they differ", () => {
    const a = { company: "A", amount_usd: 2 };
    const b = { company: "B", amount_usd: 1 };
    expect(compareOutputs([a, b], [{ amount_usd: 2, company: "A" }, b])).toMatchObject({ kind: "records", exact: true });
    expect(compareOutputs([a, b], [b, a])).toMatchObject({ exact: false, reordered: true, missing: 0, unexpected: 0 });
    expect(compareOutputs([a, b], [a, { ...b, amount_usd: 1.5 }])).toMatchObject({ exact: false, missing: 1, unexpected: 1, reordered: false });
    expect(compareOutputs([a, b], [a])).toMatchObject({ exact: false, missing: 1, unexpected: 0, expectedCount: 2, actualCount: 1 });
    expect(compareOutputs({ total: 2 }, { total: 3 })).toMatchObject({ kind: "object", exact: false });
  });

  it("ignores the report's date line (the model is not told the date) and trailing whitespace, nothing else", () => {
    const report = "# R\n\n## Table\n\n| A |\n\n## Methodology\n\n- Pipeline: x.\n- Generated by Alex · 2026-10-03\n";
    expect(compareOutputs(report, report.replace("2026-10-03", "2025-01-01").replace("| A |", "| A |  "))).toMatchObject({ kind: "text", exact: true });
    expect(compareOutputs(report, report.replace("| A |", "| B |"))).toMatchObject({ exact: false, differingLines: 1 });
  });
});
