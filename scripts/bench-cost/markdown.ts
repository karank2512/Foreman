import type { BaselineId } from "./args";
import type { ArmId } from "./measure";
import { armPairCost, type ArmInfo, type ArmSummary, type BenchReport, type Comparison } from "./report";

/** The Markdown version of a BenchReport. Pure. */

const usd = (n: number | null) => (n === null ? "—" : Math.abs(n) >= 0.001 || n === 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`);
const num = (n: number | null, digits = 0) => (n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
const score = (n: number | null) => (n === null ? "—" : n.toFixed(1));
// A deterministic simulation gives zero-width intervals that mean nothing, so they are only shown for real runs.
const ciUsd = (c: Comparison, sim: boolean) => (!sim && c.savedUsdCi95 ? ` (95% CI ${usd(c.savedUsdCi95.low)} – ${usd(c.savedUsdCi95.high)})` : "");
const ciPct = (c: Comparison, sim: boolean) => (!sim && c.cutPctCi95 ? ` (95% CI ${pct(c.cutPctCi95.low)} – ${pct(c.cutPctCi95.high)})` : "");
const ARM_TITLES: Record<ArmId, string> = { after: "AFTER (Foreman)", per_step: "Per-step baseline", merged: "Merged baseline" };

function armsOf(report: BenchReport): Array<{ id: ArmId; info: ArmInfo & { summary: ArmSummary } }> {
  return (["after", ...report.settings.baselines] as ArmId[]).flatMap((id) => {
    const info = report.arms[id];
    return info ? [{ id, info }] : [];
  });
}

function comparisonRows(report: BenchReport): string[] {
  const ids = report.settings.baselines.filter((id) => report.comparisons[id]);
  if (ids.length === 0) return [];
  const sim = report.mode === "SIMULATED";
  const cell = (pick: (c: Comparison) => string) => ids.map((id) => pick(report.comparisons[id] as Comparison)).join(" | ");
  const fidelity = (c: Comparison) => {
    if (sim) return "n/a (equal by construction)";
    const f = c.fidelity;
    if (f.pairsChecked === 0) return "not checked";
    const records = f.matchesAfter.records;
    return `${f.stepsExact}/${f.steps} steps exact; ${f.recordsMissing} lost/altered, ${f.recordsUnexpected} unexpected${records === undefined ? "" : `; final records = Foreman's in ${records}/${f.pairsChecked}`}`;
  };
  return [
    "## The comparison (complete pairs, same records)",
    "",
    `| | ${ids.map((id) => ARM_TITLES[id]).join(" | ")} |`,
    `| --- | ${ids.map(() => "---").join(" | ")} |`,
    `| Complete pairs | ${cell((c) => String(c.pairsCompared))} |`,
    `| **$ saved per run** by doing the steps in code | ${cell((c) => `**${usd(c.savedUsdPerRun)}**${ciUsd(c, sim)}`)} |`,
    `| The converted steps' own model cost per run | ${cell((c) => usd(c.convertedStepsUsdPerRun))} |`,
    `| Saving as % of the baseline's total metered cost per run (incl. review and search fees) | ${cell((c) => `${pct(c.cutPct)}${ciPct(c, sim)}`)} |`,
    `| … excluding Foreman's quality review | ${cell((c) => pct(c.cutPctExclReview))} |`,
    `| … model spend only (no review, no tool fees) | ${cell((c) => pct(c.cutPctModelOnly))} |`,
    `| Model calls removed per run | ${cell((c) => num(c.modelCallsRemovedPerRun, 1))} |`,
    `| Tokens (in + out), AFTER vs baseline | ${cell((c) => pct(c.tokensChangePct))} |`,
    `| Quality, baseline minus AFTER (checks · blended, points) | ${cell((c) => (sim ? "n/a (equal by construction)" : `${score(c.checksDelta)} · ${score(c.blendedDelta)}`))} |`,
    `| Did the model do the steps right? | ${cell(fidelity)} |`,
    `| Publishable as a launch figure? | ${cell((c) => (c.claimable ? "**yes**" : `no — ${c.blockers.join("; ")}`))} |`,
    "",
  ];
}

