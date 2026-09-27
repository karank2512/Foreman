import type { DeliverableFormatSlug, JobFamily, SpecField } from "@/server/domain";
import type { JobObject } from "./describe";
import type { FamilyProfile } from "./families";
import { aliasesOf, parseFieldList } from "./field-list";

/**
 * The deliverable's fields and the responsibilities that describe them, for the simulated scoper. When the
 * customer lists their own columns, those ARE the fields (plus the record's identity and a source, which every
 * research row needs to be checkable); otherwise the family template applies, topped up with any column the
 * customer mentioned in passing ("…and a source for each"). PURE.
 */

const SOURCED = new Set<JobFamily>(["market_research", "market_analysis", "lead_research", "content", "general"]);
const NOT_A_SOURCE = new Set(["website", "linkedin_url", "pricing_url"]);

/** The column that says which company / item / ticket a row is about. */
function entityKey(family: JobFamily, description: string): SpecField | null {
  switch (family) {
    case "lead_research":
    case "market_research":
      return { name: "company", description: "Company name", required: true };
    case "market_analysis":
      return /\bcompetitors?\b|\brivals?\b/i.test(description)
        ? { name: "competitor", description: "Competitor name", required: true }
        : { name: "company", description: "Company or product", required: true };
    case "feedback_analysis":
      return { name: "id", description: "Feedback item id", required: true };
    case "support_triage":
      return { name: "id", description: "Ticket id", required: true };
    case "finance_ops":
      return { name: "transaction_id", description: "Transaction or invoice id", required: true };
    default:
      return null;
  }
}

/** The categorical column a markdown report's breakdown section is built on. */
const GROUPING: Partial<Record<JobFamily, string>> = {
  market_research: "category",
  market_analysis: "pricing_model",
  feedback_analysis: "category",
  support_triage: "team",
  finance_ops: "category",
};

export interface SpecFieldsResult {
  fields: SpecField[];
  /** True when the fields came from the customer's own column list. */
  custom: boolean;
  /** How the responsibilities name the customer's columns, in their order. */
  labels: string[];
  /** One row per company × plan (a plan-level column was asked for). */
  perPlan: boolean;
}

function sameColumn(a: string, b: string, family: JobFamily): boolean {
  return a === b || aliasesOf(a, family).includes(b) || aliasesOf(b, family).includes(a);
}

export function specFields(args: { description: string; family: JobFamily; format: DeliverableFormatSlug; profile: FamilyProfile }): SpecFieldsResult {
  const { description, family, format, profile } = args;
  const template = profile.fields.map((f) => ({ ...f }));
  const parsed = parseFieldList(description, family);
  if (!parsed) return { fields: template, custom: false, labels: [], perPlan: false };

  if (!parsed.strict) {
    // Mentioned in passing: keep the template, make those columns required, add any it lacks.
    for (const p of parsed.fields) {
      const existing = template.find((f) => sameColumn(f.name, p.field.name, family));
      if (existing) existing.required = existing.required || p.field.required;
      else template.push(p.field);
    }
    return { fields: template.slice(0, 20), custom: false, labels: [], perPlan: false };
  }

  const fields: SpecField[] = [];
  const push = (field: SpecField) => {
    if (!fields.some((f) => sameColumn(f.name, field.name, family))) fields.push(field);
  };
  const key = entityKey(family, description);
  if (key && !parsed.fields.some((p) => sameColumn(p.field.name, key.name, family))) push(key);
  for (const p of parsed.fields) push(p.field);
  if (SOURCED.has(family) && !fields.some((f) => /(?:^|_)(?:url|link|source)$/.test(f.name) && !NOT_A_SOURCE.has(f.name))) {
    push({ name: "source_url", description: "Where the facts were found, so every row can be checked", required: true });
  }
  const grouping = GROUPING[family];
  if (format === "markdown" && grouping && !fields.some((f) => sameColumn(f.name, grouping, family))) {
    const fromTemplate = profile.fields.find((f) => f.name === grouping);
    push({ name: grouping, description: fromTemplate?.description ?? "Category", required: false });
  }
  return {
    fields: fields.slice(0, 20),
    custom: true,
    labels: parsed.fields.map((p) => p.label),
    perPlan: fields.some((f) => f.name === "plan_name"),
  };
}

