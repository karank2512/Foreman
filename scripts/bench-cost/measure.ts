import { db } from "@/server/db";
import { runScore, type EvaluationWeights } from "@/server/evaluation";
import type { BaselineId } from "./args";

/**
 * Reads one finished run back out of Foreman's own metering. Nothing is re-priced here: the cost is Run.costUsd
 * (written only by usage.recordUsage), tokens are the Run rollups, and the per-component split sums the ModelCall
 * and ToolCall rows of the run. `meteringDriftUsd` checks the rollup against the ledger it was built from.
 */

export type ArmId = "after" | BaselineId;

/** What one pipeline component (or a non-agent call purpose such as "evaluation.judge") cost in this run. */
export interface ComponentCost {
  modelUsd: number;
  /** Per-call tool fees of the component's tool calls; `simulatedToolFeesUsd` is the part no service billed. */
  toolFeesUsd: number;
  simulatedToolFeesUsd: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCalls: number;
  simulatedToolCalls: number;
}

export interface RunMeasurement {
  arm: ArmId;
  /** 1-based pair number. */
  pair: number;
  runId: string;
  status: string;
  error: string | null;
  /** Run.simulated (tools) AND every model call of the run simulated. */
  simulated: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  failedModelCalls: number;
  liveModelCalls: number;
  toolCalls: number;
  /** Tool calls answered by Foreman's simulation (the fixture web) instead of a real service. */
  simulatedToolCalls: number;
  /** Tool calls by tool ("web_search", "fetch_url" …): how much the run read. */
  toolCallsByName: Record<string, number>;
  toolFeesUsd: number;
  simulatedToolFeesUsd: number;
  /** Foreman's quality review of the deliverable (evaluation.judge), billed to the run like any model call. */
  judgeUsd: number;
  /** Wall time of THIS run (a baseline run starts after the collector, so it excludes it). */
  wallMs: number;
  activeMs: number | null;
  /** Deterministic checks 0..100, LLM judge 0..100, and the run's blended score 0..100 (evaluation/score.ts). */
  checksScore: number | null;
  judgeScore: number | null;
  runScore: number | null;
  records: number | null;
  deliverableChars: number | null;
  byComponent: Record<string, ComponentCost>;
  /** Distinct "provider:model (tier)" seen on this run's model calls. */
  models: string[];
  /** |Run.costUsd − (model calls + tool fees)|: 0 when the rollup and the ledger agree. */
  meteringDriftUsd: number;
}

export const JUDGE_KEY = "evaluation.judge";
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const pct = (score: number | undefined) => (score === undefined ? null : Math.round(score * 1000) / 10);

export const emptyComponentCost = (): ComponentCost => ({
  modelUsd: 0,
  toolFeesUsd: 0,
  simulatedToolFeesUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  modelCalls: 0,
  toolCalls: 0,
  simulatedToolCalls: 0,
});

export function addComponentCost(a: ComponentCost, b: ComponentCost): ComponentCost {
  return {
    modelUsd: round6(a.modelUsd + b.modelUsd),
    toolFeesUsd: round6(a.toolFeesUsd + b.toolFeesUsd),
    simulatedToolFeesUsd: round6(a.simulatedToolFeesUsd + b.simulatedToolFeesUsd),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    modelCalls: a.modelCalls + b.modelCalls,
    toolCalls: a.toolCalls + b.toolCalls,
    simulatedToolCalls: a.simulatedToolCalls + b.simulatedToolCalls,
  };
}

