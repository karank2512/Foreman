import { config } from "@/server/config";
import {
  JOB_FAMILY_INFO,
  describeCadence,
  safeParseBlueprint,
  type AgentComponent,
  type BlueprintComponent,
  type Cadence,
  type DeliverableFormatSlug,
  type JobSpec,
  type WorkerBlueprint,
} from "@/server/domain";
import { clampRunLimits } from "@/server/security";
import { reportTableColumns } from "@/server/staffing";
import { clip, lowerFirst, recostAndValidate } from "./shared";

/**
 * Turn a normalized spec-change instruction into a revised blueprint, deterministically. Structural edits are
 * recognised for the things a manager most often asks for (schedule, record count, deliverable format, cost
 * limit); anything else becomes a standing instruction on the agents. PURE.
 */

export interface SpecChangeResult {
  blueprint: WorkerBlueprint;
  /** Human-readable summary of each edit, for the reply and the activity feed. */
  changes: string[];
}

const RANK_LIMIT_FACTOR = 1.5;
const MIN_RECORDS_FACTOR = 0.8;
const MAX_KPIS = 8;
const STANDING_PREFIX = "Standing instruction from your manager:";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseHour(text: string): number | undefined {
  const m = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return hour >= 0 && hour <= 23 ? hour : undefined;
}

function parseDayOfWeek(text: string): number | undefined {
  const m = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/i.exec(text);
  return m ? DAYS.indexOf(m[1].toLowerCase()) : undefined;
}

export function parseCadence(text: string, current: Cadence): Cadence | null {
  const t = text.toLowerCase();
  const hour = parseHour(t);
  const dow = parseDayOfWeek(t);
  if (/\b(manual|on demand|only when i ask|stop (running )?automatically|no schedule)\b/.test(t)) return { kind: "manual" };
  if (/\b(hourly|every hour|each hour|once an hour)\b/.test(t)) return { kind: "hourly" };
  if (/\b(daily|every day|each day|every morning|each morning|every evening|once a day|per day)\b/.test(t)) {
    return { kind: "daily", hour: hour ?? current.hour ?? 9 };
  }
  if (/\b(weekly|every week|each week|once a week|per week)\b/.test(t) || dow !== undefined) {
    return { kind: "weekly", hour: hour ?? current.hour ?? 9, dayOfWeek: dow ?? current.dayOfWeek ?? 1 };
  }
  return null;
}

const COUNT_NOUNS = "records?|leads?|items?|companies|company|rows?|results?|entries|entry|startups?|accounts?|contacts?|tickets?|posts?|articles?|rounds?|deals?|prospects?|candidates?|vendors?|invoices?|feedback items?";

export function parseRecordTarget(text: string): number | null {
  const t = text.toLowerCase();
  const patterns = [
    new RegExp(`\\b(\\d{1,4})\\s+(?:new\\s+|more\\s+|relevant\\s+|qualified\\s+)?(?:${COUNT_NOUNS})\\b`),
    /\b(?:top|at least|up to|max(?:imum)?|around|about|roughly)\s+(\d{1,4})\b/,
    /\b(?:target|count|limit)\s+(?:of\s+|to\s+)?(\d{1,4})\b/,
  ];
  for (const p of patterns) {
    const m = p.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 5_000) return n;
    }
  }
  return null;
}

export function parseFormat(text: string): DeliverableFormatSlug | null {
  const t = text.toLowerCase();
  if (/\b(as|in|to|into)\s+(a\s+|an\s+)?(csv|json|markdown)\b|\b(csv|json|markdown)\s+(format|file|output|deliverable)\b|\bspreadsheet\b|\bexcel\b/.test(t)) {
    if (/\bjson\b/.test(t)) return "json";
    if (/\bcsv\b|\bspreadsheet\b|\bexcel\b/.test(t)) return "csv";
    return "markdown";
  }
  return null;
}

/**
 * "cap it at $2 a run" → 2. Clamped to the platform ceiling (audit INF-04): a manager asking for "$100,000 per
 * run" gets the maximum we actually allow, and the proposal they review shows that effective number.
 */
export function parseCostLimit(text: string): number | null {
  const t = text.toLowerCase();
  if (!/\b(cost|budget|spend|spending|cheaper|limit|cap)\b/.test(t)) return null;
  const m = /\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars|usd|bucks)\b/.exec(t);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, config.limits.maxCostPerRunUsd);
}

