import {
  WorkerBlueprintSchema,
  type AgentComponent,
  type BlueprintComponent,
  type DeterministicComponent,
  type ModelTier,
  type ReportSection,
  type WorkerBlueprint,
} from "@/server/domain";
import { AppError } from "@/server/errors";
import { estimateCost } from "./cost";

/**
 * The all-agent baselines: the same worker with its deterministic steps handed to a model instead, the way a
 * hand-built multi-agent workflow does its mechanical work (validate, dedupe, rank, stats, CSV, report layout).
 * `scripts/bench-cost.ts` runs them next to Foreman's design to measure what the deterministic steps save per run.
 *
 * Two shapes, because the saving depends heavily on how a baseline is built:
 *  - "per_step": one model call per mechanical step (the literal translation of Foreman's pipeline);
 *  - "merged":   consecutive in-place record steps (validate → dedupe → filter → rank) share ONE model call, the
 *                way many hand-built pipelines have a single "cleaner" agent; stats, CSV and the report stay separate
 *                because each writes a different output.
 *
 * PURE. Inputs, outputs, deliverable and evaluation are untouched, so only *who* does each step changes. The
 * instructions spell out the operation and its config precisely enough for a model to reproduce the code's result.
 * The default tier is the cheapest one, so a baseline's cost is a floor rather than a straw man.
 */

export const ALL_AGENT_BASELINE_DEFAULT_TIER: ModelTier = "fast";
export const BASELINE_SHAPES = ["per_step", "merged"] as const;
export type BaselineShape = (typeof BASELINE_SHAPES)[number];
/** One answer per step, like the code it replaces (the runtime still allows one JSON repair turn). */
const BASELINE_MAX_TURNS = 1;
const MAX_COMPONENT_ID = 48;

export interface AllAgentBaselineOptions {
  tier?: ModelTier;
  shape?: BaselineShape;
}

/** Which deterministic steps of the original a converted agent performs, in order. */
export interface ConvertedStep {
  componentId: string;
  replaces: DeterministicComponent[];
}

const STEP_RULES = [
  "You are one mechanical step in a data pipeline. Apply exactly the operation below to the input you are given — nothing more.",
  "Never research, add, correct, reword or invent data, and never comment on it.",
];
const MISSING_RULE = "A value is missing when the field is absent, null, an empty or whitespace-only string, or a non-finite number; false and 0 are real values.";
const NUMBER_RULE =
  'Read numbers the way an analyst would: 12500000, "12,500,000", "$12.5M", "12.5 million" and "3bn" are numbers, "(1,200)" is -1200, "18%" is 18, and "n/a" is not a number.';
const COPY_RULE = "Keep the records in the order given and copy every record you keep exactly: same fields, same values, nothing added.";

const quoted = (names: readonly string[]) => names.map((n) => `"${n}"`).join(", ");
const inputLine = (key: string) => `Input: the JSON array of records under "## ${key}".`;

// ── Record steps (in place: records in, records out) ────────────────────────

type RecordStep = Extract<DeterministicComponent, { operation: "validate_records" | "dedupe" | "rank" | "filter" }>;

/** A record step's rules, split so they can stand alone (one call per step) or be chained (merged). */
interface RecordStepRules {
  operation: string;
  rules: string[];
  /** The step keeps record order and content: the shared copy rule applies. */
  copyRule: boolean;
  answer: string;
}

const KEEP_ANSWER = "Answer with the JSON array of the records you keep.";

function validateRules(c: Extract<DeterministicComponent, { operation: "validate_records" }>): RecordStepRules {
  return {
    operation: `Operation: validate records (required: ${quoted(c.config.requiredFields)}).`,
    rules: [
      `A record is complete when every one of these fields has a value: ${quoted(c.config.requiredFields)}. ${MISSING_RULE}`,
      c.config.dropInvalid ? "Remove every incomplete record and keep the complete ones." : "Keep every record, complete or not: this step only checks.",
    ],
    copyRule: true,
    answer: KEEP_ANSWER,
  };
}

