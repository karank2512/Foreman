import type { DeliverableFormat, EvaluationType, ReviewRecommendation, RunTrigger, VersionChangeReason } from "@prisma/client";
import type { StatusTone } from "@/lib/status";

/** Contractor-style labels for enums the profile shows in several tabs. Pure; safe in client leaves. */

const TRIGGER_LABELS: Record<RunTrigger, string> = {
  MANUAL: "On request",
  SCHEDULED: "Scheduled",
  RETRY: "Retry",
  CHAT: "From a conversation",
  HIRE: "First run",
};

export function triggerLabel(trigger: RunTrigger): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

const FORMAT_LABELS: Record<DeliverableFormat, string> = {
  MARKDOWN: "Report",
  CSV: "CSV",
  JSON: "JSON",
};

/** Accepts the Prisma enum (`MARKDOWN`) and the blueprint slug (`markdown`) alike. */
export function formatLabel(format: DeliverableFormat | string): string {
  return (FORMAT_LABELS as Record<string, string>)[format.toUpperCase()] ?? format;
}

/**
 * A deliverable title template as the next run would fill it: `{{date}}` becomes the date in the runtime's own
 * format (so it matches the titles already in the deliverables list) and `{{job_title}}` the job's title. A raw
 * placeholder never reaches a manager; without a job title that placeholder is dropped.
 */
export function exampleTitle(template: string, opts: { now?: Date; jobTitle?: string } = {}): string {
  const now = opts.now ?? new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return template
    .replace(/\{\{\s*date\s*\}\}/gi, date)
    .replace(/\{\{\s*job_title\s*\}\}/gi, opts.jobTitle ?? "")
    .replace(/\s+[—–-]\s*$/, "")
    .replace(/^\s*[—–-]\s+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The health line in a manager's words. The engine floors the score in its reason ("Quality score 54 is below
 * the 65 threshold") while the header shows it rounded (55), so the sentence names the bar, not a second number.
 */
export function attentionSentence(workerName: string, healthReason: string): string {
  const reason = healthReason
    .trim()
    .replace(/\.$/, "")
    .replace(/quality score \d+(?:\.\d+)? is below the (\d+) threshold/i, "the performance score is under $1");
  return `${workerName} needs attention: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.`;
}

const EVALUATION_LABELS: Record<EvaluationType, { label: string; hint: string }> = {
  DETERMINISTIC: { label: "Automated checks", hint: "Rules from the blueprint: record counts, required fields, duplicates, sections, cost." },
  LLM_JUDGE: { label: "AI judge", hint: "A reviewer model scores the deliverable against the job's rubric." },
  USER_FEEDBACK: { label: "Your feedback", hint: "Accepted or rejected deliverables." },
};

export function evaluationLabel(type: EvaluationType): string {
  return EVALUATION_LABELS[type]?.label ?? type;
}

export function evaluationHint(type: EvaluationType): string {
  return EVALUATION_LABELS[type]?.hint ?? "";
}

export const RECOMMENDATION_META: Record<ReviewRecommendation, { label: string; tone: StatusTone; headline: (name: string) => string }> = {
  KEEP: { label: "Keep", tone: "success", headline: (name) => `Keep ${name} on the job` },
  IMPROVE: { label: "Improve", tone: "attention", headline: (name) => `${name} could do better` },
  REPLACE: { label: "Replace", tone: "failure", headline: (name) => `Time to replace ${name}` },
};

/** A review's call as one sentence for the Overview — no score, no reasoning (those live on Performance). */
export function reviewVerdict(workerName: string, recommendation: ReviewRecommendation): string {
  if (recommendation === "REPLACE") return `${workerName}'s latest review says it's time for a replacement.`;
  if (recommendation === "IMPROVE") return `${workerName}'s latest review says there's room to improve.`;
  return `${workerName}'s latest review says to keep them on the job.`;
}

/**
 * What separates an earlier version's review from the version running today, keyed by the CURRENT version's
 * change reason: "Review of v1 (before the replacement)".
 */
const BEFORE_CHANGE: Record<VersionChangeReason, string> = {
  REPLACEMENT: "before the replacement",
  SPEC_CHANGE: "before the latest change",
  MANUAL: "before the latest change",
  INITIAL_HIRE: "an earlier version",
};

export function beforeChangeLabel(currentChangeReason: VersionChangeReason | null | undefined): string {
  return currentChangeReason ? BEFORE_CHANGE[currentChangeReason] : "an earlier version";
}

const OPERATION_LABELS: Record<string, string> = {
  validate_records: "Checks required fields",
  dedupe: "Removes duplicates",
  rank: "Ranks the results",
  filter: "Filters the results",
  compute_stats: "Computes statistics",
  to_csv: "Exports to CSV",
  compile_report: "Assembles the report",
};

export function operationLabel(operation: string | null): string {
  if (!operation) return "Deterministic step";
  return OPERATION_LABELS[operation] ?? operation.replace(/_/g, " ");
}

/**
 * The clock schedules run on, named so a manager can act on it ("Central Time", "UTC"). Schedule hours are
 * interpreted in the server's zone (see `computeNextRunAt`), so that is the zone to name — never "server time".
 */
export function timeZoneLabel(
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now: Date = new Date(),
): string {
  if (/^(Etc\/)?(UTC|GMT|UCT|Universal|Zulu)$/i.test(timeZone)) return "UTC";
  const name = (style: "longGeneric" | "long") => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: style })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value;
    } catch {
      return undefined;
    }
  };
  return name("longGeneric") ?? name("long") ?? timeZone;
}