// ── Edits ───────────────────────────────────────────────────────────────────

const isAgent = (c: BlueprintComponent): c is AgentComponent => c.type === "agent";
const firstCollector = (bp: WorkerBlueprint) => bp.components.find((c): c is AgentComponent => isAgent(c) && c.outputFormat === "json");

function applyRecordTarget(bp: WorkerBlueprint, n: number): WorkerBlueprint {
  const rankLimit = Math.round(n * RANK_LIMIT_FACTOR);
  const min = Math.max(1, Math.round(n * MIN_RECORDS_FACTOR));
  const collector = firstCollector(bp);
  const components = bp.components.map((c): BlueprintComponent => {
    if (c.type === "deterministic" && c.operation === "rank") return { ...c, config: { ...c.config, limit: rankLimit } };
    if (c.type === "agent" && collector && c.id === collector.id) {
      const aim = `Aim for about ${n} records per run`;
      const instructions = /aim for about \d+ records/i.test(c.instructions)
        ? c.instructions.replace(/aim for about \d+ records/i, aim)
        : `${c.instructions.trimEnd()}\n${aim}; quality and completeness beat volume.`;
      const hint = (c.outputSchemaHint ?? "array of flat records").replace(/\s*\(about \d+ records per run\)$/i, "");
      return { ...c, instructions, outputSchemaHint: `${hint} (about ${n} records per run)` };
    }
    return c;
  });
  const deterministicChecks = bp.evaluation.deterministicChecks.map((check) =>
    check.type === "min_records"
      ? { ...check, description: `At least ${min} records per run (80% of the ${n} asked for)`, config: { min } }
      : check,
  );
  if (!deterministicChecks.some((c) => c.type === "min_records")) {
    deterministicChecks.push({ id: "min_records", type: "min_records", description: `At least ${min} records per run (80% of the ${n} asked for)`, config: { min }, weight: 2 });
  }
  const kpis = bp.kpis.map((k) => (k.metric === "records_per_run" ? { ...k, target: n, description: `Items delivered each run (the job asks for about ${n}).` } : k));
  if (!kpis.some((k) => k.metric === "records_per_run") && kpis.length < MAX_KPIS) {
    kpis.push({ id: "records_per_run", name: "Records per run", description: `Items delivered each run (the job asks for about ${n}).`, metric: "records_per_run", target: n, unit: "records", direction: "higher_is_better" });
  }
  return { ...bp, components, evaluation: { ...bp.evaluation, deterministicChecks }, kpis };
}

function analystFor(spec: JobSpec, recordsKey: string): AgentComponent {
  const family = JOB_FAMILY_INFO[spec.jobFamily].label.toLowerCase();
  return {
    type: "agent",
    id: "analyst",
    name: "Analyst",
    description: `Writes the narrative for the ${spec.deliverable.title}.`,
    goal: `Turn the collected records into the insights the ${spec.deliverable.title} needs.`,
    instructions: [
      `You are a ${family} analyst. Given the records, write a concise, specific summary of what matters: the biggest items, notable patterns and what your manager should act on. Reference real values from the records; never invent data.`,
      "",
      "Output rules for this job:",
      '- Your text is inserted under the heading "Summary". Do not repeat that heading; start directly with the prose.',
      "- The full records table is appended automatically after your text; cite specific rows, but do not reproduce the whole table.",
    ].join("\n"),
    modelTier: "standard",
    tools: [],
    maxTurns: 2,
    inputKeys: ["job_brief", recordsKey],
    outputKey: "insights",
    outputFormat: "markdown",
  };
}

