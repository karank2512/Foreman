import { EXAMPLE_JOBS } from "@/app/(app)/hire/schema";
import { db } from "@/server/db";
import type { WorkerBlueprint } from "@/server/domain";
import { llm } from "@/server/models";
import { MODEL_PRICES, PRICING_VERIFIED_ON, TIER_REFERENCE_MODELS } from "@/server/models/pricing";
import { cancelRun } from "@/server/runtime";
import { estimateCost } from "@/server/staffing";
import { MIN_PAIRS_FOR_CLAIM, VOLUME_QUESTION_ID, type BaselineId, type BenchArgs } from "./args";
import { installAnswerTap, sharedPrefixLength } from "./capture";
import { gitDescription } from "./git";
import type { ArmId, RunMeasurement } from "./measure";
import { runPair } from "./pair";
import { compareBaseline, modeOf, summarizeArm, type ArmInfo, type BenchReport, type Comparison, type PairRecord, type Volume } from "./report";
import { assertSimulatedEnvironment, capCoversFirstPair, confirmLiveSpend, estimateNextRunUsd, gateNextRun, plannedSpendUsd, workspaceBudgetUsd, type SpendPlan } from "./safety";
import { installStandIns } from "./stand-in";
import { baselineHeadline, caveats, modeLabel, overallHeadline, suggestedWording, type CollectorReading } from "./wording";
import { countLeftoverWorkspaces, createBenchWorkspace, deleteBenchWorkspace, hireBenchWorkers, type CleanupResult, type HiredWorkers } from "./workspace";

/** Orchestrates one benchmark: workspace → hire the workers → pairs → measurements → report → cleanup. */

export interface BenchControl {
  stopRequested(): boolean;
  /** Set by the benchmark so a signal handler can stop spending and clean up. */
  onCancel?: () => Promise<void>;
  onCleanup?: () => Promise<CleanupResult>;
}

export type BenchOutcome = { kind: "report"; report: BenchReport } | { kind: "declined"; cleanup: CleanupResult };

const FUNDING_TRACKER_ID = "funding-tracker";
export const ARM_LABELS: Record<ArmId, string> = {
  after: "Foreman's design (mechanical steps in code)",
  per_step: "all-agent, one model call per mechanical step",
  merged: "all-agent, record cleaning merged into one model call",
};
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 6 : 4)}`;

/**
 * How the report and console name the database: a constant, never anything taken from DATABASE_URL. A malformed URL
 * the *_test guard still accepts (an unencoded "/" in a password, e.g. postgresql://u:12/<password>@h_test) parses
 * with credentials in its host or database name, so no part of it — not even the validated name — is safe to print.
 */
export function databaseLabel(): string {
  return "dedicated *_test database";
}

function withoutCost(bp: WorkerBlueprint): Omit<WorkerBlueprint, "costEstimate"> {
  const copy: Partial<WorkerBlueprint> = { ...bp };
  delete copy.costEstimate;
  return copy as Omit<WorkerBlueprint, "costEstimate">;
}
/** Foreman's estimate re-priced at the CURRENT routing (live models when live, reference prices when simulated). */
const foremanEstimate = (bp: WorkerBlueprint) => estimateCost(withoutCost(bp));

/** What a pair should cost by Foreman's estimates: AFTER in full, each baseline minus the shared components. */
function pairEstimateUsd(hired: HiredWorkers, prefixIds: readonly string[]): number {
  const after = foremanEstimate(hired.after.blueprint).perRunUsd;
  const baselines = Object.values(hired.baselines).map((b) => {
    const estimate = foremanEstimate(b.blueprint);
    const shared = estimate.breakdown.filter((item) => prefixIds.includes(item.componentId)).reduce((s, item) => s + item.costUsd, 0);
    return Math.max(0, estimate.perRunUsd - shared);
  });
  return after + baselines.reduce((s, n) => s + n, 0);
}

function armInfo(arm: ArmId, bp: WorkerBlueprint, converted: ReadonlyMap<string, readonly { id: string }[]> = new Map()): ArmInfo {
  return {
    label: ARM_LABELS[arm],
    workerName: bp.persona.name,
    pipeline: bp.components.map((c) => (c.type === "agent" ? `${c.id} (model, ${c.modelTier})` : `${c.id} (code)`)),
    modelSteps: bp.components.filter((c) => c.type === "agent").length,
    codeSteps: bp.components.filter((c) => c.type === "deterministic").length,
    codeOperations: bp.components.flatMap((c) => (c.type === "deterministic" ? [c.operation] : [])),
    converted: Object.fromEntries([...converted].map(([id, steps]) => [id, steps.map((s) => s.id)])),
    foremanEstimatePerRunUsd: foremanEstimate(bp).perRunUsd,
  };
}

async function spentSoFar(organizationId: string): Promise<number> {
  const [runs, real] = await Promise.all([
    db.run.aggregate({ where: { organizationId }, _sum: { costUsd: true } }),
    db.orgSpendMonth.aggregate({ where: { organizationId }, _sum: { costUsd: true } }),
  ]);
  return Math.max(Number(runs._sum.costUsd ?? 0), Number(real._sum.costUsd ?? 0));
}

function printLivePlan(plan: Extract<SpendPlan, { mode: "live" }>, args: BenchArgs, pairUsd: number): void {
  const tiers = llm.status().tiers;
  console.log("\nLIVE benchmark plan");
  console.log(`  Model routing: ${(["fast", "standard", "reasoning"] as const).map((t) => `${t} → ${tiers[t].provider}:${tiers[t].model}`).join(", ")}`);
  console.log(`  Keys in use: ${plan.providerKeys.join(", ")}${plan.liveWebSearch ? ", TAVILY_API_KEY" : ""} (values never shown)`);
  console.log(`  Web search: ${plan.liveWebSearch ? "live (Tavily, billed per search)" : "FIXTURE WEB (--allow-fixture-web): this run can never produce a launch figure"}`);
  console.log(`  Pairs: ${args.runs} × (one AFTER run + ${args.baselines.length} baseline run(s) that reuse its collector). The workers were designed in Simulated mode ($0).`);
  if (args.runs < MIN_PAIRS_FOR_CLAIM) console.log(`  Note: ${args.runs} pair(s) is below the ${MIN_PAIRS_FOR_CLAIM} a publishable figure needs; use --runs ${MIN_PAIRS_FOR_CLAIM} or more for that.`);
  console.log(`  Foreman's estimate: about ${usd(pairUsd)} per pair → about ${usd(plannedSpendUsd(args.runs, pairUsd))} for the plan.`);
  console.log(`  Budget cap: $${plan.budgetUsd.toFixed(2)}. The benchmark stops before any pair whose estimate could pass it, and the`);
  console.log(`  workspace's own budget is $${workspaceBudgetUsd(plan.budgetUsd).toFixed(2)}, so Foreman refuses model calls beyond it`);
  console.log("  (overshoot ≤ one in-flight model call plus the web searches it already requested, about $0.008 each).\n");
}

