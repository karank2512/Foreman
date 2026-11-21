import { MIN_PAIRS_FOR_CLAIM, type BaselineId } from "./args";
import type { PairFidelity } from "./fidelity";
import { addComponentCost, emptyComponentCost, type ArmId, type ComponentCost, type RunMeasurement } from "./measure";
import { bootstrapRatio95, mean, median, pctChange, tInterval95, type Interval } from "./stats";

/**
 * Paired accounting, summaries and the comparison behind the headline. Pure.
 *
 * A pair is one AFTER run (Foreman's worker, end to end) plus one run of each baseline that starts after the
 * collector, from the records AFTER's collector returned. A baseline's cost per run is therefore
 *   shared (AFTER's collector: model calls + its tool fees) + everything its own run metered,
 * and the saving per pair is baseline − AFTER on the same records, so collector noise cancels out.
 */

export type BenchMode = "SIMULATED" | "LIVE" | "LIVE_MODELS_FIXTURE_WEB" | "MIXED";

/** A baseline more than this many points (0–100) below AFTER on checks or blended quality blocks the claim. */
export const QUALITY_MARGIN_POINTS = 2;

export interface ArmInfo {
  label: string;
  workerName: string;
  /** Pipeline in order: "collector (model, standard)", "rank (code)" … */
  pipeline: string[];
  modelSteps: number;
  codeSteps: number;
  /** Operations of the code steps, in order ("validate_records", "rank", …). */
  codeOperations: string[];
  /** Converted agent ids → the Foreman steps each one replaces (baselines only). */
  converted: Record<string, string[]>;
  /** Foreman's own a-priori estimate (blueprint.costEstimate, re-priced at the current routing). */
  foremanEstimatePerRunUsd: number;
}

export interface PairRecord {
  pair: number;
  after: RunMeasurement;
  baselines: Partial<Record<BaselineId, RunMeasurement>>;
  /** AFTER's components that every baseline reuses instead of re-running (the collector), with what they cost. */
  shared: { componentIds: string[]; byComponent: Record<string, ComponentCost> };
  replay: { ok: boolean; note: string };
  fidelity: Partial<Record<BaselineId, PairFidelity>>;
}

/** One arm's cost for one pair, on the comparison basis (see `excludesSimulatedFees`). */
export interface ArmPairCost {
  status: string;
  totalUsd: number;
  judgeUsd: number;
  toolFeesUsd: number;
  /** Model spend on the work: total minus the quality review and tool fees. */
  modelOnlyUsd: number;
  /** Model spend of the converted steps (baselines; 0 for AFTER, whose steps are code). */
  convertedUsd: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCalls: number;
  breakdown: Record<string, number>;
  checksScore: number | null;
  judgeScore: number | null;
  runScore: number | null;
  records: number | null;
}

export interface ArmSummary {
  runs: number;
  succeeded: number;
  /** Means are over SUCCEEDED runs: a run that died early is cheap for the wrong reason. */
  meanTotalUsd: number | null;
  medianTotalUsd: number | null;
  minTotalUsd: number | null;
  maxTotalUsd: number | null;
  meanWorkUsd: number | null;
  meanModelOnlyUsd: number | null;
  meanConvertedUsd: number | null;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  meanModelCalls: number | null;
  meanToolCalls: number | null;
  meanChecksScore: number | null;
  meanJudgeScore: number | null;
  meanRunScore: number | null;
  meanRecords: number | null;
  breakdownMeanUsd: Record<string, number>;
  /** Every run, failed ones included: what the arm actually cost. */
  totalSpentUsd: number;
  /** totalSpentUsd ÷ successful runs: failures make every good deliverable dearer. */
  costPerSuccessUsd: number | null;
}

export interface FidelitySummary {
  /** Pairs whose converted steps could be checked against the code. */
  pairsChecked: number;
  /** Pairs where every converted step returned exactly what the code returns. */
  pairsExact: number;
  steps: number;
  stepsExact: number;
  recordsMissing: number;
  recordsUnexpected: number;
  /** Per key: in how many checked pairs the baseline's final value equals AFTER's. */
  matchesAfter: Record<string, number>;
}

