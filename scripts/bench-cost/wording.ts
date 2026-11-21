import type { BaselineId } from "./args";
import type { ArmInfo, BenchMode, Comparison, Volume } from "./report";

/**
 * Every sentence the report puts in front of a reader: mode labels, headlines, caveats and the wording the owner
 * may quote. Kept apart from the numbers so the rules for what may be said are in one place. Pure.
 */

export const BASELINE_LABELS: Record<BaselineId, string> = {
  per_step: "per-step baseline (one model call per mechanical step)",
  merged: "merged baseline (record cleaning in one model call)",
};

const OPERATION_NAMES: Record<string, string> = {
  validate_records: "validation",
  dedupe: "de-duplication",
  filter: "filtering",
  rank: "ranking",
  compute_stats: "statistics",
  to_csv: "CSV export",
  compile_report: "report layout",
};

const money = (n: number | null) => (n === null ? "—" : `$${n.toFixed(Math.abs(n) < 0.001 && n !== 0 ? 6 : 4)}`);
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
const listOf = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const DENOMINATOR = "of the baseline's total metered cost per run, incl. Foreman's quality review and search fees";
/** "; 50 records per run" — the volume every figure is tied to (nothing when unknown). */
const atVolume = (records: number | null | undefined) => (records ? `; ${records} records per run` : "");

export function modeLabel(mode: BenchMode, models: readonly string[]): string {
  switch (mode) {
    case "SIMULATED":
      return "SIMULATED — projected at reference prices from simulated token counts, not a live measurement. Real reasoning/thinking tokens are not included.";
    case "LIVE":
      return `LIVE — measured on ${models.join(", ")}`;
    case "LIVE_MODELS_FIXTURE_WEB":
      return `LIVE MODELS, FIXTURE WEB — the model calls were live (${models.join(", ")}) but web search used Foreman's fixture web (no TAVILY_API_KEY). Not a launch figure.`;
    case "MIXED":
      return `MIXED — some calls were simulated (${models.join(", ")}); treat as a projection, not a measurement.`;
  }
}

function fidelityPhrase(c: Comparison, mode: BenchMode): string {
  if (mode === "SIMULATED") return "Output quality is equal by construction in a simulation, so it is not compared.";
  const f = c.fidelity;
  if (f.pairsChecked === 0) return "The model-run steps could not be checked against the code.";
  const records = f.matchesAfter.records;
  const sameRecords = records === undefined ? "" : ` and the final records matched Foreman's in ${records} of ${f.pairsChecked}`;
  if (f.stepsExact === f.steps) return `The model reproduced the code's output exactly in all ${f.steps} converted steps of ${f.pairsChecked} pair(s)${sameRecords}.`;
  return `The model got ${f.stepsExact} of ${f.steps} converted-step outputs exactly right (${f.recordsMissing} record(s) lost or altered, ${f.recordsUnexpected} unexpected)${sameRecords}; Foreman's code is exact by construction.`;
}

const ci = (interval: { low: number; high: number } | null, fmt: (n: number) => string) => (interval ? `95% CI ${fmt(interval.low)}–${fmt(interval.high)}` : "no interval: fewer than 2 pairs");

export function baselineHeadline(c: Comparison, mode: BenchMode, info: { after: ArmInfo; baseline: ArmInfo; models: readonly string[]; date: string; records?: number | null }): string {
  const calls = Object.keys(info.baseline.converted).length;
  const steps = info.after.codeSteps;
  if (c.pairsCompared === 0) return `No comparison with the ${BASELINE_LABELS[c.baseline]}: no pair where both workers succeeded on the same records.`;
  const measured = `${money(c.savedUsdPerRun)} saved per run (${ci(c.savedUsdCi95, money)}), ${pct(c.cutPct)} ${DENOMINATOR} (${ci(c.cutPctCi95, (n) => `${n.toFixed(1)}%`)})`;
  if (mode === "SIMULATED") {
    return `PROJECTION ONLY (simulated, not a live measurement${atVolume(info.records)}) — vs the ${BASELINE_LABELS[c.baseline]}: doing the ${steps} mechanical steps in code instead of ${calls} model call(s) saves ${money(c.savedUsdPerRun)} per run, ${pct(c.cutPct)} ${DENOMINATOR}.`;
  }
  if (c.claimable) {
    return `On the funding-tracker benchmark (${c.pairsCompared} paired live runs on ${info.models.join(", ")}, ${info.date}${atVolume(info.records)}), doing the ${steps} mechanical steps in code instead of ${calls} model call(s) cost ${pct(c.cutPct)} less per run (${ci(c.cutPctCi95, (n) => `${n.toFixed(1)}%`)}; ${money(c.savedUsdPerRun)} saved per run, ${ci(c.savedUsdCi95, money)}) against the ${BASELINE_LABELS[c.baseline]}. ${fidelityPhrase(c, mode)}`;
  }
  return `NOT A LAUNCH FIGURE (${c.blockers.join("; ")}). Measured vs the ${BASELINE_LABELS[c.baseline]}: ${measured}. ${fidelityPhrase(c, mode)}`;
}