function dedupeRules(c: Extract<DeterministicComponent, { operation: "dedupe" }>): RecordStepRules {
  const keys = quoted(c.config.keyFields);
  return {
    operation: `Operation: remove duplicates by ${keys}.`,
    rules: [
      `Two records are duplicates when ${c.config.keyFields.length > 1 ? `all of ${keys} match` : `their ${keys} values match`} after lower-casing, trimming and collapsing runs of whitespace into one space. ${MISSING_RULE}`,
      "Keep the first record of each set of duplicates and drop the later ones. A record whose key fields are all missing is always kept.",
    ],
    copyRule: true,
    answer: KEEP_ANSWER,
  };
}

function rankRules(c: Extract<DeterministicComponent, { operation: "rank" }>): RecordStepRules {
  const { by, direction, limit } = c.config;
  const order = direction === "desc" ? "highest first" : "lowest first";
  return {
    operation: `Operation: rank by "${by}", ${order}${limit ? `, keeping the top ${limit}` : ""}.`,
    rules: [
      `Sort the records by "${by}", ${order}. ${NUMBER_RULE} Compare two values as numbers when both are numbers, otherwise as case-insensitive text; numbers sort before text. Records with a missing "${by}" go last. Ties keep their original order.`,
      limit ? `Keep only the first ${limit} records after sorting.` : "Keep every record.",
      'Add a field "rank" to every kept record: 1 for the first, 2 for the second, and so on. Copy every other field exactly as given.',
    ],
    copyRule: false,
    answer: "Answer with the JSON array of the ranked records, in rank order.",
  };
}

const FILTER_OPS: Record<Exclude<Extract<DeterministicComponent, { operation: "filter" }>["config"]["op"], "exists">, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  contains: "contains",
};

function filterRules(c: Extract<DeterministicComponent, { operation: "filter" }>): RecordStepRules {
  const { field, op, value } = c.config;
  const condition = op === "exists" ? `"${field}" has a value` : `"${field}" ${FILTER_OPS[op]} ${JSON.stringify(value)}`;
  const numeric = `Both sides must be numbers (${NUMBER_RULE}); a record whose value is missing or not a number never matches.`;
  const how: Record<typeof op, string> = {
    exists: MISSING_RULE,
    eq: `Compare as numbers when both sides are numbers (${NUMBER_RULE}), otherwise as text ignoring case and extra whitespace.`,
    neq: `Compare as numbers when both sides are numbers (${NUMBER_RULE}), otherwise as text ignoring case and extra whitespace. A missing value counts as not equal.`,
    contains: "A case-insensitive substring match; when the field holds a list, any item may match. A missing value never matches.",
    gt: numeric,
    gte: numeric,
    lt: numeric,
    lte: numeric,
  };
  return { operation: `Operation: keep only the records where ${condition}.`, rules: [`Keep a record when ${condition}. ${how[op]}`], copyRule: true, answer: KEEP_ANSWER };
}

function recordStepRules(c: RecordStep): RecordStepRules {
  switch (c.operation) {
    case "validate_records":
      return validateRules(c);
    case "dedupe":
      return dedupeRules(c);
    case "rank":
      return rankRules(c);
    case "filter":
      return filterRules(c);
  }
}

function singleRecordStep(c: RecordStep): string[] {
  const parts = recordStepRules(c);
  return [parts.operation, inputLine(c.inputKeys[0]), ...parts.rules, ...(parts.copyRule ? [COPY_RULE] : []), parts.answer];
}

function mergedRecordSteps(steps: readonly RecordStep[]): string[] {
  const ranks = steps.some((s) => s.operation === "rank");
  const lines = [`Operation: ${steps.length} steps in one pass. Apply them in this order, each to the records the previous step kept.`, inputLine(steps[0].inputKeys[0])];
  steps.forEach((s, i) => {
    const parts = recordStepRules(s);
    lines.push("", `Step ${i + 1} — ${parts.operation.replace(/^Operation: /, "")}`, ...parts.rules);
  });
  lines.push(
    "",
    ranks ? 'Apart from the "rank" field, copy every record you keep exactly: same fields, same values, nothing added.' : COPY_RULE,
    `Answer with the JSON array of the records after step ${steps.length}${ranks ? ", in rank order" : ""}.`,
  );
  return lines;
}

