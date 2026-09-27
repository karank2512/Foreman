import {
  DEFAULT_RUN_LIMITS,
  WorkerBlueprintSchema,
  type AgentComponent,
  type BlueprintComponent,
  type BlueprintDraft,
  type JobSpec,
  type ReportSection,
  type ToolRequirement,
  type WorkerBlueprint,
} from "@/server/domain";
import { AppError } from "@/server/errors";
import { clampRunLimits } from "@/server/security";
import { tools } from "@/server/tools";
import { estimateCost } from "./cost";
import { extractEmails, looksNumeric, specText } from "./cues";
import { deriveEvaluationPlan, deriveKpis, maxCostPerRun, requiredFieldNames, usableKeyFields } from "./kpis";
import { fieldList, fieldPhrase } from "./labels";
import { feedbackTablePlan, type FeedbackTablePlan } from "./notable-feedback";
import { buildPersona } from "./persona";

/**
 * designBlueprint — turns the flat BlueprintDraft (LLM or template) into a complete, validated WorkerBlueprint.
 * PURE and deterministic: all wiring (context keys, deterministic steps, deliverable, notifier) is decided here,
 * never by the model, so every blueprint the executor receives follows the same pipeline conventions.
 */

const NOTIFY_TOOL = "send_notification";
const COLLECTOR_MAX_TURNS = 8;
const ANALYST_MAX_TURNS = 2;
const NOTIFIER_MAX_TURNS = 3;
const RANK_LIMIT_FACTOR = 1.5;
const MAX_TABLE_COLUMNS = 8;

/** Headings that read like an aggregate ("Category breakdown", "Themes by volume") render the stats block. */
const STATS_HEADING = /\b(breakdown|by (category|theme|team|stage|segment|type|plan|channel|priority|vendor|pricing model|sentiment|severity)|distribution|mix|volume|counts?|stats|statistics|share of|themes by)\b/i;
/** Headings that read like a list ("Top rounds", "Notable feedback", "Sources") render the records table. */
const TABLE_HEADING = /\b(top|list|table|records|rounds|leads|companies|tickets|items|accounts|contacts|transactions|invoices|entries|details|sources|prospects|rows|results|comparison|notable|feedback|vendors|competitors|lines?)\b/i;

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const nonEmpty = (s: string | undefined, fallback: string) => (clean(s).length > 0 ? clean(s) : fallback);

/**
 * The draft's prompt plus the job-specific output rules. A blank draft prompt stays blank so the schema rejects it
 * (AgentComponentSchema.instructions min 1): output rules alone are not a system prompt, and a live model that
 * produced nothing must trigger the template fallback instead of shipping a mute agent.
 */
const withOutputRules = (draftInstructions: string, rules: string) => (draftInstructions.trim().length > 0 ? `${draftInstructions.trim()}${rules}` : "");

function collectorTools(draft: BlueprintDraft): string[] {
  // The notifier is the only component allowed to write to the outside world; a collector that lists
  // send_notification is read as "please notify" (see notifyRequested) rather than granted the tool.
  return [...new Set(draft.collector.tools.map(clean).filter((t) => t !== NOTIFY_TOOL && tools.has(t)))];
}

function notifyRequested(spec: JobSpec, draft: BlueprintDraft): boolean {
  return draft.steps.notify || spec.toolsLikelyNeeded.includes(NOTIFY_TOOL) || draft.collector.tools.includes(NOTIFY_TOOL);
}

function schemaHint(fields: readonly string[]): string {
  return fields.length > 0 ? `array of {${fields.join(", ")}}` : "array of flat records, one object per item found";
}

function collectorOutputRules(spec: JobSpec, extraRules: readonly string[] = []): string {
  const fields = spec.deliverable.fields;
  const lines = ["", "Output contract for this job:"];
  if (fields.length > 0) {
    lines.push(`- Your final answer is a JSON array of flat objects with exactly these keys: ${fields.map((f) => f.name).join(", ")}.`);
    const required = requiredFieldNames(spec);
    if (required.length > 0) lines.push(`- Required in every record: ${required.join(", ")}. Use null only when a value genuinely cannot be found.`);
  } else {
    lines.push("- Your final answer is a JSON array of flat objects, one per item, with consistent snake_case keys.");
  }
  if (spec.deliverable.targetCount) lines.push(`- Aim for about ${spec.deliverable.targetCount} records; quality and completeness beat volume.`);
  lines.push(...extraRules, "- No prose before or after the JSON.");
  return lines.join("\n");
}