export async function measureRun(args: {
  organizationId: string;
  runId: string;
  arm: ArmId;
  pair: number;
  wallMs: number;
  weights: EvaluationWeights;
}): Promise<RunMeasurement> {
  const { organizationId, runId } = args;
  const [run, calls, toolUsage, toolCalls, evaluations, deliverable] = await Promise.all([
    db.run.findFirstOrThrow({
      where: { id: runId, organizationId },
      select: { status: true, error: true, simulated: true, costUsd: true, inputTokens: true, outputTokens: true, durationMs: true },
    }),
    db.modelCall.findMany({
      where: { runId, organizationId },
      select: { purpose: true, provider: true, model: true, tier: true, costUsd: true, inputTokens: true, outputTokens: true, simulated: true, error: true, runStep: { select: { componentId: true } } },
    }),
    db.usageRecord.findMany({ where: { runId, organizationId, kind: "TOOL" }, select: { costUsd: true } }),
    // ToolCall has no organizationId of its own: scope it through its run.
    db.toolCall.findMany({ where: { runId, run: { organizationId } }, select: { toolName: true, costUsd: true, simulated: true, runStep: { select: { componentId: true } } } }),
    db.evaluation.findMany({ where: { runId, organizationId }, select: { type: true, score: true } }),
    db.deliverable.findFirst({ where: { runId, organizationId }, orderBy: { createdAt: "asc" }, select: { data: true, content: true } }),
  ]);

  const byComponent: Record<string, ComponentCost> = {};
  const slot = (key: string) => (byComponent[key] ??= emptyComponentCost());
  let ledger = 0;
  for (const call of calls) {
    const cost = Number(call.costUsd);
    ledger += cost;
    const c = slot(call.purpose === "agent.turn" ? (call.runStep?.componentId ?? "unknown") : call.purpose);
    c.modelUsd = round6(c.modelUsd + cost);
    c.inputTokens += call.inputTokens;
    c.outputTokens += call.outputTokens;
    c.modelCalls += 1;
  }
  for (const usage of toolUsage) ledger += Number(usage.costUsd);
  for (const tool of toolCalls) {
    const fee = Number(tool.costUsd);
    const c = slot(tool.runStep?.componentId ?? "unknown");
    c.toolFeesUsd = round6(c.toolFeesUsd + fee);
    c.toolCalls += 1;
    if (tool.simulated) {
      c.simulatedToolFeesUsd = round6(c.simulatedToolFeesUsd + fee);
      c.simulatedToolCalls += 1;
    }
  }

  const costUsd = Number(run.costUsd);
  const byType = (type: string) => evaluations.find((e) => e.type === type)?.score;
  const sum = (pick: (c: ComponentCost) => number) => round6(Object.values(byComponent).reduce((s, c) => s + pick(c), 0));
  return {
    arm: args.arm,
    pair: args.pair,
    runId,
    status: run.status,
    error: run.error,
    simulated: run.simulated && calls.every((c) => c.simulated),
    costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    modelCalls: calls.length,
    failedModelCalls: calls.filter((c) => c.error !== null).length,
    liveModelCalls: calls.filter((c) => !c.simulated).length,
    toolCalls: toolCalls.length,
    simulatedToolCalls: toolCalls.filter((t) => t.simulated).length,
    toolCallsByName: toolCalls.reduce<Record<string, number>>((by, t) => ({ ...by, [t.toolName]: (by[t.toolName] ?? 0) + 1 }), {}),
    toolFeesUsd: sum((c) => c.toolFeesUsd),
    simulatedToolFeesUsd: sum((c) => c.simulatedToolFeesUsd),
    judgeUsd: byComponent[JUDGE_KEY]?.modelUsd ?? 0,
    wallMs: args.wallMs,
    activeMs: run.durationMs,
    checksScore: pct(byType("DETERMINISTIC")),
    judgeScore: pct(byType("LLM_JUDGE")),
    runScore: runScore(run.status, evaluations, args.weights),
    records: Array.isArray(deliverable?.data) ? deliverable.data.length : null,
    deliverableChars: deliverable ? deliverable.content.length : null,
    byComponent,
    models: [...new Set(calls.map((c) => `${c.provider}:${c.model} (${c.tier})`))].sort(),
    meteringDriftUsd: round6(Math.abs(costUsd - ledger)),
  };
}