// ── Other steps ──────────────────────────────────────────────────────────────

function statsRules(c: Extract<DeterministicComponent, { operation: "compute_stats" }>): string[] {
  const { groupBy, numericFields } = c.config;
  return [
    `Operation: statistics${groupBy ? ` by "${groupBy}"` : ""}${numericFields.length > 0 ? ` with summaries of ${quoted(numericFields)}` : ""}.`,
    inputLine(c.inputKeys[0]),
    "Answer with ONE JSON object (not an array) shaped exactly like this:",
    '{"total": <number of records>, "groups": [{"key": "<value>", "count": <records>, "share": <count ÷ total, 4 decimals>}], "numeric": {"<field>": {"count": <n>, "sum": <n>, "mean": <n>, "min": <n>, "max": <n>, "median": <n>}}}',
    groupBy
      ? `"groups": one entry per distinct "${groupBy}" value (trimmed text; records with a missing value count under "unknown"), largest count first, ties in alphabetical order.`
      : '"groups": always an empty list.',
    numericFields.length > 0
      ? `"numeric": one entry for each of ${quoted(numericFields)} that has at least one numeric value, computed over the records where it is a number. ${NUMBER_RULE} Round sum, mean and median to 2 decimals.`
      : '"numeric": always an empty object.',
  ];
}

function csvRules(c: Extract<DeterministicComponent, { operation: "to_csv" }>): string[] {
  const columns = c.config.columns;
  return [
    "Operation: export the records as CSV.",
    inputLine(c.inputKeys[0]),
    "Answer with the CSV text only: no code fences, no commentary.",
    columns && columns.length > 0
      ? `Header row: exactly these columns, in this order: ${columns.join(", ")}.`
      : "Header row: every field name, in order of first appearance across the records.",
    "Then one line per record, in the order given. A missing value is an empty cell; a list or object is written as compact JSON.",
    "Quote a cell with double quotes when it contains a comma, a double quote or a line break, doubling any double quote inside it. Prefix a cell that starts with =, +, -, @, a tab or a carriage return with a single quote so a spreadsheet never runs it as a formula.",
    "Separate lines with a single newline and do not end with a blank line.",
  ];
}

function sectionRule(s: ReportSection): string {
  switch (s.as) {
    case "markdown":
      return `the text under "## ${s.sourceKey}", inserted exactly as given ("_No content._" when it is empty).`;
    case "table": {
      const columns = s.columns && s.columns.length > 0 ? `these columns, in order: ${s.columns.join(", ")}` : "every field (at most 8), in order of first appearance";
      const rows = s.maxRows ?? 25;
      return `a Markdown table of the records under "## ${s.sourceKey}" with ${columns}. Show at most ${rows} rows; when there are more, add a blank line and "_Showing ${rows} of <total> records._". An empty list is "_No records._".`;
    }
    case "bullets":
      return `a "- " bullet list of the items under "## ${s.sourceKey}"; a record is written "**<first field>** — <next fields joined with " · ">" (at most 4 fields).`;
    case "stats":
      return `the statistics under "## ${s.sourceKey}": the line "**<total> records** in total.", a blank line, a "| Group | Count | Share |" table (share as a whole percent), a blank line, and a "| Field | Count | Sum | Mean | Min | Max |" table of the numeric summaries.`;
  }
}

const TABLE_RULE =
  'In tables, headers humanize the field names (amount_usd → "Amount USD", source_url → "Source URL", lead_investor → "Lead investor"); a missing value is an empty cell; "|" inside a value is written "\\|"; numbers get thousands separators; money columns (names with usd, amount, price, cost, fee, spend, budget, revenue or valuation) are compact dollars such as $85M, $1.2K or $94; URL columns are [host](url) links.';