function analystOutputRules(narrative: readonly string[], hasStats: boolean, tableLabel: string): string {
  const [first, ...rest] = narrative;
  const lines = ["", "Output rules for this job:"];
  lines.push(`- Your text is inserted under the heading "${first}". Do not repeat that heading; start directly with the prose.`);
  if (rest.length > 0) lines.push(`- Then add these sections in this order, each under a "### <heading>" heading: ${rest.join(" · ")}.`);
  lines.push(`- ${tableLabel}${hasStats ? " and the breakdown" : ""} are appended automatically after your text; cite specific rows, but do not reproduce the whole table.`);
  return lines.join("\n");
}

function notifierInstructions(spec: JobSpec): string {
  const emails = extractEmails(specText(spec));
  const recipients = emails.length > 0 ? emails.join(", ") : "the stakeholders named in the job brief (or the team address if none are named)";
  return [
    `Send the finished "${spec.deliverable.title}" exactly once with send_notification: channel "email", recipients ${recipients}, subject = the deliverable title, body = the content you were given (trimmed to a readable length, never altered in substance).`,
    "Every send is approved by a human before it goes out. If the send is rejected or fails, say so in one line and stop — never retry, never send twice.",
    "After a successful send, confirm in one line who received it.",
  ].join("\n\n");
}

function agent(args: Omit<AgentComponent, "type">): AgentComponent {
  return { type: "agent", ...args };
}

const isLinkField = (name: string) => /(?:^|_)(?:url|link|source)$/.test(name) || name === "website";

/**
 * The records-table columns of a markdown report, capped at MAX_TABLE_COLUMNS. When the spec has more fields
 * than fit, the cut falls on optional detail — never on a required field or on the source link that makes a row
 * checkable. Columns keep the spec's order, with the rank first.
 */
export function reportTableColumns(fields: ReadonlyArray<{ name: string; required: boolean }>, ranked: boolean): string[] | undefined {
  if (fields.length === 0) return undefined;
  const budget = MAX_TABLE_COLUMNS - (ranked ? 1 : 0);
  const chosen = new Set<string>();
  const take = (names: string[]) => {
    for (const name of names) if (chosen.size < budget) chosen.add(name);
  };
  take(fields.filter((f) => f.required).map((f) => f.name));
  take(fields.filter((f) => !f.required && isLinkField(f.name)).map((f) => f.name));
  take(fields.map((f) => f.name));
  return [...(ranked ? ["rank"] : []), ...fields.map((f) => f.name).filter((name) => chosen.has(name))];
}

interface ReportLayout {
  sections: ReportSection[];
  narrative: string[];
  /** The feedback shortlist table (feedback_analysis only): its extra steps, collector rule and analyst wording. */
  feedbackTable?: FeedbackTablePlan;
}

/** Assign the spec's report sections to what the pipeline produces: prose, the records table, the stats block. */
function reportSections(spec: JobSpec, args: { hasStats: boolean; ranked: boolean; rankedBy?: { by: string; direction: "asc" | "desc" } }): ReportLayout {
  const headings = [...new Set(spec.deliverable.sections.map(clean).filter((h) => h.length > 0))];
  const narrative: string[] = [];
  let tableHeading: string | undefined;
  let statsHeading: string | undefined;
  for (const h of headings) {
    if (!statsHeading && args.hasStats && STATS_HEADING.test(h)) statsHeading = h;
    else if (!tableHeading && TABLE_HEADING.test(h)) tableHeading = h;
    else narrative.push(h);
  }
  if (narrative.length === 0) narrative.push("Summary");

  const feedbackTable = feedbackTablePlan(spec, { tableHeading, ranked: args.ranked, rankedBy: args.rankedBy });
  const columns = feedbackTable ? feedbackTable.table.columns : reportTableColumns(spec.deliverable.fields, args.ranked);
  const defaultMaxRows = spec.deliverable.targetCount ? Math.max(10, Math.round(spec.deliverable.targetCount * RANK_LIMIT_FACTOR)) : 25;
  const table: ReportSection = {
    heading: tableHeading ?? feedbackTable?.heading ?? "Records",
    sourceKey: feedbackTable?.table.sourceKey ?? "records",
    as: "table",
    ...(columns ? { columns } : {}),
    maxRows: feedbackTable?.table.maxRows ?? defaultMaxRows,
  };
  const stats: ReportSection | undefined = args.hasStats ? { heading: statsHeading ?? "Breakdown", sourceKey: "stats", as: "stats" } : undefined;
  const prose: ReportSection = { heading: narrative[0], sourceKey: "insights", as: "markdown" };

  // Keep the customer's order for the headings they named; anything unnamed goes after the prose.
  const sections: ReportSection[] = [];
  for (const h of headings) {
    if (h === narrative[0]) sections.push(prose);
    else if (h === tableHeading) sections.push(table);
    else if (h === statsHeading && stats) sections.push(stats);
  }
  if (!sections.includes(prose)) sections.unshift(prose);
  if (!sections.includes(table)) sections.push(table);
  if (stats && !sections.includes(stats)) sections.push(stats);
  return { sections, narrative, ...(feedbackTable ? { feedbackTable } : {}) };
}