/** Re-wire the tail of the pipeline for a new deliverable format; null when the current design has no records to re-wire. */
function rewireFormat(bp: WorkerBlueprint, spec: JobSpec, format: DeliverableFormatSlug): WorkerBlueprint | null {
  if (bp.deliverable.format === format) return null;
  const recordsKey = bp.deliverable.dataKey ?? firstCollector(bp)?.outputKey;
  if (!recordsKey) return null;
  const fields = spec.deliverable.fields.map((f) => f.name);
  const ranked = bp.components.some((c) => c.type === "deterministic" && c.operation === "rank");

  // Drop the old rendering tail: report/CSV assembly and the tool-less prose agent that fed it.
  const kept = bp.components.filter((c) => {
    if (c.type === "deterministic") return c.operation !== "compile_report" && c.operation !== "to_csv";
    return !(c.outputFormat === "markdown" && c.tools.length === 0);
  });
  const notifierIndex = kept.findIndex((c) => c.type === "agent" && c.tools.includes("send_notification"));
  const insertAt = notifierIndex === -1 ? kept.length : notifierIndex;

  let contentKey: string;
  const added: BlueprintComponent[] = [];
  if (format === "csv") {
    added.push({
      type: "deterministic",
      id: "to_csv",
      name: "Export CSV",
      description: "Serialize the records as a spreadsheet-ready CSV.",
      operation: "to_csv",
      config: fields.length > 0 ? { columns: [...(ranked ? ["rank"] : []), ...fields] } : {},
      inputKeys: [recordsKey],
      outputKey: "csv",
    });
    contentKey = "csv";
  } else if (format === "json") {
    contentKey = recordsKey;
  } else {
    const previousAnalyst = bp.components.find((c): c is AgentComponent => isAgent(c) && c.id === "analyst");
    const columns = reportTableColumns(spec.deliverable.fields, ranked);
    added.push(previousAnalyst ?? analystFor(spec, recordsKey), {
      type: "deterministic",
      id: "compile_report",
      name: "Compile report",
      description: `Assemble the ${spec.deliverable.title} from the insights and the records table.`,
      operation: "compile_report",
      config: {
        title: spec.deliverable.title,
        sections: [
          { heading: "Summary", sourceKey: "insights", as: "markdown" },
          { heading: "Records", sourceKey: recordsKey, as: "table", ...(columns ? { columns } : {}), maxRows: 25 },
        ],
        includeMethodology: true,
      },
      inputKeys: ["insights", recordsKey],
      outputKey: "report",
    });
    contentKey = "report";
  }
  const components = [...kept.slice(0, insertAt), ...added, ...kept.slice(insertAt)].map((c) =>
    c.type === "agent" && c.tools.includes("send_notification") ? { ...c, inputKeys: [contentKey] } : c,
  );
  const deterministicChecks =
    format === "markdown"
      ? bp.evaluation.deterministicChecks
      : bp.evaluation.deterministicChecks.filter((c) => c.type !== "contains_sections" && c.type !== "min_length");
  const candidate: WorkerBlueprint = {
    ...bp,
    components,
    deliverable: { ...bp.deliverable, format, contentKey, dataKey: recordsKey },
    evaluation: { ...bp.evaluation, deterministicChecks },
  };
  return safeParseBlueprint(candidate).success ? candidate : null;
}

function applyCostLimit(bp: WorkerBlueprint, max: number): WorkerBlueprint {
  // parseCostLimit already clamped, but the blueprint's other limits may predate the current ceilings.
  const deterministicChecks = bp.evaluation.deterministicChecks.map((c) =>
    c.type === "max_cost_usd" ? { ...c, description: `Run cost stays under $${max}`, config: { max } } : c,
  );
  const kpis = bp.kpis.map((k) => (k.metric === "cost_per_run_usd" ? { ...k, target: max } : k));
  return { ...bp, limits: clampRunLimits({ ...bp.limits, maxCostPerRunUsd: max }), evaluation: { ...bp.evaluation, deterministicChecks }, kpis };
}

/** Words that only describe the structural edit itself; whatever survives the strip is extra intent. */
const STRUCTURAL_WORDS =
  /\b(run|runs|running|report|reports|deliver|send|schedule|scheduled|hourly|daily|weekly|every|each|once|per|day|days|week|weeks|hour|hours|morning|evening|at|on|it|them|me|the|a|an|to|and|instead|of|in|as|into|format|file|output|deliverable|csv|json|markdown|spreadsheet|excel|records?|leads?|items?|companies|rows?|results?|entries|startups?|accounts?|contacts?|tickets?|posts?|articles?|rounds?|deals?|prospects?|top|least|up|max|maximum|about|around|roughly|target|count|limit|cost|budget|spend|cap|dollars|usd|manual|demand|only|when|i|ask|automatically|from|now|going|forward|always|please|switch|change|make|set|sunday|monday|tuesday|wednesday|thursday|friday|saturday|am|pm|\d+(?::\d+)?)\b/gi;