function reportRules(c: Extract<DeterministicComponent, { operation: "compile_report" }>, pipeline: readonly string[]): string[] {
  const { title, sections, includeMethodology } = c.config;
  const lines = [
    `Operation: assemble the "${title.trim()}" report from your inputs, exactly as laid out below.`,
    "This step only lays out what earlier steps produced: do not rewrite, summarize, reorder or add content.",
    "Answer with the Markdown report only, no code fences.",
    `1. The first line is "# ${title.trim()}", then a blank line.`,
    '2. Then each section in this order: a "## <heading>" line, a blank line, the section body, a blank line.',
    ...sections.map((s) => `   - "${s.heading.trim()}": ${sectionRule(s)}`),
  ];
  if (includeMethodology) {
    lines.push(`3. Last, a "## Methodology" section with the bullet lines "- Pipeline: ${pipeline.join(" → ")}." and "- Generated by <your name> · <today's date as YYYY-MM-DD>".`);
  }
  if (sections.some((s) => s.as === "table" || s.as === "stats")) lines.push(TABLE_RULE);
  return lines;
}

const isRecordStep = (c: DeterministicComponent): c is RecordStep =>
  c.operation === "validate_records" || c.operation === "dedupe" || c.operation === "rank" || c.operation === "filter";

function operationRules(c: DeterministicComponent, pipeline: readonly string[]): string[] {
  if (isRecordStep(c)) return singleRecordStep(c);
  switch (c.operation) {
    case "compute_stats":
      return statsRules(c);
    case "to_csv":
      return csvRules(c);
    case "compile_report":
      return reportRules(c, pipeline);
  }
}

/** CSV and the report are text the next step uses as-is; everything else is JSON the runtime parses. */
function outputFormatOf(c: DeterministicComponent): AgentComponent["outputFormat"] {
  return c.operation === "compile_report" || c.operation === "to_csv" ? "markdown" : "json";
}

function schemaHintOf(c: DeterministicComponent): string | undefined {
  switch (c.operation) {
    case "compute_stats":
      return "object {total, groups: [{key, count, share}], numeric: {<field>: {count, sum, mean, min, max, median}}}";
    case "rank":
      return 'the input array of flat records, sorted, each with an added 1-based "rank" field';
    case "validate_records":
    case "dedupe":
    case "filter":
      return "the input array of flat records, unchanged apart from the records this step removes";
    default:
      return undefined;
  }
}

/**
 * A deterministic step reads the whole run context, an agent only its inputKeys: a report section that reads a
 * key the step did not list would be invisible to the model, so those keys are added (never removed).
 */
function inputKeysOf(c: DeterministicComponent): string[] {
  if (c.operation !== "compile_report") return [...c.inputKeys];
  return [...new Set([...c.inputKeys, ...c.config.sections.map((s) => s.sourceKey)])];
}

// ── Grouping ─────────────────────────────────────────────────────────────────

type Unit = { kind: "keep"; component: AgentComponent } | { kind: "convert"; steps: DeterministicComponent[] };

/** In place: the step rewrites the key it reads (blueprint convention for record transforms). */
const inPlaceRecordStep = (c: BlueprintComponent): c is RecordStep => c.type === "deterministic" && isRecordStep(c) && c.inputKeys[0] === c.outputKey;

function unitsOf(blueprint: WorkerBlueprint, shape: BaselineShape): Unit[] {
  const units: Unit[] = [];
  const { components } = blueprint;
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (c.type === "agent") {
      units.push({ kind: "keep", component: c });
      continue;
    }
    const run: DeterministicComponent[] = [c];
    if (shape === "merged" && inPlaceRecordStep(c)) {
      while (i + 1 < components.length) {
        const next = components[i + 1];
        if (!inPlaceRecordStep(next) || next.outputKey !== c.outputKey) break;
        run.push(next);
        i += 1;
      }
    }
    units.push({ kind: "convert", steps: run });
  }
  return units;
}

