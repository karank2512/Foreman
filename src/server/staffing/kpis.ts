import {
  DEFAULT_EVALUATION_WEIGHTS,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_RUN_LIMITS,
  type BlueprintDraft,
  type DeterministicCheck,
  type EvaluationPlan,
  type JobSpec,
  type Kpi,
  type RubricCriterion,
} from "@/server/domain";
import { config } from "@/server/config";
import { fieldList, fieldPhrase } from "./labels";
import { toSnakeCase } from "./cues";

/**
 * KPIs and the evaluation plan are derived from the approved JobSpec alone, so two workers hired for the same
 * job are always measured the same way (which is what makes "Replace" comparable). PURE.
 */

/** One per-run cost ceiling for the KPI, the deterministic check and the hard limit, so they never disagree. */
const DEFAULT_MAX_COST_PER_RUN_USD = DEFAULT_RUN_LIMITS.maxCostPerRunUsd;

/**
 * Capped at the platform maximum (audit INF-04): a description that says "$10,000 per run" must not produce a
 * KPI, a check and a limit that promise something the runtime will never allow.
 */
export function maxCostPerRun(spec: JobSpec): number {
  return Math.min(spec.budget.maxCostPerRunUsd ?? DEFAULT_MAX_COST_PER_RUN_USD, config.limits.maxCostPerRunUsd);
}

export function requiredFieldNames(spec: JobSpec): string[] {
  return spec.deliverable.fields.filter((f) => f.required).map((f) => f.name);
}

/** Key fields limited to real spec fields; the first required field when the draft names none that exist. */
export function usableKeyFields(spec: JobSpec, keyFields: readonly string[]): string[] {
  const names = new Set(spec.deliverable.fields.map((f) => f.name));
  const kept = [...new Set(keyFields.map((k) => k.trim()).filter((k) => names.has(k)))];
  if (kept.length > 0) return kept;
  const required = requiredFieldNames(spec);
  return required.length > 0 ? [required[0]] : [];
}

export function deriveKpis(spec: JobSpec): Kpi[] {
  const kpis: Kpi[] = [
    {
      id: "acceptance_rate",
      name: "Acceptance rate",
      description: "Share of reviewed deliverables you accept without sending them back.",
      metric: "acceptance_rate",
      target: 0.85,
      unit: "%",
      direction: "higher_is_better",
    },
    {
      id: "quality_score",
      name: "Quality score",
      description: "Average score from the quality review against the job's rubric.",
      metric: "quality_score",
      target: 0.8,
      unit: "%",
      direction: "higher_is_better",
    },
  ];
  if (spec.deliverable.targetCount) {
    kpis.push({
      id: "records_per_run",
      name: "Records per run",
      description: `Items delivered each run (the job asks for about ${spec.deliverable.targetCount}).`,
      metric: "records_per_run",
      target: spec.deliverable.targetCount,
      unit: "records",
      direction: "higher_is_better",
    });
  }
  kpis.push(
    {
      id: "cost_per_run",
      name: "Cost per run",
      description: "Model and tool spend per run.",
      metric: "cost_per_run_usd",
      target: maxCostPerRun(spec),
      unit: "$",
      direction: "lower_is_better",
    },
    {
      id: "success_rate",
      name: "Run success rate",
      description: "Runs that finish with a deliverable, out of all finished runs.",
      metric: "success_rate",
      target: 0.9,
      unit: "%",
      direction: "higher_is_better",
    },
  );
  return kpis;
}

function uniqueId(base: string, taken: Set<string>): string {
  const root = toSnakeCase(base) || "criterion";
  let id = root;
  for (let n = 2; taken.has(id); n++) id = `${root}_${n}`;
  taken.add(id);
  return id;
}

/** Success-criterion metrics measured from the run record (acceptance, cost…) rather than read off the deliverable. */
const PROCESS_METRIC = /\b(?:acceptance|quality score|success rate|cost|duration|latency|runtime)\b/i;
/** Criteria about volume fold into the coverage dimension. */
const VOLUME_METRIC = /\brecords? per run\b|\bvolume\b|\bcount\b/i;

const AUDIENCE_BY_FAMILY: Record<JobSpec["jobFamily"], string> = {
  lead_research: "the sales team",
  market_research: "the people deciding on it",
  market_analysis: "the people deciding on it",
  feedback_analysis: "the product team",
  support_triage: "the support leads",
  finance_ops: "the finance lead",
  content: "the target audience",
  general: "the team",
};

/** An outcome sentence as a short criterion name: word-boundary cut, no ellipsis. */
function criterionLabel(description: string): string {
  const clean = description.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
  if (clean.length <= 60) return clean;
  let cut = clean.slice(0, 60);
  cut = cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 60);
  return cut.replace(/\s+(?:and|or|of|for|the|a|an|in|on|to|with|from|by)$/i, "").trim();
}

