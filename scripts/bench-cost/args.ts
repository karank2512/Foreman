import { ModelTierSchema, type ModelTier } from "@/server/domain/blueprint";
import type { ScopingQuestions } from "@/server/domain/job-spec";

/** Command-line flags of `scripts/bench-cost.ts`. Pure: no environment, no I/O. */

export const DEFAULT_RUNS = 3;
export const MAX_RUNS = 20;
export const DEFAULT_OUT = "bench-cost-report";
/** Organization.monthlyBudgetUsd has cent precision, and a $0 budget there means "no cap". */
export const MIN_BUDGET_USD = 0.01;
/** Fewer paired live runs than this cannot support a published percentage (see report.ts). */
export const MIN_PAIRS_FOR_CLAIM = 5;
/** Simulated collectors and extract_data both stop at 100 records a run (simulation/brain/quality.ts, simulation/extract.ts). */
export const MAX_RECORDS = 100;
/** The scoping question "How many records per run is ideal?" (staffing/families.ts VOLUME_Q). */
export const VOLUME_QUESTION_ID = "volume";

/** Baseline shapes (mirrors BASELINE_SHAPES in src/server/staffing/all-agent-baseline.ts). */
export type BaselineId = "per_step" | "merged";
export const BASELINE_IDS: readonly BaselineId[] = ["per_step", "merged"];

export interface BenchArgs {
  /** Paired runs: each pair is one AFTER run plus one run of every baseline on the same collected records. */
  runs: number;
  /** Report path without extension; `.json` and `.md` are written next to each other. */
  out: string;
  beforeTier: ModelTier;
  baselines: BaselineId[];
  /**
   * Records per run, given as the customer's answer to the scoping volume question. Unset: the question's first
   * suggestion, like every other answer (10 for the funding tracker).
   */
  records?: number;
  live: boolean;
  budgetUsd?: number;
  /** --live without TAVILY_API_KEY: allowed only with this flag, and never produces a launch figure. */
  allowFixtureWeb: boolean;
  yes: boolean;
  help: boolean;
}

export class BenchUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchUsageError";
  }
}

export const USAGE = `Usage: npx tsx scripts/bench-cost.ts [options]

Measures Foreman's cost per run for one fixed job (the funding-tracker example), in PAIRS of runs on the same
collected records:
  AFTER      the worker Foreman designs: collector + analyst agents, the mechanical steps in code
  per-step   the same worker with each mechanical step done by its own model call (5 calls)
  merged     the same, with validate + dedupe + rank sharing one model call (3 calls)
Each pair runs the collector once (in AFTER) and replays its output into the baselines, so collector noise
cancels out of the comparison.

Options:
  --runs <n>               paired runs (default ${DEFAULT_RUNS}, max ${MAX_RUNS}; a live launch figure needs ${MIN_PAIRS_FOR_CLAIM}+)
  --out <path>             report path; writes <path>.json and <path>.md (default ./${DEFAULT_OUT})
  --baseline <which>       per-step | merged | both (default both)
  --before-tier <tier>     model tier for the baselines' converted steps: fast (default, cheapest) | standard | reasoning
  --records <n>            records per run (1–${MAX_RECORDS}), answered to the scoping "how many per run?" question
                           (default: its first suggestion, 10)
  --live                   use your real provider keys (costs money; needs --budget-usd and TAVILY_API_KEY)
  --budget-usd <usd>       hard spending cap for a --live benchmark (at least $${MIN_BUDGET_USD.toFixed(2)})
  --allow-fixture-web      with --live and no TAVILY_API_KEY: search the fixture web (never a launch figure)
  --yes                    skip the interactive confirmation before the first live call
  -h, --help               show this help

Without --live everything runs in Simulated mode and costs nothing, whatever keys are configured.
DATABASE_URL must name a dedicated database whose name ends in "_test" (live runs included; there is no override);
anything else is refused before a connection is opened. The benchmark works in its own temporary workspace there and
always deletes it.`;

function flagValue(argv: readonly string[], i: number, flag: string): { value: string; consumed: number } {
  const arg = argv[i];
  if (arg.includes("=")) return { value: arg.slice(arg.indexOf("=") + 1), consumed: 1 };
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) throw new BenchUsageError(`${flag} needs a value.`);
  return { value: next, consumed: 2 };
}