export interface Comparison {
  baseline: BaselineId;
  /** Pairs where AFTER and this baseline both succeeded on the same replayed records. */
  pairsCompared: number;
  savedUsdPerRun: number | null;
  savedUsdCi95: Interval | null;
  /** Σ saved ÷ Σ baseline cost × 100: the share of the baseline's total cost per run that code avoids. */
  cutPct: number | null;
  cutPctCi95: Interval | null;
  cutPctExclReview: number | null;
  cutPctModelOnly: number | null;
  convertedStepsUsdPerRun: number | null;
  modelCallsRemovedPerRun: number | null;
  tokensChangePct: number | null;
  /** Baseline minus AFTER, in points (0–100); null when quality says nothing (simulated: equal by construction). */
  checksDelta: number | null;
  blendedDelta: number | null;
  fidelity: FidelitySummary;
  /** Why this comparison may not be published as a launch figure; empty when it may. */
  blockers: string[];
  claimable: boolean;
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const r6 = (n: number | null) => (n === null ? null : round(n, 6));
const r1 = (n: number | null) => (n === null ? null : round(n, 1));
const nums = (values: ReadonlyArray<number | null>) => values.filter((v): v is number => v !== null && Number.isFinite(v));

/** Fees for tool calls that never reached a paid service are left out unless the whole benchmark is a projection. */
export const excludesSimulatedFees = (mode: BenchMode) => mode !== "SIMULATED";

export function runOf(pair: PairRecord, arm: ArmId): RunMeasurement | undefined {
  return arm === "after" ? pair.after : pair.baselines[arm];
}

export function sharedCost(pair: PairRecord): ComponentCost {
  return Object.values(pair.shared.byComponent).reduce(addComponentCost, emptyComponentCost());
}

export function armPairCost(pair: PairRecord, arm: ArmId, mode: BenchMode, convertedIds: ReadonlySet<string> = new Set()): ArmPairCost | null {
  const run = runOf(pair, arm);
  if (!run) return null;
  // AFTER ran the shared components itself; a baseline adds what they cost in AFTER.
  const shared = arm === "after" ? emptyComponentCost() : sharedCost(pair);
  const unbilled = excludesSimulatedFees(mode) ? run.simulatedToolFeesUsd + shared.simulatedToolFeesUsd : 0;
  const totalUsd = run.costUsd + shared.modelUsd + shared.toolFeesUsd - unbilled;
  const toolFeesUsd = run.toolFeesUsd + shared.toolFeesUsd - unbilled;
  const breakdown: Record<string, number> = {};
  const components = arm === "after" ? [run.byComponent] : [pair.shared.byComponent, run.byComponent];
  for (const byComponent of components) for (const [key, c] of Object.entries(byComponent)) if (c.modelCalls > 0) breakdown[key] = round((breakdown[key] ?? 0) + c.modelUsd, 6);
  breakdown["tool fees"] = round(toolFeesUsd, 6);
  const convertedUsd = Object.entries(run.byComponent).reduce((s, [key, c]) => s + (convertedIds.has(key) ? c.modelUsd : 0), 0);
  return {
    status: run.status,
    totalUsd: round(totalUsd, 6),
    judgeUsd: run.judgeUsd,
    toolFeesUsd: round(toolFeesUsd, 6),
    modelOnlyUsd: round(totalUsd - run.judgeUsd - toolFeesUsd, 6),
    convertedUsd: round(convertedUsd, 6),
    inputTokens: run.inputTokens + shared.inputTokens,
    outputTokens: run.outputTokens + shared.outputTokens,
    modelCalls: run.modelCalls + shared.modelCalls,
    toolCalls: run.toolCalls + shared.toolCalls,
    breakdown,
    checksScore: run.checksScore,
    judgeScore: run.judgeScore,
    runScore: run.runScore,
    records: run.records,
  };
}

export function summarizeArm(pairs: readonly PairRecord[], arm: ArmId, mode: BenchMode, convertedIds: ReadonlySet<string> = new Set()): ArmSummary {
  const all = pairs.map((p) => armPairCost(p, arm, mode, convertedIds)).filter((c): c is ArmPairCost => c !== null);
  const ok = all.filter((c) => c.status === "SUCCEEDED");
  const totals = ok.map((c) => c.totalUsd);
  const breakdown: Record<string, number> = {};
  for (const c of ok) for (const [key, usd] of Object.entries(c.breakdown)) breakdown[key] = (breakdown[key] ?? 0) + usd / ok.length;
  const totalSpentUsd = round(all.reduce((s, c) => s + c.totalUsd, 0), 6);
  return {
    runs: all.length,
    succeeded: ok.length,
    meanTotalUsd: r6(mean(totals)),
    medianTotalUsd: r6(median(totals)),
    minTotalUsd: totals.length > 0 ? r6(Math.min(...totals)) : null,
    maxTotalUsd: totals.length > 0 ? r6(Math.max(...totals)) : null,
    meanWorkUsd: r6(mean(ok.map((c) => c.totalUsd - c.judgeUsd))),
    meanModelOnlyUsd: r6(mean(ok.map((c) => c.modelOnlyUsd))),
    meanConvertedUsd: r6(mean(ok.map((c) => c.convertedUsd))),
    meanInputTokens: r1(mean(ok.map((c) => c.inputTokens))),
    meanOutputTokens: r1(mean(ok.map((c) => c.outputTokens))),
    meanModelCalls: r1(mean(ok.map((c) => c.modelCalls))),
    meanToolCalls: r1(mean(ok.map((c) => c.toolCalls))),
    meanChecksScore: r1(mean(nums(ok.map((c) => c.checksScore)))),
    meanJudgeScore: r1(mean(nums(ok.map((c) => c.judgeScore)))),
    meanRunScore: r1(mean(nums(ok.map((c) => c.runScore)))),
    meanRecords: r1(mean(nums(ok.map((c) => c.records)))),
    breakdownMeanUsd: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, round(v, 6)])),
    totalSpentUsd,
    costPerSuccessUsd: ok.length > 0 ? round(totalSpentUsd / ok.length, 6) : null,
  };
}