export function overallHeadline(comparisons: readonly Comparison[], mode: BenchMode, records?: number | null): string {
  const usable = comparisons.filter((c) => c.pairsCompared > 0 && c.cutPct !== null && c.savedUsdPerRun !== null);
  if (usable.length === 0) return "No comparison: no pair where Foreman's worker and a baseline both succeeded on the same records.";
  const cuts = usable.map((c) => c.cutPct as number);
  const saved = usable.map((c) => c.savedUsdPerRun as number);
  const range = (values: number[], fmt: (n: number) => string) => (Math.min(...values) === Math.max(...values) ? fmt(values[0]) : `${fmt(Math.min(...values))}–${fmt(Math.max(...values))}`);
  const span = `${range(saved, (n) => money(n))} per run, ${range(cuts, (n) => n.toFixed(1))}% ${DENOMINATOR}, depending on how the all-agent baseline is built (${usable.map((c) => c.baseline.replace("_", "-")).join(", ")})`;
  if (mode === "SIMULATED") return `PROJECTION ONLY (simulated, not a live measurement${atVolume(records)}): code instead of model calls for the mechanical steps saves ${span}.`;
  if (usable.every((c) => c.claimable)) return `Measured live: code instead of model calls for the mechanical steps saved ${span}. See the per-baseline lines for intervals and output fidelity.`;
  return `NOT A LAUNCH FIGURE — see the blockers below. Measured: code instead of model calls for the mechanical steps saved ${span}.`;
}

/** Sentences that are true of THIS report as it stands, plus the shape a publishable live sentence must take. */
export function suggestedWording(args: {
  mode: BenchMode;
  after: ArmInfo;
  baselines: Partial<Record<BaselineId, ArmInfo>>;
  comparisons: Partial<Record<BaselineId, Comparison>>;
  headlines: Partial<Record<BaselineId, string>>;
  referencePrices: string;
  records?: number | null;
}): { mayQuote: string[]; liveTemplate: string } {
  const { after } = args;
  const stepNames = after.codeOperations.map((op) => OPERATION_NAMES[op] ?? op.replace(/_/g, " "));
  const fewer = (id: BaselineId) => {
    const b = args.baselines[id];
    return b ? Object.keys(b.converted).length : null;
  };
  const perStep = fewer("per_step");
  const merged = fewer("merged");
  const callsLine =
    perStep !== null && merged !== null
      ? `${perStep} fewer model calls per run than a one-call-per-step all-agent version (${merged} fewer than one that merges the record cleaning into a single call)`
      : perStep !== null
        ? `${perStep} fewer model calls per run than a one-call-per-step all-agent version`
        : `${merged ?? 0} fewer model calls per run than an all-agent version that merges the record cleaning into a single call`;
  const mayQuote = [
    `On the funding-tracker worker, Foreman runs ${after.codeSteps} of its ${after.codeSteps + after.modelSteps} steps (${listOf(stepNames)}) as code instead of model calls: ${callsLine}, no tokens spent on those steps, and the same output for the same input every time.`,
  ];
  const ordered = (["per_step", "merged"] as const).map((id) => args.comparisons[id]).filter((c): c is Comparison => c !== undefined && c.pairsCompared > 0);
  if (args.mode === "SIMULATED" && ordered.length > 0) {
    const parts = ordered.map((c, i) => `${money(c.savedUsdPerRun)}${i === 0 ? " per run" : ""} (${pct(c.cutPct)}) against ${c.baseline === "per_step" ? "a one-call-per-step" : "a merged-cleaner"} baseline`);
    mayQuote.push(
      `A simulated projection (simulated token counts priced at ${args.referencePrices}; not a live measurement) puts the saving on the funding-tracker benchmark${args.records ? ` (${args.records} records per run)` : ""} at ${listOf(parts)}, the percentage being a share of total metered cost per run including quality review and search fees.`,
    );
  }
  if (args.mode === "LIVE") {
    for (const c of ordered) if (c.claimable && args.headlines[c.baseline]) mayQuote.push(args.headlines[c.baseline] as string);
  }
  return {
    mayQuote,
    liveTemplate:
      "On our open funding-tracker benchmark (N paired live runs on <model>, <date>, R records per run), doing the five mechanical steps in code instead of LLM calls cost X% less per run (95% CI a–b%; $Y saved per run), with identical records in K of N runs. Script and raw report: <link>.",
  };
}

