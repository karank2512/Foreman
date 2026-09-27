import type { AgentDraft, BlueprintDraft, JobSpec, ModelTier } from "@/server/domain";
import { JOB_FAMILY_INFO } from "@/server/domain";
import { tools } from "@/server/tools";
import { mentionsSending, specText } from "../cues";
import { fieldList } from "../labels";
import { pickPersonaName } from "../persona";

/**
 * Building blocks for the job-family templates: everything a template needs to know about the spec, plus the
 * prose blocks every agent prompt shares (job facts, field guide, output rules). Templates stay readable and
 * the resulting instructions stay specific to the customer's spec rather than generic boilerplate.
 */

export interface TemplateContext {
  spec: JobSpec;
  usedNames: readonly string[];
  fields: string[];
  required: string[];
  has(field: string): boolean;
  /** First candidate that is a real spec field. */
  pick(...candidates: string[]): string;
  /** First numeric-looking spec field (for ranking). */
  numeric(): string;
  notify: boolean;
  name: string;
}

export function templateContext(spec: JobSpec, usedNames: readonly string[] = []): TemplateContext {
  const fields = spec.deliverable.fields.map((f) => f.name);
  const set = new Set(fields);
  const has = (field: string) => set.has(field);
  const text = specText(spec);
  return {
    spec,
    usedNames,
    fields,
    required: spec.deliverable.fields.filter((f) => f.required).map((f) => f.name),
    has,
    pick: (...candidates) => candidates.find(has) ?? "",
    numeric: () => fields.find((f) => /(amount|usd|price|cost|score|count|employees|headcount|revenue|total|hours|days|rating|value|spend|size)/i.test(f)) ?? "",
    notify: spec.toolsLikelyNeeded.includes("send_notification") || mentionsSending(text),
    name: pickPersonaName(`${spec.title}|${spec.jobFamily}`, usedNames),
  };
}

// ── Shared prose blocks ─────────────────────────────────────────────────────

export function jobFacts(spec: JobSpec): string {
  const lines = [`The job: ${spec.objective.trim()}`];
  if (spec.constraints.length > 0) lines.push(`Constraints you must respect: ${spec.constraints.join("; ")}.`);
  if (spec.outOfScope.length > 0) lines.push(`Out of scope (do not do this): ${spec.outOfScope.join("; ")}.`);
  return lines.join(" ");
}

export function fieldGuide(spec: JobSpec): string {
  if (spec.deliverable.fields.length === 0) return "";
  const lines = ["Each record must have these fields (snake_case, exactly these names):"];
  for (const f of spec.deliverable.fields) lines.push(`- ${f.name}${f.required ? " (required)" : ""}: ${f.description}`);
  return lines.join("\n");
}

export function volumeLine(spec: JobSpec, noun: string): string {
  const n = spec.deliverable.targetCount;
  return n ? `Aim for about ${n} ${noun} per run. Fewer complete ${noun} beat more incomplete ones.` : `Deliver every ${noun.replace(/s$/, "")} that genuinely fits; do not pad the list.`;
}

export const NO_INVENTION = "Never invent a fact, a number, a person or a URL. If a value cannot be found after a reasonable effort, leave it null and move on; a null is honest, a guess is a defect.";

export function agentDraft(args: {
  name: string;
  description: string;
  goal: string;
  modelTier: ModelTier;
  tools: string[];
  paragraphs: string[];
}): AgentDraft {
  return {
    name: args.name,
    description: args.description,
    goal: args.goal,
    instructions: args.paragraphs.filter((p) => p.trim().length > 0).join("\n\n"),
    modelTier: args.modelTier,
    tools: args.tools.filter((t) => tools.has(t)),
  };
}

export function reason(toolName: string, why: string): { toolName: string; reason: string } {
  return { toolName, reason: why };
}

export function persona(ctx: TemplateContext, summary: string): BlueprintDraft["persona"] {
  return { name: ctx.name, title: JOB_FAMILY_INFO[ctx.spec.jobFamily].workerTitle, summary };
}

export const NOTIFY_REASON = "Deliver the finished work to the stakeholders you name. Every send waits for your approval.";

/**
 * Rationale bullets every family shares, phrased the way a staffing manager explains a hire: fields by their
 * labels, fixed steps described by what they guarantee rather than how they are implemented.
 */
export function sharedRationale(ctx: TemplateContext, opts: { validate: boolean; dedupe: boolean; keyFields: string[]; rankBy: string }): string[] {
  const out: string[] = [];
  if (opts.validate && ctx.required.length > 0) {
    out.push(`Any record missing ${fieldList(ctx.required, "or")} is set aside before it reaches you. That check follows a fixed rule, so it costs nothing and nothing slips through.`);
  }
  if (opts.dedupe && opts.keyFields.length > 0) {
    out.push(`Duplicates are removed before anything reaches you, so you never see the same ${fieldList(opts.keyFields)} twice.`);
  }
  if (opts.rankBy) {
    out.push(`Results are ranked by ${fieldList([opts.rankBy])} the same way every run, so the order is consistent and the most important items come first.`);
  }
  if (ctx.notify) out.push(`${ctx.name} can send the finished work to the people you name, but every send needs your approval first.`);
  return out;
}