function summarizeFidelity(pairs: readonly PairRecord[], baseline: BaselineId): FidelitySummary {
  const checked = pairs.map((p) => p.fidelity[baseline]).filter((f): f is PairFidelity => f?.available === true);
  const matchesAfter: Record<string, number> = {};
  for (const f of checked) for (const [key, same] of Object.entries(f.matchesAfter)) matchesAfter[key] = (matchesAfter[key] ?? 0) + (same ? 1 : 0);
  const steps = checked.flatMap((f) => f.steps);
  return {
    pairsChecked: checked.length,
    pairsExact: checked.filter((f) => f.steps.every((s) => s.exact)).length,
    steps: steps.length,
    stepsExact: steps.filter((s) => s.exact).length,
    recordsMissing: steps.reduce((s, x) => s + (x.missing ?? 0), 0),
    recordsUnexpected: steps.reduce((s, x) => s + (x.unexpected ?? 0), 0),
    matchesAfter,
  };
}

export interface CompareOptions {
  runsRequested: number;
  stoppedEarly: string | null;
  convertedIds: ReadonlySet<string>;
}

const MODE_BLOCKERS: Record<Exclude<BenchMode, "LIVE">, string> = {
  SIMULATED: "simulated projection: no provider was called",
  LIVE_MODELS_FIXTURE_WEB: "web search used Foreman's fixture web, not live search (no TAVILY_API_KEY)",
  MIXED: "some model calls were simulated",
};