/** What the collector read per run (AFTER's mean web searches and page reads), when it was measured. */
export interface CollectorReading {
  searches: number;
  pages: number;
}

function volumeCaveat(volume: Volume): string {
  const how = volume.requested !== null ? "set with --records" : "the scoping question's first suggestion";
  return `One job (the funding-tracker example) at one record volume: the scoping answer 'volume: ${volume.answer ?? "none"}' (${how}), a target of ${volume.target ?? "no fixed number of"} records per run. Every cost here belongs to that volume: the converted steps re-read and re-write every record, so the saving grows with it. Run --records N for another volume; other jobs were not measured.`;
}

export function caveats(mode: BenchMode, beforeTier: string, pricesVerified: string, volume: Volume, reading: CollectorReading | null = null): string[] {
  const shared = [
    "PAIRED DESIGN: each pair runs Foreman's worker end to end once; every baseline then starts after the collector, from the exact records that collector returned (rebuilt from its answer and checked against the AFTER run's own records). A baseline's cost per run = the collector's metered cost in that AFTER run + everything the baseline's own run metered.",
    "Headline percentages are a share of the baseline's TOTAL metered cost per run, which includes Foreman's quality review (one standard-tier judge call per run) and per-call tool fees; both dilute the percentage. The absolute $ saved per run and the converted steps' own cost are the primary numbers; 'excl. review' and 'model spend only' percentages are shown too.",
    `The baselines run their converted steps on the ${beforeTier} tier with one turn each and no tools. A hand-built workflow on a larger model, or with retries, would cost more; one that folds the mechanical work into its analyst call would cost less. The range across baselines is the honest answer, not either end of it.`,
    volumeCaveat(volume),
    'Do not phrase a result as "Foreman cut cost per run X%": there was no earlier Foreman that ran these steps on a model, and one benchmark job is not every workload. Say what was compared.',
    "A baseline run's own max-cost check sees only its own run (the collector ran in the AFTER run); the cost ceiling is far above either total here.",
    "Foreman meters every input token at the uncached price, so provider prompt caching never changes these numbers (it can lower your invoice).",
    "The worker design comes from Foreman's Simulated-mode scoping and designer (the market-research template), so it is identical for everyone who runs this benchmark; a live model's draft could differ.",
  ];
  if (mode === "SIMULATED") {
    return [
      'PROJECTED AT REFERENCE PRICES FROM SIMULATED TOKEN COUNTS — NOT A LIVE MEASUREMENT. Do not quote it as a measured saving; run with --live (and TAVILY_API_KEY) for that.',
      "Token counts are approximate in both directions: the mock provider counts characters ÷ 4 of the exact prompt and answer, and the prompt it counts is the JSON-serialized message list, whose escaped quotes and newlines inflate the converted steps' input; real tokenizers usually count JSON and Markdown tables at more tokens per character.",
      "Real reasoning/thinking tokens are not included; neither are retries, JSON repair turns or provider-side overhead.",
      "Converted steps are answered by a perfect stand-in (the code's own output as compact JSON): a baseline's cost is a floor, and its output equals Foreman's by construction — quality and fidelity are therefore not compared in a simulation.",
      "Collector, analyst and reviewer answers come from Foreman's deterministic mock brain over a fixture web, so every pair is identical and the confidence intervals have zero width: they carry no statistical information.",
      "Wall times include the mock provider's artificial 150–600 ms per model call; they are not latency measurements.",
      "The mock brain's fixture web and reviewer depend on today's date, so a projection run on another day can differ by a few hundredths of a cent per run; within one invocation every pair is identical.",
      `The simulated collector reads more when more is asked: its first read is 2 searches and 4 pages; when that finds fewer in-brief rounds than the target it searches for the full list of rounds and reads one 12-round page per 12 records short, plus one, from a generated long tail of fictional rounds (src/server/simulation/fixtures/long-tail.ts).${reading ? ` Here it made ${reading.searches} search(es) and ${reading.pages} page read(s) per run.` : ""} A live collector's reading would differ in size and price.`,
      ...shared,
    ];
  }
  return [
    `Measured at Foreman's price table (verified ${pricesVerified}). Provider invoices can differ (prompt caching, batch discounts, price changes).`,
    "Reasoning/thinking tokens are included only as far as the provider reports them in output tokens.",
    "The 95% interval of $ saved uses Student's t over the paired differences; the percentage interval is a 10,000-resample paired bootstrap (fixed seed). Both assume the pairs are independent draws of the same job.",
    "Output fidelity compares each converted step's answer with what Foreman's code returns for the exact input the model was given (the report footer's date line excluded, since the model is not told the date).",
    ...shared,
  ];
}
