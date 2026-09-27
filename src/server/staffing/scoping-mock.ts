import {
  JOB_FAMILY_INFO,
  JobSpecSchema,
  type IntakeAnswers,
  type JobFamily,
  type JobSpec,
  type ScopingQuestions,
  type SpecInput,
} from "@/server/domain";
import { tools } from "@/server/tools";
import {
  CADENCE_ADJECTIVE,
  FAMILY_DEFAULT_CADENCE,
  clipText,
  detectBudget,
  detectCadence,
  detectCount,
  detectFormat,
  extractEmails,
  mentionsSending,
} from "./cues";
import { KEEP_IN_WORKSPACE, jobObject } from "./describe";
import { profileFor } from "./digest";
import { detectFamily } from "./family-cues";
import { fieldList } from "./labels";
import { impliedAnswers, scopingQuestionsFor } from "./questions";
import { specFields, specResponsibilities } from "./spec-fields";
import { draftTitleFrom } from "./title";

export { draftTitleFrom };

/**
 * The simulated scoper: deterministic follow-up questions and a JobSpec built from the description plus the
 * customer's answers. It reads the same cues a live model would be told to look for — counts, cadence words,
 * recipients, format words — so the spec visibly reflects what the customer said.
 */

export function mockScopingQuestions(description: string): ScopingQuestions {
  const jobFamily = detectFamily(description);
  return {
    draftTitle: draftTitleFrom(description, jobFamily),
    jobFamily,
    questions: scopingQuestionsFor(jobFamily, description),
  };
}

export interface MockSpecArgs {
  description: string;
  title: string;
  jobFamily: JobFamily;
  intake: IntakeAnswers | null;
}

/** Answers keyed by question id, trimmed, skipped ones removed. */
function answersOf(intake: IntakeAnswers | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(intake?.answers ?? {})) {
    const clean = value.trim();
    if (clean.length > 0) out[id] = clean;
  }
  return out;
}

/** Which free-text answers become constraints ("Focus: …") and which describe an input source. */
const CONSTRAINT_ANSWERS: Record<string, string> = {
  focus: "Focus",
  icp: "Ideal customer profile",
  competitors: "Coverage",
  dimensions: "Emphasis",
  priorities: "Emphasis",
  rules: "Rules",
  categories: "Categories and teams",
  priority: "Priority rules",
  audience: "Audience and tone",
  outcome: "What a great result looks like",
};
const INPUT_ANSWERS: Record<string, { name: string; source: SpecInput["source"] }> = {
  sources: { name: "Sources", source: "provided_data" },
  competitors: { name: "Competitor list", source: "user_instruction" },
  icp: { name: "Ideal customer profile", source: "user_instruction" },
  rules: { name: "Categorization rules", source: "user_instruction" },
  audience: { name: "Content brief", source: "user_instruction" },
};

/** Typical plans per vendor pricing page: "five competitors" at plan level is about fifteen rows. */
const PLANS_PER_VENDOR = 3;