function summaryRows(report: BenchReport): string[] {
  const arms = armsOf(report);
  const sim = report.mode === "SIMULATED";
  const row = (label: string, pick: (s: ArmSummary, info: ArmInfo) => string) => `| ${label} | ${arms.map(({ info }) => pick(info.summary, info)).join(" | ")} |`;
  return [
    "## Each worker (successful runs; a baseline's cost includes the shared collector)",
    "",
    `| | ${arms.map(({ id }) => ARM_TITLES[id]).join(" | ")} |`,
    `| --- | ${arms.map(() => "---").join(" | ")} |`,
    row("Mean cost per run", (s) => usd(s.meanTotalUsd)),
    row("Median · min – max", (s) => `${usd(s.medianTotalUsd)} · ${usd(s.minTotalUsd)} – ${usd(s.maxTotalUsd)}`),
    row("Excl. quality review", (s) => usd(s.meanWorkUsd)),
    row("Model spend only", (s) => usd(s.meanModelOnlyUsd)),
    row("Mean input / output tokens", (s) => `${num(s.meanInputTokens)} / ${num(s.meanOutputTokens)}`),
    row("Model calls · tool calls per run", (s) => `${num(s.meanModelCalls, 1)} · ${num(s.meanToolCalls, 1)}`),
    row("Succeeded / runs", (s) => `${s.succeeded} / ${s.runs}`),
    row("Cost per successful deliverable (all spend ÷ successes)", (s) => usd(s.costPerSuccessUsd)),
    row("Quality: checks · reviewer · blended (0–100)", (s) => (sim ? "n/a (equal by construction)" : `${score(s.meanChecksScore)} · ${score(s.meanJudgeScore)} · ${score(s.meanRunScore)}`)),
    row("Records in the deliverable", (s) => num(s.meanRecords, 1)),
    row("Foreman's own estimate per run", (_s, info) => usd(info.foremanEstimatePerRunUsd)),
    row("Total spent (all runs)", (s) => usd(s.totalSpentUsd)),
    "",
  ];
}