function hasResidualIntent(instruction: string): boolean {
  const residual = instruction
    .replace(/\$\s?\d+(?:\.\d+)?/g, " ")
    .replace(STRUCTURAL_WORDS, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  return residual.length >= 3;
}

/**
 * What an agent step does, in the manager's words. Component names ("Researcher", "Queue analyst") are the
 * design's internal roles; the chat reply says which part of the work changes instead.
 */
function stepNoun(bp: WorkerBlueprint, c: AgentComponent): string {
  if (c.tools.includes("send_notification")) return "delivery";
  if (c.outputFormat === "json") return c.tools.some((t) => t === "web_search" || t === "fetch_url") ? "research" : "review";
  return bp.jobFamily === "content" ? "writing" : "analysis";
}

/** ["research", "analysis"] → "the research and analysis steps". */
function stepsPhrase(nouns: readonly string[]): string {
  const unique = [...new Set(nouns)];
  const listed = unique.length <= 1 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  return `the ${listed} step${unique.length === 1 ? "" : "s"}`;
}

function appendStandingInstruction(bp: WorkerBlueprint, instruction: string): { blueprint: WorkerBlueprint; steps: string } {
  const line = `${STANDING_PREFIX} ${instruction.trim().replace(/\.?$/, ".")}`;
  const nouns: string[] = [];
  const components = bp.components.map((c): BlueprintComponent => {
    if (c.type !== "agent") return c;
    nouns.push(stepNoun(bp, c));
    return { ...c, instructions: `${c.instructions.trimEnd()}\n\n${line}` };
  });
  return { blueprint: { ...bp, components }, steps: stepsPhrase(nouns) };
}

export function deriveSpecChange(args: { blueprint: WorkerBlueprint; spec: JobSpec; instruction: string }): SpecChangeResult {
  const { spec, instruction } = args;
  const changes: string[] = [];
  let bp = args.blueprint;
  let structural = false;

  const cadence = parseCadence(instruction, bp.schedule);
  if (cadence) {
    structural = true;
    if (JSON.stringify(cadence) !== JSON.stringify(bp.schedule)) {
      changes.push(`schedule ${lowerFirst(describeCadence(bp.schedule))} → ${lowerFirst(describeCadence(cadence))}`);
      bp = { ...bp, schedule: cadence };
    }
  }

  const target = parseRecordTarget(instruction);
  if (target !== null) {
    bp = applyRecordTarget(bp, target);
    const rankLimit = Math.round(target * RANK_LIMIT_FACTOR);
    changes.push(`aim for about ${target} records per run (ranking keeps the top ${rankLimit}; the quality check expects at least ${Math.max(1, Math.round(target * MIN_RECORDS_FACTOR))})`);
  }

  const format = parseFormat(instruction);
  if (format) {
    if (format === bp.deliverable.format) {
      structural = true; // already the case — nothing to change, nothing to instruct
    } else {
      // A design we cannot re-wire leaves `structural` false, so the wish survives as a standing instruction.
      const rewired = rewireFormat(bp, spec, format);
      if (rewired) {
        changes.push(`deliverable format ${bp.deliverable.format} → ${format}`);
        bp = rewired;
        structural = true;
      }
    }
  }

  const costLimit = parseCostLimit(instruction);
  if (costLimit !== null && costLimit !== bp.limits.maxCostPerRunUsd) {
    changes.push(`cost limit $${bp.limits.maxCostPerRunUsd} → $${costLimit} per run`);
    bp = applyCostLimit(bp, costLimit);
  }

  // Schedule and format edits are fully expressed by the structure. Anything else — a request that says more than
  // the structural phrase ("run daily and focus on fintech"), or one that changed nothing — becomes a standing
  // order for the agents, so a proposal always differs from the version it replaces.
  if (!structural || hasResidualIntent(instruction) || changes.length === 0) {
    const appended = appendStandingInstruction(bp, instruction);
    bp = appended.blueprint;
    changes.push(`a standing instruction for ${appended.steps}: “${clip(instruction, 160)}”`);
  }

  return { blueprint: recostAndValidate(bp), changes };
}