export function mockJobSpec(args: MockSpecArgs): JobSpec {
  const family = args.jobFamily;
  const profile = profileFor(family, args.description);
  const asked = (args.intake?.questions ?? []).map((q) => q.id);
  // What the description already answered fills in for the questions that were skipped; real answers win.
  const answers = { ...impliedAnswers(family, args.description, asked), ...answersOf(args.intake) };
  const everything = [args.description, ...Object.values(answers)].join("\n");

  // A direct answer to "how often?" wins over cadence words elsewhere; otherwise read everything the customer wrote.
  const impliedCadence = detectCadence([args.description, ...Object.values(answers)].join("\n"), FAMILY_DEFAULT_CADENCE[family]);
  const cadence = answers.cadence ? detectCadence(answers.cadence, impliedCadence) : impliedCadence;
  const format = detectFormat([answers.format ?? "", answers.recipients ?? "", args.description].join("\n"), JOB_FAMILY_INFO[family].defaultDeliverableFormat);
  const fields = specFields({ description: args.description, family, format, profile });

  const volumeAnswer = detectCount(answers.volume ?? "");
  const described = detectCount(args.description);
  // "Our five competitors" at plan level means rows per plan, not per competitor; in a digest, updates per competitor.
  const perPlanRows = volumeAnswer === undefined && described !== undefined && fields.perPlan;
  const perCompany = volumeAnswer === undefined && described !== undefined && !perPlanRows && !fields.custom ? profile.recordsPerCompany : undefined;
  const rowsPerDescribed = perPlanRows ? PLANS_PER_VENDOR : (perCompany ?? 1);
  const targetCount = volumeAnswer ?? (described !== undefined ? described * rowsPerDescribed : profile.targetCount);

  const recipientsAnswer = answers.recipients ?? "";
  const emails = extractEmails(everything);
  const notify = !KEEP_IN_WORKSPACE.test(recipientsAnswer) && (emails.length > 0 || mentionsSending(recipientsAnswer) || mentionsSending(args.description));

  const constraints = [...profile.constraints];
  const inputs: SpecInput[] = [...profile.inputs];
  for (const [id, answer] of Object.entries(answers)) {
    const label = CONSTRAINT_ANSWERS[id];
    if (label) constraints.push(`${label}: ${clipText(answer, 200)}`);
    const input = INPUT_ANSWERS[id];
    if (input) {
      // The customer's own words beat the profile's generic description of the same input.
      const row: SpecInput = { name: input.name, description: clipText(answer, 200), source: input.source, required: true };
      const existing = inputs.findIndex((i) => i.name === input.name);
      if (existing >= 0) inputs[existing] = row;
      else inputs.push(row);
    }
  }

  const toolsLikelyNeeded = [...profile.tools, ...(notify ? ["send_notification"] : [])].filter((t) => tools.has(t));
  const requireApprovalFor = notify ? ["Sending the deliverable to anyone by email or Slack"] : [];
  const notes = notify
    ? emails.length > 0
      ? `Deliver to ${emails.join(", ")} after each run.`
      : `Deliver as requested: ${clipText(recipientsAnswer || "share it with the team", 120)}`
    : "Runs need no approvals; the deliverable waits for review in the workspace.";

  const objective = clipText(args.description, 600);
  const deliverableTitle = clipText(`${CADENCE_ADJECTIVE[cadence.kind]} ${profile.deliverableNoun}`, 120);
  const describedDeliverable = `${profile.deliverableDescription.charAt(0).toLowerCase()}${profile.deliverableDescription.slice(1)}`;
  const summary = `${JOB_FAMILY_INFO[family].workerTitle} who delivers ${cadence.kind === "manual" ? "an" : "a"} ${deliverableTitle.toLowerCase()}: ${describedDeliverable}`;

  const criteria = profile.successCriteria.map((c) => (c.metric === "Records per run" ? { ...c, target: `>= ${targetCount}` } : c));
  const assumptions = [...profile.assumptions];
  if (perPlanRows) assumptions.push(`About ${PLANS_PER_VENDOR} plans per vendor, so about ${targetCount} plan rows per run.`);
  if (perCompany) assumptions.push(`About ${perCompany} notable ${profile.recordNoun} per company, so about ${targetCount} ${profile.recordNoun} per run.`);
  const unknown = fields.fields.filter((f) => !f.required && fields.custom && !profile.fields.some((p) => p.name === f.name));
  if (unknown.length > 0) {
    const named = fieldList(unknown.map((f) => f.name));
    assumptions.push(`${named.charAt(0).toUpperCase()}${named.slice(1)} ${unknown.length === 1 ? "is filled when the source states it" : "are filled when the source states them"} and left empty otherwise.`);
  }

  return JobSpecSchema.parse({
    schemaVersion: 1,
    title: clipText(args.title, 120),
    jobFamily: family,
    summary,
    objective: objective.length >= 10 ? objective : `${objective} — ${profile.deliverableDescription}`,
    responsibilities: specResponsibilities({ family, profile, object: jobObject(args.description), fields }),
    inputs: inputs.slice(0, 8),
    deliverable: {
      title: deliverableTitle,
      description: profile.deliverableDescription,
      format,
      fields: fields.fields,
      sections: format === "markdown" ? profile.sections : [],
      targetCount,
    },
    cadence,
    successCriteria: criteria.slice(0, 8),
    constraints: constraints.slice(0, 10),
    outOfScope: profile.outOfScope.slice(0, 10),
    toolsLikelyNeeded: toolsLikelyNeeded.slice(0, 12),
    approvalPolicy: { requireApprovalFor, notes },
    budget: detectBudget(everything),
    assumptions: assumptions.slice(0, 10),
  });
}