// ── Responsibilities ────────────────────────────────────────────────────────

const METHOD_SUFFIX: Record<JobFamily, string> = {
  market_research: " from public sources — news, announcements and company sites",
  market_analysis: " from each vendor's own pages",
  lead_research: "",
  feedback_analysis: " from the connected sources",
  support_triage: " as they arrive in the helpdesk",
  finance_ops: " from the records provided",
  content: ", researched from recent, credible sources",
  general: "",
};

const COMPANY_FAMILIES = new Set<JobFamily>(["market_research", "market_analysis", "lead_research"]);
const VAGUE_OBJECT = /^(?:things|stuff|items|everything|anything|it|them|this|that|what matters)$/i;

/** Verbs that describe making the deliverable rather than working on the object ("build a list of X"). */
const MAKING = /^(?:build|create|make|produce|prepare|put together|compile|write|draft)$/i;

function entityNoun(family: JobFamily, perPlan: boolean): string {
  switch (family) {
    case "market_analysis":
      return perPlan ? "plan" : "competitor";
    case "lead_research":
    case "market_research":
      return "company";
    case "feedback_analysis":
      return "feedback item";
    case "support_triage":
      return "ticket";
    case "finance_ops":
      return "transaction";
    default:
      return "item";
  }
}

const listOf = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function specResponsibilities(args: {
  family: JobFamily;
  profile: FamilyProfile;
  object: JobObject | null;
  fields: SpecFieldsResult;
}): string[] {
  const { family, profile, object, fields } = args;
  const names = new Set(fields.fields.map((f) => f.name));
  const lines: string[] = [];

  // Company research keeps its qualifiers ("…that are hiring engineers"); other jobs read best without them.
  const target = object ? (COMPANY_FAMILIES.has(family) ? object.full : object.core) : "";
  if (object && target.length <= 140 && !VAGUE_OBJECT.test(target)) {
    const verb = MAKING.test(object.verb) && family !== "content" ? (family === "support_triage" || family === "feedback_analysis" ? "Read" : "Find") : object.verb;
    const suffix = /\b(?:pages?|sites?|websites?)\b/i.test(target) ? "" : (profile.methodSuffix ?? METHOD_SUFFIX[family]);
    lines.push(`${cap(verb)} ${target}${suffix}`);
  } else {
    lines.push(profile.responsibilities[0]);
  }

  if (fields.custom && fields.labels.length > 0) {
    const sourced = names.has("source_url") && !fields.labels.includes("a source link");
    lines.push(`Capture ${listOf(fields.labels)} for each ${entityNoun(family, fields.perPlan)}${sourced ? ", with a source link" : ""}`);
  }

  const rest = profile.responsibilities.slice(1);
  if (!fields.custom) return [...lines, ...rest].slice(0, 8);
  switch (family) {
    case "market_research":
      // The template's second line restates the template's columns; the capture line above replaces it.
      return [...lines, ...rest.slice(1)].slice(0, 8);
    case "lead_research": {
      const contact = names.has("contact_name") || names.has("contact_title");
      lines.push(contact ? "Confirm fit on the company's own pages and identify the right contact" : "Confirm each fit on the company's own pages before it goes on the list");
      lines.push(names.has("fit_score") ? "Score and de-duplicate leads before delivery" : "De-duplicate the list so no company appears twice");
      return lines.slice(0, 8);
    }
    case "market_analysis":
      return [...lines, ...rest.slice(1)].slice(0, 8);
    default:
      return [...lines, ...rest].slice(0, 8);
  }
}