/** "--live=false" must not mean "live": a switch given a value is a mistake, never a guess. */
function switchFlag(arg: string, flag: string): void {
  if (arg !== flag) throw new BenchUsageError(`${flag} is a switch and takes no value (got "${arg}"). Leave it out to turn it off.`);
}

function stripReportExtension(path: string): string {
  return path.replace(/\.(json|md)$/i, "");
}

function parseBaselines(value: string): BaselineId[] {
  switch (value.trim().toLowerCase()) {
    case "per-step":
    case "per_step":
      return ["per_step"];
    case "merged":
      return ["merged"];
    case "both":
      return [...BASELINE_IDS];
    default:
      throw new BenchUsageError(`--baseline must be per-step, merged or both (got "${value}").`);
  }
}

export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const args: BenchArgs = {
    runs: DEFAULT_RUNS,
    out: DEFAULT_OUT,
    beforeTier: "fast",
    baselines: [...BASELINE_IDS],
    live: false,
    allowFixtureWeb: false,
    yes: false,
    help: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const flag = arg.split("=")[0];
    switch (flag) {
      case "--runs": {
        const { value, consumed } = flagValue(argv, i, flag);
        const runs = Number(value);
        if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new BenchUsageError(`--runs must be a whole number from 1 to ${MAX_RUNS} (got "${value}").`);
        args.runs = runs;
        i += consumed;
        break;
      }
      case "--out": {
        const { value, consumed } = flagValue(argv, i, flag);
        if (value.trim().length === 0) throw new BenchUsageError("--out needs a path.");
        args.out = stripReportExtension(value.trim());
        i += consumed;
        break;
      }
      case "--baseline": {
        const { value, consumed } = flagValue(argv, i, flag);
        args.baselines = parseBaselines(value);
        i += consumed;
        break;
      }
      case "--before-tier": {
        const { value, consumed } = flagValue(argv, i, flag);
        const tier = ModelTierSchema.safeParse(value);
        if (!tier.success) throw new BenchUsageError(`--before-tier must be fast, standard or reasoning (got "${value}").`);
        args.beforeTier = tier.data;
        i += consumed;
        break;
      }
      case "--records": {
        const { value, consumed } = flagValue(argv, i, flag);
        const records = Number(value);
        if (!Number.isInteger(records) || records < 1 || records > MAX_RECORDS) throw new BenchUsageError(`--records must be a whole number from 1 to ${MAX_RECORDS} (got "${value}").`);
        args.records = records;
        i += consumed;
        break;
      }
      case "--budget-usd": {
        const { value, consumed } = flagValue(argv, i, flag);
        const budget = Number(value.replace(/^\$/, ""));
        if (!Number.isFinite(budget) || budget < MIN_BUDGET_USD) throw new BenchUsageError(`--budget-usd must be a dollar amount of at least ${MIN_BUDGET_USD} (got "${value}").`);
        args.budgetUsd = budget;
        i += consumed;
        break;
      }
      case "--live":
        switchFlag(arg, flag);
        args.live = true;
        i += 1;
        break;
      case "--allow-fixture-web":
        switchFlag(arg, flag);
        args.allowFixtureWeb = true;
        i += 1;
        break;
      case "--yes":
      case "-y":
        switchFlag(arg, flag);
        args.yes = true;
        i += 1;
        break;
      case "--help":
      case "-h":
        switchFlag(arg, flag);
        args.help = true;
        i += 1;
        break;
      default:
        throw new BenchUsageError(`Unknown option "${arg}". Run with --help for the list.`);
    }
  }
  return args;
}

/**
 * The answers the benchmark gives the scoping step: every question's first suggestion (what a customer clicking
 * through the defaults would answer), except the volume question when --records is set, which gets that number the
 * way a customer would type it.
 */
export function scopingAnswers(questions: ScopingQuestions["questions"], records?: number): Record<string, string> {
  const answers: Record<string, string> = Object.fromEntries(questions.map((q) => [q.id, q.suggestions[0] ?? ""]));
  if (records === undefined) return answers;
  if (!questions.some((q) => q.id === VOLUME_QUESTION_ID)) {
    throw new BenchUsageError("The scoping step did not ask how many records per run, so --records cannot be applied to this job.");
  }
  answers[VOLUME_QUESTION_ID] = String(records);
  return answers;
}