export function designBlueprint(spec: JobSpec, draft: BlueprintDraft, opts: { usedNames?: string[] } = {}): WorkerBlueprint {
  const fields = spec.deliverable.fields.map((f) => f.name);
  const fieldSet = new Set(fields);
  const required = requiredFieldNames(spec);
  const keyFields = usableKeyFields(spec, draft.keyFields);
  const rankBy = fieldSet.has(clean(draft.rankBy)) ? clean(draft.rankBy) : undefined;
  const groupBy = fieldSet.has(clean(draft.groupBy)) ? clean(draft.groupBy) : undefined;
  const target = spec.deliverable.targetCount;
  const format = spec.deliverable.format;
  const ranked = draft.steps.rank && rankBy !== undefined;
  const hasStats = draft.steps.computeStats && groupBy !== undefined;
  // Decided up front: the report's table can add a collector output rule as well as its own pipeline steps.
  const layout = format === "markdown" ? reportSections(spec, { hasStats, ranked, rankedBy: ranked && rankBy ? { by: rankBy, direction: draft.rankDirection } : undefined }) : undefined;
  const tablePlan = layout?.feedbackTable;
  const components: BlueprintComponent[] = [];

  components.push(
    agent({
      id: "collector",
      name: nonEmpty(draft.collector.name, "Collector"),
      description: nonEmpty(draft.collector.description, `Gathers the records behind the ${spec.deliverable.title}.`),
      goal: nonEmpty(draft.collector.goal, `Collect the records the ${spec.deliverable.title} is built from.`),
      instructions: withOutputRules(draft.collector.instructions, collectorOutputRules(spec, tablePlan?.collectorRule ? [tablePlan.collectorRule] : [])),
      modelTier: draft.collector.modelTier,
      tools: collectorTools(draft),
      maxTurns: COLLECTOR_MAX_TURNS,
      inputKeys: ["job_brief", "instructions"],
      outputKey: "records",
      outputFormat: "json",
      outputSchemaHint: schemaHint(fields),
    }),
  );

  if (draft.steps.validate && required.length > 0) {
    components.push({
      type: "deterministic",
      id: "validate_records",
      name: "Validate records",
      description: `Drops any record missing ${fieldList(required, "or")}.`,
      operation: "validate_records",
      config: { requiredFields: required, dropInvalid: true },
      inputKeys: ["records"],
      outputKey: "records",
    });
  }
  if (draft.steps.dedupe && keyFields.length > 0) {
    components.push({
      type: "deterministic",
      id: "dedupe",
      name: "Remove duplicates",
      description: `Keeps one record per ${fieldList(keyFields)}.`,
      operation: "dedupe",
      config: { keyFields },
      inputKeys: ["records"],
      outputKey: "records",
    });
  }
  if (ranked && rankBy) {
    components.push({
      type: "deterministic",
      id: "rank",
      name: `Rank by ${fieldPhrase(rankBy)}`,
      description: `${draft.rankDirection === "desc" ? "Highest" : "Lowest"} ${fieldPhrase(rankBy)} first${target ? `, keeping the top ${Math.round(target * RANK_LIMIT_FACTOR)}` : ""}.`,
      operation: "rank",
      config: { by: rankBy, direction: draft.rankDirection, ...(target ? { limit: Math.round(target * RANK_LIMIT_FACTOR) } : {}) },
      inputKeys: ["records"],
      outputKey: "records",
    });
  }
  if (hasStats && groupBy) {
    const numericFields = fields.filter((f) => f !== groupBy && looksNumeric(f));
    components.push({
      type: "deterministic",
      id: "compute_stats",
      name: `Break down by ${fieldPhrase(groupBy)}`,
      description: `Counts per ${fieldPhrase(groupBy)}${numericFields.length > 0 ? `, with totals and averages for ${fieldList(numericFields)}` : ""}.`,
      operation: "compute_stats",
      config: { groupBy, numericFields },
      inputKeys: ["records"],
      outputKey: "stats",
    });
  }

  let contentKey: string;
  if (layout) {
    const { sections, narrative } = layout;
    const table = sections.find((s) => s.as === "table");
    const tableKey = table?.sourceKey ?? "records";
    if (tablePlan) components.push(...tablePlan.components);
    components.push(
      agent({
        id: "analyst",
        name: nonEmpty(draft.analyst.name, "Analyst"),
        description: nonEmpty(draft.analyst.description, `Writes the narrative for the ${spec.deliverable.title}.`),
        goal: nonEmpty(draft.analyst.goal, `Turn the collected records into the insights the ${spec.deliverable.title} needs.`),
        instructions: withOutputRules(draft.analyst.instructions, analystOutputRules(narrative, hasStats, tablePlan?.analystLabel ?? "The full records table")),
        modelTier: draft.analyst.modelTier,
        tools: [],
        maxTurns: ANALYST_MAX_TURNS,
        inputKeys: ["job_brief", "records", ...(hasStats ? ["stats"] : [])],
        outputKey: "insights",
        outputFormat: "markdown",
      }),
      {
        type: "deterministic",
        id: "compile_report",
        name: "Compile report",
        description: `Assemble the ${spec.deliverable.title} from the insights, the ${tableKey === "records" ? "records table" : `${table?.heading ?? "records"} shortlist`}${hasStats ? " and the breakdown" : ""}.`,
        operation: "compile_report",
        config: { title: spec.deliverable.title, sections, includeMethodology: true },
        inputKeys: ["insights", "records", ...(hasStats ? ["stats"] : []), ...(tableKey === "records" ? [] : [tableKey])],
        outputKey: "report",
      },
    );
    contentKey = "report";
  } else if (format === "csv") {
    components.push({
      type: "deterministic",
      id: "to_csv",
      name: "Export CSV",
      description: "Serialize the records as a spreadsheet-ready CSV.",
      operation: "to_csv",
      config: fields.length > 0 ? { columns: [...(ranked ? ["rank"] : []), ...fields] } : {},
      inputKeys: ["records"],
      outputKey: "csv",
    });
    contentKey = "csv";
  } else {
    contentKey = "records";
  }

  if (notifyRequested(spec, draft)) {
    components.push(
      agent({
        id: "notifier",
        name: "Notifier",
        description: `Sends the finished ${spec.deliverable.title} to stakeholders, with your approval.`,
        goal: `Deliver the ${spec.deliverable.title} to its recipients once it is ready.`,
        instructions: notifierInstructions(spec),
        modelTier: "fast",
        tools: [NOTIFY_TOOL],
        maxTurns: NOTIFIER_MAX_TURNS,
        inputKeys: [contentKey],
        outputKey: "notification_status",
        outputFormat: "markdown",
      }),
    );
  }

  const reasons = new Map(draft.toolReasons.map((r) => [clean(r.toolName), clean(r.reason)] as const));
  const toolRequirements: ToolRequirement[] = [];
  for (const component of components) {
    if (component.type !== "agent") continue;
    for (const toolName of component.tools) {
      if (toolRequirements.some((t) => t.toolName === toolName)) continue;
      const definition = tools.get(toolName);
      if (!definition) continue;
      toolRequirements.push({
        toolName,
        reason: reasons.get(toolName) || definition.humanDescription,
        requiresApproval: toolName === NOTIFY_TOOL ? true : definition.defaultRequiresApproval,
      });
    }
  }

  const responsibilities = [...new Set(draft.responsibilities.map(clean).filter((r) => r.length > 0))].slice(0, 8);
  const persona = buildPersona({
    family: spec.jobFamily,
    seedText: `${spec.title}|${spec.jobFamily}`,
    proposed: draft.persona,
    usedNames: opts.usedNames,
    deliverableTitle: spec.deliverable.title,
  });

  const withoutCost: Omit<WorkerBlueprint, "costEstimate"> = {
    schemaVersion: 1,
    jobFamily: spec.jobFamily,
    persona,
    responsibilities: responsibilities.length > 0 ? responsibilities : spec.responsibilities.slice(0, 8),
    components,
    tools: toolRequirements,
    kpis: deriveKpis(spec),
    evaluation: deriveEvaluationPlan(spec, { keyFields }),
    deliverable: { titleTemplate: `${spec.deliverable.title} — {{date}}`, format, contentKey, dataKey: "records" },
    schedule: spec.cadence,
    // The same ceiling the cost KPI and the max_cost_usd check use (kpis.ts), so the three never disagree —
    // then clamped to the platform maximums, so a "$100,000 per run" budget in the description cannot escape
    // into a blueprint (audit INF-04). The runtime clamps again at check time.
    limits: clampRunLimits({ ...DEFAULT_RUN_LIMITS, maxCostPerRunUsd: maxCostPerRun(spec) }),
  };
  const candidate: WorkerBlueprint = { ...withoutCost, costEstimate: estimateCost(withoutCost) };

  const parsed = WorkerBlueprintSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
    throw new AppError("VALIDATION", `The designed worker is not valid: ${issues.slice(0, 5).join("; ")}`, { issues });
  }
  return parsed.data;
}