function progressLine(m: RunMeasurement): string {
  const name = { after: "AFTER   ", per_step: "PER-STEP", merged: "MERGED  " }[m.arm];
  // A simulated score compares mock reviews of deliverables that are equal by construction: not shown.
  const score = m.simulated ? "" : `  score ${m.runScore === null ? "—" : m.runScore.toFixed(1)}`;
  return `  pair ${m.pair}  ${name}  ${m.status.padEnd(9)}  ${usd(m.costUsd)} metered  ${m.inputTokens.toLocaleString("en-US")} in / ${m.outputTokens.toLocaleString("en-US")} out  ${m.modelCalls} model calls  ${(m.wallMs / 1000).toFixed(1)} s${score}${m.simulated ? "  [simulated]" : ""}`;
}

function referencePrices(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(TIER_REFERENCE_MODELS).map(([tier, key]) => [tier, `${key} ($${MODEL_PRICES[key].inputPerMTok} in / $${MODEL_PRICES[key].outputPerMTok} out per MTok)`]),
  );
}

/** AFTER's mean web searches and page reads per successful run (the collector is the only component with tools). */
function collectorReading(pairs: readonly PairRecord[]): CollectorReading | null {
  const ok = pairs.map((p) => p.after).filter((m) => m.status === "SUCCEEDED");
  if (ok.length === 0) return null;
  const mean = (tool: string) => Math.round((ok.reduce((s, m) => s + (m.toolCallsByName[tool] ?? 0), 0) / ok.length) * 10) / 10;
  return { searches: mean("web_search"), pages: mean("fetch_url") };
}

/** Baselines alternate who goes first after AFTER, so neither always runs right behind it. */
export function baselineOrder(baselines: readonly BaselineId[], pair: number): BaselineId[] {
  return pair % 2 === 1 ? [...baselines] : [...baselines].reverse();
}