export function compareBaseline(pairs: readonly PairRecord[], baseline: BaselineId, mode: BenchMode, opts: CompareOptions): Comparison {
  const usable = pairs.filter((p) => p.replay.ok && p.after.status === "SUCCEEDED" && p.baselines[baseline]?.status === "SUCCEEDED");
  const rows = usable.map((p) => ({ after: armPairCost(p, "after", mode)!, before: armPairCost(p, baseline, mode, opts.convertedIds)! }));
  const saved = rows.map((r) => r.before.totalUsd - r.after.totalUsd);
  const sum = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);
  const ratio = (num: number, den: number) => (rows.length > 0 && den > 0 ? round((num / den) * 100, 1) : null);
  const beforeTotal = sum(rows.map((r) => r.before.totalUsd));
  const cutCi = bootstrapRatio95(rows.map((r, i) => ({ numerator: saved[i], denominator: r.before.totalUsd })));
  const quality = mode !== "SIMULATED";
  const delta = (pick: (c: ArmPairCost) => number | null) => {
    const a = mean(nums(rows.map((r) => pick(r.after))));
    const b = mean(nums(rows.map((r) => pick(r.before))));
    return quality && a !== null && b !== null ? round(b - a, 1) : null;
  };
  const savedCi = tInterval95(saved);
  const comparison: Omit<Comparison, "blockers" | "claimable"> = {
    baseline,
    pairsCompared: rows.length,
    savedUsdPerRun: r6(mean(saved)),
    savedUsdCi95: savedCi && { low: round(savedCi.low, 6), high: round(savedCi.high, 6) },
    cutPct: ratio(sum(saved), beforeTotal),
    cutPctCi95: cutCi && { low: round(cutCi.low * 100, 1), high: round(cutCi.high * 100, 1) },
    cutPctExclReview: ratio(sum(rows.map((r, i) => saved[i] - (r.before.judgeUsd - r.after.judgeUsd))), sum(rows.map((r) => r.before.totalUsd - r.before.judgeUsd))),
    cutPctModelOnly: ratio(sum(rows.map((r) => r.before.modelOnlyUsd - r.after.modelOnlyUsd)), sum(rows.map((r) => r.before.modelOnlyUsd))),
    convertedStepsUsdPerRun: r6(mean(rows.map((r) => r.before.convertedUsd))),
    modelCallsRemovedPerRun: r1(mean(rows.map((r) => r.before.modelCalls - r.after.modelCalls))),
    tokensChangePct: pctChange(mean(rows.map((r) => r.after.inputTokens + r.after.outputTokens)), mean(rows.map((r) => r.before.inputTokens + r.before.outputTokens))),
    checksDelta: delta((c) => c.checksScore),
    blendedDelta: delta((c) => c.runScore),
    fidelity: summarizeFidelity(usable, baseline),
  };

  const blockers: string[] = [];
  if (mode !== "LIVE") blockers.push(MODE_BLOCKERS[mode]);
  if (opts.stoppedEarly) blockers.push(`the benchmark stopped early (${opts.stoppedEarly})`);
  if (pairs.length < opts.runsRequested) blockers.push(`only ${pairs.length} of ${opts.runsRequested} pairs ran`);
  if (usable.length < pairs.length) blockers.push(`${pairs.length - usable.length} pair(s) failed, were interrupted or could not be paired, and the average leaves them out`);
  if (usable.length < MIN_PAIRS_FOR_CLAIM) blockers.push(`${usable.length} complete pair(s); a published figure needs at least ${MIN_PAIRS_FOR_CLAIM}`);
  if (usable.length >= 2 && (!savedCi || savedCi.low <= 0)) blockers.push("the 95% interval of the $ saved per run includes zero");
  if (usable.length >= 2 && (!cutCi || cutCi.low <= 0)) blockers.push("the 95% interval of the percentage includes zero");
  if (rows.length > 0 && (comparison.cutPct === null || comparison.cutPct <= 0)) blockers.push("the baseline was not more expensive");
  if (comparison.checksDelta !== null && comparison.checksDelta < -QUALITY_MARGIN_POINTS) blockers.push(`the baseline's checks scored ${-comparison.checksDelta} points lower (cost compared at different quality)`);
  if (comparison.blendedDelta !== null && comparison.blendedDelta < -QUALITY_MARGIN_POINTS) blockers.push(`the baseline's blended quality scored ${-comparison.blendedDelta} points lower (cost compared at different quality)`);
  if (comparison.fidelity.pairsChecked < usable.length) blockers.push(`the model-run steps could not be checked against the code in ${usable.length - comparison.fidelity.pairsChecked} pair(s)`);
  return { ...comparison, blockers, claimable: blockers.length === 0 };
}

export function modeOf(runs: readonly RunMeasurement[]): BenchMode {
  if (runs.length === 0 || runs.every((r) => r.simulated)) return "SIMULATED";
  const liveModels = runs.every((r) => r.modelCalls > 0 && r.liveModelCalls === r.modelCalls);
  if (liveModels && runs.every((r) => r.simulatedToolCalls === 0)) return "LIVE";
  return liveModels ? "LIVE_MODELS_FIXTURE_WEB" : "MIXED";
}

/** How many records per run the job asked for, and how the benchmark asked (--records or the default answer). */
export interface Volume {
  /** The scoping answer to "how many records per run?" ("10"). */
  answer: string | null;
  /** --records, or null when the answer was the question's first suggestion. */
  requested: number | null;
  /** The spec's deliverable.targetCount that answer produced. */
  target: number | null;
}

export interface BenchReport {
  schemaVersion: 2;
  generatedAt: string;
  mode: BenchMode;
  modeLabel: string;
  job: { description: string; title: string; jobFamily: string; deliverable: string };
  settings: { pairsRequested: number; baselines: BaselineId[]; beforeTier: string; budgetUsd: number | null; design: string; volume: Volume };
  environment: Record<string, unknown>;
  arms: Partial<Record<ArmId, ArmInfo & { summary: ArmSummary }>>;
  sharedComponents: string[];
  comparisons: Partial<Record<BaselineId, Comparison>>;
  headline: string;
  headlines: Partial<Record<BaselineId, string>>;
  /** Sentences the owner may quote from THIS report, and what a live run would let them say. */
  wording: { mayQuote: string[]; liveTemplate: string };
  pairs: PairRecord[];
  standIn: { answered: number; fellBack: number } | null;
  stoppedEarly: string | null;
  cleanup: { workspaceDeleted: boolean; leftoverRows: number; note: string } | null;
  caveats: string[];
}