function audienceOf(spec: JobSpec): string {
  const stated = spec.constraints.find((c) => /^audience(?: and tone)?:/i.test(c));
  if (stated) return stated.replace(/^audience(?: and tone)?:\s*/i, "").split(/[,;]/)[0].trim().toLowerCase();
  return AUDIENCE_BY_FAMILY[spec.jobFamily];
}

/**
 * The reviewer's rubric: qualities a reader can judge from the deliverable itself — coverage of the brief,
 * accuracy and sourcing, specificity, usefulness — plus the spec's own success criteria phrased as outcomes.
 * KPI names ("Acceptance rate", "Records per run") never become criteria: those are measured, not judged.
 */
function rubricFromSpec(spec: JobSpec): RubricCriterion[] {
  const taken = new Set<string>();
  const target = spec.deliverable.targetCount;
  const volume = spec.successCriteria.filter((c) => VOLUME_METRIC.test(c.metric ?? ""));
  const qualities = spec.successCriteria.filter((c) => !volume.includes(c));
  const sentence = (text: string) => text.trim().replace(/\.?$/, ".");

  const rubric: RubricCriterion[] = [
    {
      id: uniqueId(volume[0]?.id ?? "coverage", taken),
      criterion: "Coverage of the brief",
      description: [
        `Covers what the brief asks for${target ? ` (about ${target} records per run)` : ""}, with nothing important missing and nothing off-topic.`,
        ...volume.map((c) => sentence(c.description)),
      ].join(" "),
      weight: 1,
    },
  ];
  for (const c of qualities) {
    // A target the reviewer can check on the page ("100% of records") stays; a KPI threshold ("≥ 85%") does not.
    const observable = c.target && !PROCESS_METRIC.test(c.metric ?? "");
    rubric.push({ id: uniqueId(c.id, taken), criterion: criterionLabel(c.description), description: `${sentence(c.description)}${observable ? ` Target: ${c.target}.` : ""}`, weight: 1 });
  }
  const audience = audienceOf(spec);
  rubric.push(
    {
      id: uniqueId("accuracy_sourcing", taken),
      criterion: "Accuracy & sourcing",
      description: "Facts are correct, specific and traceable to a source; nothing is invented or padded.",
      weight: 2,
    },
    spec.deliverable.format === "markdown"
      ? {
          id: uniqueId("specificity", taken),
          criterion: "Specificity of insights",
          description: "Each point names the companies, items and figures behind it; no generic commentary or filler.",
          weight: 1,
        }
      : {
          id: uniqueId("specificity", taken),
          criterion: "Specificity of each record",
          description: "Every value is concrete — real names, figures and reasons — never a placeholder or boilerplate.",
          weight: 1,
        },
    {
      id: uniqueId("usefulness", taken),
      criterion: criterionLabel(`Usefulness for ${audience}`),
      description: `${cap(audience)} could act on this ${spec.deliverable.title} as delivered, without re-doing the work.`,
      weight: 1,
    },
  );
  return rubric;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function deriveEvaluationPlan(spec: JobSpec, draft: Pick<BlueprintDraft, "keyFields">): EvaluationPlan {
  const checks: DeterministicCheck[] = [];
  const required = requiredFieldNames(spec);
  const keyFields = usableKeyFields(spec, draft.keyFields);
  const hasFields = spec.deliverable.fields.length > 0;
  const target = spec.deliverable.targetCount;

  if (target) {
    const min = Math.max(1, Math.round(target * 0.8));
    checks.push({
      id: "min_records",
      type: "min_records",
      description: `At least ${min} records per run (80% of the ${target} asked for)`,
      config: { min },
      weight: 2,
    });
  }
  if (hasFields && required.length > 0) {
    checks.push({
      id: "required_fields",
      type: "required_fields",
      description: `Required fields are filled (${required.map(fieldPhrase).join(", ")})`,
      config: { fields: required, minCompleteness: 0.9 },
      weight: 2,
    });
  }
  if (hasFields && keyFields.length > 0) {
    checks.push({
      id: "no_duplicates",
      type: "no_duplicates",
      description: `No repeated ${fieldList(keyFields)}`,
      config: { keyFields },
      weight: 1,
    });
  }
  if (spec.deliverable.format === "markdown" && spec.deliverable.sections.length > 0) {
    checks.push({
      id: "contains_sections",
      type: "contains_sections",
      description: `Report has the expected sections (${spec.deliverable.sections.join(", ")})`,
      config: { sections: spec.deliverable.sections },
      weight: 1,
    });
  }
  const maxCost = maxCostPerRun(spec);
  checks.push({
    id: "max_cost_usd",
    type: "max_cost_usd",
    description: `Run cost stays under $${maxCost}`,
    config: { max: maxCost },
    weight: 1,
  });

  return {
    deterministicChecks: checks,
    rubric: rubricFromSpec(spec),
    weights: { ...DEFAULT_EVALUATION_WEIGHTS },
    passThreshold: DEFAULT_PASS_THRESHOLD,
  };
}