function breakdownRows(report: BenchReport): string[] {
  const arms = armsOf(report);
  // Each component at its earliest position in any pipeline, so a merged step sits where the steps it replaces do.
  const position = new Map<string, number>();
  for (const { info } of arms) info.pipeline.forEach((p, i) => position.set(p.split(" ")[0], Math.min(position.get(p.split(" ")[0]) ?? i, i)));
  const keys = new Set<string>();
  for (const { info } of arms) for (const key of Object.keys(info.summary.breakdownMeanUsd)) keys.add(key);
  const rank = (k: string) => position.get(k) ?? (k === "evaluation.judge" ? 900 : 950);
  const sorted = [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [
    "## Where the money goes (mean per successful run)",
    "",
    `| | ${arms.map(({ id }) => ARM_TITLES[id]).join(" | ")} |`,
    `| --- | ${arms.map(() => "---").join(" | ")} |`,
    ...sorted.map((key) => {
      const label = key === "evaluation.judge" ? "quality review (judge)" : key === "tool fees" ? (report.mode === "SIMULATED" ? "tool fees (simulated)" : "tool fees (billed)") : `\`${key}\` (model)`;
      return `| ${label} | ${arms.map(({ info }) => usd(info.summary.breakdownMeanUsd[key] ?? 0)).join(" | ")} |`;
    }),
    "",
  ];
}

function pairRows(report: BenchReport): string[] {
  const lines = [
    "## Every pair",
    "",
    "| Pair | Worker | Status | Cost per run (paired) | This run metered | Tokens in / out | Model calls | Tool calls (simulated) | Wall s (this run) | Checks · reviewer · blended | Records | Steps exact |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const sim = report.mode === "SIMULATED";
  for (const pair of report.pairs) {
    for (const id of ["after", ...report.settings.baselines] as ArmId[]) {
      const run = id === "after" ? pair.after : pair.baselines[id as BaselineId];
      if (!run) continue;
      const paired = armPairCost(pair, id, report.mode);
      const fid = id === "after" ? null : pair.fidelity[id as BaselineId];
      const steps =
        id === "after" ? "—" : fid?.available ? `${fid.steps.filter((s) => s.exact).length}/${fid.steps.length}${sim ? " (by construction)" : ""}` : fid ? `n/a (${fid.note ?? "unavailable"})` : "—";
      const quality = sim ? "n/a (simulated)" : `${score(run.checksScore)} · ${score(run.judgeScore)} · ${score(run.runScore)}`;
      lines.push(
        `| ${pair.pair} | ${ARM_TITLES[id]} | ${run.status}${run.error ? ` (${run.error.replace(/\|/g, "/").slice(0, 80)})` : ""} | ${usd(paired?.totalUsd ?? null)} | ${usd(run.costUsd)} | ${num(paired?.inputTokens ?? null)} / ${num(paired?.outputTokens ?? null)} | ${paired?.modelCalls ?? "—"} | ${run.toolCalls} (${run.simulatedToolCalls}) | ${num(run.wallMs / 1000, 1)} | ${quality} | ${run.records ?? "—"} | ${steps} |`,
      );
    }
    if (!pair.replay.ok) lines.push(`| ${pair.pair} | — | not paired | | | | | | | | | ${pair.replay.note.replace(/\|/g, "/")} |`);
  }
  return [...lines, ""];
}

export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = ["# Foreman cost per run: mechanical steps in code vs by a model", "", `> **${report.modeLabel}**`, "", `**${report.headline}**`, ""];
  for (const id of report.settings.baselines) if (report.headlines[id]) lines.push(`- ${report.headlines[id]}`);
  lines.push(
    "",
    `- Job: ${report.job.title} (${report.job.jobFamily}) — “${report.job.description}”`,
    `- Design: ${report.settings.design}. ${report.settings.pairsRequested} pair(s) requested; converted steps on the **${report.settings.beforeTier}** tier.${report.settings.budgetUsd !== null ? ` Budget cap $${report.settings.budgetUsd.toFixed(2)}.` : ""}`,
    `- Volume: **${report.settings.volume.target ?? "no fixed number of"} records per run** asked for (scoping answer 'volume: ${report.settings.volume.answer ?? "none"}'${report.settings.volume.requested !== null ? ", set with --records" : ", the default"}).`,
    `- Shared by every pair (run once, in AFTER): ${report.sharedComponents.join(", ") || "nothing"}.`,
    `- Generated ${report.generatedAt}.`,
  );
  for (const [key, value] of Object.entries(report.environment)) lines.push(`- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  if (report.stoppedEarly) lines.push("", `**Stopped early:** ${report.stoppedEarly}`);

  lines.push("", "## What this report lets you say", "", ...report.wording.mayQuote.map((w) => `- “${w}”`), "", `A live run that passes every check would let you say: “${report.wording.liveTemplate}”`, "");

  lines.push("## The workers", "", "| | Pipeline | Model steps | Code steps |", "| --- | --- | --- | --- |");
  for (const { id, info } of armsOf(report)) lines.push(`| **${ARM_TITLES[id]}** — ${info.label} | ${info.pipeline.join(" → ")} | ${info.modelSteps} | ${info.codeSteps} |`);
  lines.push("", ...comparisonRows(report), ...summaryRows(report), ...breakdownRows(report), ...pairRows(report));

  if (report.standIn) {
    lines.push(`Simulated stand-in for converted steps: answered ${report.standIn.answered} turn(s), fell back to the regular mock brain ${report.standIn.fellBack} time(s).`, "");
  }
  lines.push("## Read this before quoting a number", "", ...report.caveats.map((cv) => `- ${cv}`));
  if (report.cleanup) lines.push("", "## Cleanup", "", `- ${report.cleanup.note}`);
  return `${lines.join("\n")}\n`;
}