export async function runBenchmark(args: BenchArgs, plan: SpendPlan, control: BenchControl): Promise<BenchOutcome> {
  const example = EXAMPLE_JOBS.find((j) => j.id === FUNDING_TRACKER_ID);
  if (!example) throw new Error(`The "${FUNDING_TRACKER_ID}" example job is missing from the hire flow.`);
  if (plan.mode === "simulated") assertSimulatedEnvironment(process.env);
  const leftovers = await countLeftoverWorkspaces();
  if (leftovers > 0) console.warn(`Note: ${leftovers} benchmark workspace(s) from an earlier interrupted run are still in this database (organizations named "Foreman cost benchmark (temporary)"). Delete them to remove what they hold.`);

  // One cent when simulated: if anything ever did reach a paid API, Foreman's own guard would stop it there.
  const workspace = await createBenchWorkspace(plan.mode === "live" ? workspaceBudgetUsd(plan.budgetUsd) : 0.01);
  console.log(`Temporary workspace ${workspace.slug} created in ${databaseLabel()}.`);
  // Memoized: the finally below and a Ctrl+C handler may both ask, and both must get the same verdict.
  let cleanup: Promise<CleanupResult> | null = null;
  const runCleanup = () => (cleanup ??= deleteBenchWorkspace(workspace));
  control.onCleanup = runCleanup;

  let standIn: ReturnType<typeof installStandIns> | null = null;
  let tap: ReturnType<typeof installAnswerTap> | null = null;
  let currentRunId: string | null = null;
  control.onCancel = async () => {
    if (currentRunId) await cancelRun(workspace.session, currentRunId).catch(() => undefined);
  };

  try {
    // Setup is always simulated: the design is deterministic and free, live or not.
    process.env.FORCE_SIMULATED = "true";
    console.log(`Designing and hiring Foreman's worker and ${args.baselines.length} baseline(s) (Simulated mode, $0)…`);
    const hired = await hireBenchWorkers(workspace, example.description, args.beforeTier, args.baselines, args.records);
    const baselineList = args.baselines.flatMap((id) => (hired.baselines[id] ? [{ id, ...hired.baselines[id] }] : []));
    const prefixLength = sharedPrefixLength(hired.after.blueprint, baselineList.map((b) => b.blueprint));
    const prefixIds = hired.after.blueprint.components.slice(0, prefixLength).map((c) => c.id);

    let pairUsd = pairEstimateUsd(hired, prefixIds);
    if (plan.mode === "live") {
      delete process.env.FORCE_SIMULATED; // routing only, to price the plan; nothing is called before the confirmation
      pairUsd = pairEstimateUsd(hired, prefixIds);
      printLivePlan(plan, args, pairUsd);
      process.env.FORCE_SIMULATED = "true";
      const fits = capCoversFirstPair(plan.budgetUsd, pairUsd);
      if (!fits.allowed) {
        console.log(`Not starting: ${fits.reason}`);
        return { kind: "declined", cleanup: await runCleanup() };
      }
      if (!(await confirmLiveSpend(args, plan.budgetUsd))) {
        console.log("Not confirmed. Nothing was spent.");
        return { kind: "declined", cleanup: await runCleanup() };
      }
      delete process.env.FORCE_SIMULATED;
    } else {
      standIn = installStandIns(baselineList);
      assertSimulatedEnvironment(process.env);
    }
    tap = installAnswerTap();
    const arms: BenchReport["arms"] = {};
    const infos: Partial<Record<ArmId, ArmInfo>> = { after: armInfo("after", hired.after.blueprint) };
    for (const b of baselineList) infos[b.id] = armInfo(b.id, b.blueprint, b.converted);

    const pairs: PairRecord[] = [];
    const measurements: RunMeasurement[] = [];
    let stoppedEarly: string | null = null;
    console.log(`Running ${args.runs} pair(s)${plan.mode === "live" ? " (LIVE)" : " (SIMULATED)"}…`);
    for (let pair = 1; pair <= args.runs; pair++) {
      if (control.stopRequested()) {
        stoppedEarly = "interrupted by the user";
        break;
      }
      if (plan.mode === "live") {
        const observed = pairs.map((p) => [p.after, ...Object.values(p.baselines)].reduce((s, m) => s + (m?.costUsd ?? 0), 0));
        const gate = gateNextRun({ budgetUsd: plan.budgetUsd, spentUsd: await spentSoFar(workspace.organizationId), nextEstimateUsd: estimateNextRunUsd({ observedUsd: observed, foremanEstimateUsd: pairUsd }) });
        if (!gate.allowed) {
          stoppedEarly = gate.reason;
          console.log(`  ${gate.reason}`);
          break;
        }
      } else {
        assertSimulatedEnvironment(process.env);
      }
      const record = await runPair(
        {
          workspace,
          hired,
          tap,
          prefixLength,
          stopRequested: control.stopRequested,
          setCurrentRun: (id) => {
            currentRunId = id;
          },
          onRun: (m) => {
            measurements.push(m);
            console.log(progressLine(m));
          },
        },
        pair,
        baselineOrder(args.baselines, pair),
      );
      pairs.push(record);
      if (control.stopRequested() && !stoppedEarly) stoppedEarly = "interrupted by the user";
    }

    const [liveModelCalls, realSpend, searches] = await Promise.all([
      db.modelCall.count({ where: { organizationId: workspace.organizationId, simulated: false } }),
      db.orgSpendMonth.aggregate({ where: { organizationId: workspace.organizationId }, _sum: { costUsd: true } }),
      db.usageRecord.groupBy({ by: ["simulated"], where: { organizationId: workspace.organizationId, kind: "TOOL", resource: "web_search" }, _count: { _all: true } }),
    ]);
    const searchCount = (simulated: boolean) => searches.find((s) => s.simulated === simulated)?._count._all ?? 0;
    const realSpendUsd = Number(realSpend._sum.costUsd ?? 0);
    if (plan.mode === "simulated" && (liveModelCalls > 0 || realSpendUsd > 0)) {
      console.error(`WARNING: a simulated benchmark recorded ${liveModelCalls} live model call(s) and $${realSpendUsd.toFixed(6)} of real spend. Please report this.`);
    }

    const mode = modeOf(measurements);
    const models = [...new Set(measurements.flatMap((m) => m.models))].sort();
    const date = new Date().toISOString().slice(0, 10);
    const volume: Volume = { answer: hired.answers[VOLUME_QUESTION_ID] ?? null, requested: args.records ?? null, target: hired.spec.deliverable.targetCount ?? null };
    const records = volume.target;
    arms.after = { ...infos.after!, summary: summarizeArm(pairs, "after", mode) };
    const comparisons: Partial<Record<BaselineId, Comparison>> = {};
    const headlines: Partial<Record<BaselineId, string>> = {};
    for (const b of baselineList) {
      const convertedIds = new Set(b.converted.keys());
      arms[b.id] = { ...infos[b.id]!, summary: summarizeArm(pairs, b.id, mode, convertedIds) };
      const c = compareBaseline(pairs, b.id, mode, { runsRequested: args.runs, stoppedEarly, convertedIds });
      comparisons[b.id] = c;
      headlines[b.id] = baselineHeadline(c, mode, { after: infos.after!, baseline: infos[b.id]!, models, date, records });
    }
    const prices = referencePrices();
    const report: BenchReport = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      mode,
      modeLabel: modeLabel(mode, models),
      job: { description: example.description, title: hired.spec.title, jobFamily: hired.spec.jobFamily, deliverable: `${hired.spec.deliverable.title} (${hired.spec.deliverable.format})` },
      settings: {
        pairsRequested: args.runs,
        baselines: baselineList.map((b) => b.id),
        beforeTier: args.beforeTier,
        budgetUsd: plan.mode === "live" ? plan.budgetUsd : null,
        design: "paired — each pair runs Foreman's worker end to end, then every baseline from the records its collector returned (baselines alternate order)",
        volume,
      },
      environment: {
        "Foreman commit": gitDescription(),
        Database: databaseLabel(),
        "Scoping answers": hired.answers,
        "Price table verified": PRICING_VERIFIED_ON,
        ...(mode === "SIMULATED" ? { "Mock calls priced at": prices } : { "Models seen": models }),
        "Live model calls": liveModelCalls,
        "Web searches": `${searchCount(false)} live, ${searchCount(true)} simulated (fixture web)`,
        "Real provider spend": `$${realSpendUsd.toFixed(6)}`,
        "Metering drift (max |Run.costUsd − ledger|)": `$${Math.max(0, ...measurements.map((m) => m.meteringDriftUsd)).toFixed(6)}`,
      },
      arms,
      sharedComponents: prefixIds,
      comparisons,
      headline: overallHeadline(Object.values(comparisons), mode, records),
      headlines,
      wording: suggestedWording({ mode, after: infos.after!, baselines: infos, comparisons, headlines, records, referencePrices: `${TIER_REFERENCE_MODELS.fast} (fast tier) and ${TIER_REFERENCE_MODELS.standard} (standard tier) list prices` }),
      pairs,
      standIn: standIn ? { ...standIn.stats } : null,
      stoppedEarly,
      cleanup: null,
      caveats: caveats(mode, args.beforeTier, PRICING_VERIFIED_ON, volume, collectorReading(pairs)),
    };
    return { kind: "report", report };
  } finally {
    tap?.uninstall();
    standIn?.uninstall();
    process.env.FORCE_SIMULATED = "true";
    await runCleanup();
  }
}

/** Attach the cleanup verdict (known only after the finally above) to the report. */
export function withCleanup(report: BenchReport, result: CleanupResult): BenchReport {
  return { ...report, cleanup: result };
}