function mergedId(steps: readonly DeterministicComponent[], taken: ReadonlySet<string>): string {
  const joined = steps.map((s) => s.id).join("_");
  if (joined.length <= MAX_COMPONENT_ID && !taken.has(joined)) return joined;
  for (let n = 1; ; n++) {
    const id = `merged_steps_${n}`;
    if (!taken.has(id)) return id;
  }
}

function unitId(unit: Unit, taken: ReadonlySet<string>): string {
  if (unit.kind === "keep") return unit.component.id;
  return unit.steps.length === 1 ? unit.steps[0].id : mergedId(unit.steps, taken);
}

function unitName(unit: Unit): string {
  if (unit.kind === "keep") return unit.component.name;
  return unit.steps.map((s) => s.name).join(" + ");
}

function stepAsAgent(unit: Extract<Unit, { kind: "convert" }>, id: string, tier: ModelTier, pipeline: readonly string[]): AgentComponent {
  const [first] = unit.steps;
  const last = unit.steps[unit.steps.length - 1];
  const merged = unit.steps.length > 1;
  const rules = merged ? mergedRecordSteps(unit.steps as RecordStep[]) : operationRules(first, pipeline);
  const description = merged ? `${unit.steps.length} mechanical steps in one model call: ${unit.steps.map((s) => s.name).join(", then ")}.` : first.description;
  // A chain that ranks ends in ranked records whatever follows the rank (filters keep the order).
  const hint = schemaHintOf(unit.steps.find((s) => s.operation === "rank") ?? last);
  return {
    type: "agent",
    id,
    name: unitName(unit),
    description,
    goal: description,
    instructions: [...STEP_RULES, "", ...rules].join("\n"),
    modelTier: tier,
    tools: [],
    maxTurns: BASELINE_MAX_TURNS,
    inputKeys: inputKeysOf(first),
    outputKey: last.outputKey,
    outputFormat: outputFormatOf(last),
    ...(hint ? { outputSchemaHint: hint } : {}),
  };
}

function plan(blueprint: WorkerBlueprint, shape: BaselineShape): Array<{ unit: Unit; id: string }> {
  const units = unitsOf(blueprint, shape);
  const taken = new Set(blueprint.components.map((c) => c.id));
  return units.map((unit) => {
    const id = unitId(unit, taken);
    taken.add(id);
    return { unit, id };
  });
}

/** For each converted agent of the `shape` baseline, the deterministic steps of `blueprint` it performs. */
export function convertedSteps(blueprint: WorkerBlueprint, opts: Pick<AllAgentBaselineOptions, "shape"> = {}): ConvertedStep[] {
  return plan(blueprint, opts.shape ?? "per_step").flatMap(({ unit, id }) => (unit.kind === "convert" ? [{ componentId: id, replaces: unit.steps }] : []));
}

export function convertDeterministicToAgents(blueprint: WorkerBlueprint, opts: AllAgentBaselineOptions = {}): WorkerBlueprint {
  const tier = opts.tier ?? ALL_AGENT_BASELINE_DEFAULT_TIER;
  const planned = plan(blueprint, opts.shape ?? "per_step");
  // The report's methodology line names the pipeline the baseline actually runs.
  const pipeline = planned.map(({ unit }) => unitName(unit));
  const components: BlueprintComponent[] = planned.map(({ unit, id }) => (unit.kind === "keep" ? unit.component : stepAsAgent(unit, id, tier, pipeline)));
  // Everything except the pipeline (and the estimate that follows from it) is the worker the customer hired.
  const withoutCost: Omit<WorkerBlueprint, "costEstimate"> = { ...blueprint, components };
  const parsed = WorkerBlueprintSchema.safeParse({ ...withoutCost, costEstimate: estimateCost(withoutCost) });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
    throw new AppError("VALIDATION", `The all-agent baseline is not a valid worker: ${issues.slice(0, 5).join("; ")}`, { issues });
  }
  return parsed.data;
}
