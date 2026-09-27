import type { KpiActual, ReviewMetrics, ReviewNarrative, WorkerScore } from "@/server/domain/evaluation";
import { HEALTH_THRESHOLDS } from "@/server/domain/evaluation";

/**
 * Simulated-mode performance review. PURE: every sentence is derived from the computed metrics and the evidence
 * (rejected-deliverable feedback, failed-run errors) so the review reads like a manager who looked at the numbers,
 * and the recommendation follows the same thresholds the live prompt is given. Client feedback is quoted; runtime
 * error text never is — it is written for operators, so the review names the cause in plain language instead.
 */

export interface ReviewEvidence {
  workerName: string;
  jobTitle: string;
  metrics: ReviewMetrics;
  score: WorkerScore;
  /** Most recent first. */
  rejectedFeedback: Array<{ title: string; feedback: string }>;
  /** Error messages of failed runs in the window, most recent first. Mapped to causes, never quoted. */
  failedRunErrors: string[];
}

/** Scores at or above this are a clear KEEP; between HEALTH_THRESHOLDS.minScore and this → IMPROVE. */
export const IMPROVE_CEILING = 80;
const MAX_ITEMS = 6;
const MAX_QUOTE_CHARS = 140;

const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const quote = (text: string) => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return `“${oneLine.length <= MAX_QUOTE_CHARS ? oneLine : `${oneLine.slice(0, MAX_QUOTE_CHARS - 1)}…`}”`;
};

export function formatKpiValue(value: number, unit: string): string {
  if (unit === "%") return pct(value);
  if (unit === "$") return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
  if (unit === "sec" || unit === "s") return `${Math.round(value * 10) / 10}s`;
  const rounded = Math.round(value * 10) / 10;
  return unit ? `${rounded} ${unit}` : `${rounded}`;
}

export interface RecommendationVerdict {
  recommendation: ReviewNarrative["recommendation"];
  /** Threshold-based reasons, in order of severity. */
  reasons: string[];
}

/**
 * REPLACE when the score is below the health threshold or the window's failure rate is too high; IMPROVE when the
 * score is merely "fine"; KEEP otherwise (including "too early to tell").
 */
export function recommendFromMetrics(score: number | null, metrics: ReviewMetrics): RecommendationVerdict {
  const reasons: string[] = [];
  const enoughRuns = metrics.runs >= HEALTH_THRESHOLDS.minRunsForHealth;
  const failureRate = enoughRuns ? metrics.failed / metrics.runs : null;

  if (score !== null && score < HEALTH_THRESHOLDS.minScore) {
    reasons.push(`the quality score of ${Math.round(score)} is below the ${HEALTH_THRESHOLDS.minScore} threshold`);
  }
  if (failureRate !== null && failureRate > HEALTH_THRESHOLDS.maxRecentFailureRate) {
    reasons.push(
      `${metrics.failed} of the last ${metrics.runs} runs failed (${pct(failureRate)}, above the ${pct(HEALTH_THRESHOLDS.maxRecentFailureRate)} limit)`,
    );
  }
  if (reasons.length > 0) return { recommendation: "REPLACE", reasons };

  if (score !== null && score < IMPROVE_CEILING) {
    return {
      recommendation: "IMPROVE",
      reasons: [`the quality score of ${Math.round(score)} sits in the ${HEALTH_THRESHOLDS.minScore}–${IMPROVE_CEILING} band`],
    };
  }
  return {
    recommendation: "KEEP",
    reasons:
      score === null
        ? [`there is no quality score yet after ${plural(metrics.runs, "finished run")}`]
        : [`the quality score of ${Math.round(score)} is at or above ${IMPROVE_CEILING}`],
  };
}

/**
 * Why a run failed, in the client's terms. `one` / `many` follow "because" for a single run or several ("because it
 * hit its cost limit" / "because they hit their cost limit"). `key` groups messages that differ only in their numbers.
 */
export interface FailureCause {
  key: string;
  one: string;
  many: string;
}

const STEP_NAME_MAX = 60;

/** "Researcher" → "the Researcher"; null for anything that does not look like a step name. */
function stepSubject(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim().replace(/^the\s+/i, "");
  return name.length > 0 && name.length <= STEP_NAME_MAX && /^[\p{L}\p{N}][\p{L}\p{N} &'’()/-]*$/u.test(name) ? `the ${name}` : null;
}

const same = (key: string, clause: string): FailureCause => ({ key, one: clause, many: clause });

/** Maps the runtime's failure messages (runtime/limits, agent-loop, finish, context, queue, models) to a cause. */
export function describeRunFailure(raw: string): FailureCause {
  const text = raw.replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  if ((m = /^(.+?) did not return valid JSON\b/.exec(text))) {
    const who = stepSubject(m[1]) ?? "the worker";
    return same(`json:${who}`, `${who} returned unreadable results`);
  }
  if (/could not produce a valid .+ after one correction|while correcting its .+ output/.test(text)) {
    return same("json:model", "the AI model returned unreadable results");
  }
  if (/\blimit of \d+ tool calls?\b/i.test(text)) return { key: "tool-limit", one: "it hit its tool-use limit", many: "they hit their tool-use limit" };
  if (/\bcost limit\b/i.test(text)) return { key: "cost-limit", one: "it hit its cost limit", many: "they hit their cost limit" };
  if (/\btime limit\b/i.test(text)) return { key: "time-limit", one: "it hit its time limit", many: "they hit their time limit" };
  if ((m = /^(.+?) could not finish within \d+ turns?\b/.exec(text))) {
    const who = stepSubject(m[1]) ?? "the worker";
    return same(`turns:${who}`, `${who} ran out of steps before finishing`);
  }
  if (/^No deliverable was produced\b/i.test(text)) {
    return { key: "no-deliverable", one: "it finished without producing a deliverable", many: "they finished without producing a deliverable" };
  }
  if (/\b(blueprint|job spec) is invalid\b/i.test(text)) return { key: "setup", one: "its setup could not be loaded", many: "their setup could not be loaded" };
  if (/\bexecutor stopped responding\b/i.test(text)) return { key: "interrupted", one: "it was interrupted mid-run", many: "they were interrupted mid-run" };
  if (/could not complete the request|is not configured on this server/.test(text)) return same("model-unavailable", "the AI model was unavailable");
  if ((m = /^(.+?) failed: /.exec(text))) {
    const step = stepSubject(m[1]);
    if (step) return same(`step:${step}`, `${step} step could not process its input`);
  }
  return { key: "unexpected", one: "it ran into an unexpected error", many: "they ran into an unexpected error" };
}

/** Most frequent cause first; ties keep the most recent first (errors arrive newest first and the sort is stable). */
function groupCauses(errors: readonly string[]): Array<FailureCause & { count: number }> {
  const byKey = new Map<string, FailureCause & { count: number }>();
  for (const raw of errors) {
    const cause = describeRunFailure(raw);
    const hit = byKey.get(cause.key);
    if (hit) hit.count += 1;
    else byKey.set(cause.key, { ...cause, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

const because = (c: FailureCause, runs: number) => `because ${runs === 1 ? c.one : c.many}`;
const joinAnd = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** "3 of 8 runs failed — 2 because they hit their tool-use limit and 1 because the Researcher returned unreadable results". */
function failureLine(m: ReviewMetrics, errors: readonly string[]): string {
  const head = `${m.failed} of ${plural(m.runs, "run")} failed`;
  const causes = groupCauses(errors);
  if (causes.length === 0) return head;
  // The evidence is capped to the most recent failures, so say when it covers only some of them.
  const seen = causes.reduce((s, c) => s + c.count, 0);
  if (causes.length === 1) {
    const [only] = causes;
    if (seen >= m.failed) return `${head} ${because(only, m.failed)}`;
    return `${head} — ${only.count === 1 ? "the most recent" : `the last ${only.count}`} ${because(only, only.count)}`;
  }
  const shown = causes.slice(0, 2);
  const other = seen - shown.reduce((s, c) => s + c.count, 0);
  const parts = shown.map((c) => `${c.count} ${because(c, c.count)}`);
  if (other > 0) parts.push(`${other} for other reasons`);
  return `${head} — ${seen < m.failed ? `of the last ${seen}, ` : ""}${joinAnd(parts)}`;
}

function kpiLine(kpi: KpiActual, met: boolean): string {
  const actual = kpi.actual === null ? "n/a" : formatKpiValue(kpi.actual, kpi.unit);
  const target = formatKpiValue(kpi.target, kpi.unit);
  return met ? `${kpi.name} at ${actual} meets the target of ${target}` : `${kpi.name} at ${actual} misses the target of ${target}`;
}

function strengthsFrom(e: ReviewEvidence): string[] {
  const m = e.metrics;
  const reviewed = m.accepted + m.rejected;
  const out: string[] = [];
  if (m.accepted > 0 && (m.acceptanceRate ?? 0) >= 0.7) out.push(`Accepted ${m.accepted} of ${plural(reviewed, "reviewed deliverable")}`);
  if (m.runs >= 2 && (m.successRate ?? 0) >= 0.8) out.push(`${m.succeeded} of ${plural(m.runs, "run")} completed without a failure`);
  if (m.avgJudgeScore !== null && m.avgJudgeScore >= 0.75) {
    out.push(`The reviewer rated quality ${Math.round(m.avgJudgeScore * 100)}/100 on average`);
  }
  if (m.avgDeterministicScore !== null && m.avgDeterministicScore >= 0.9) {
    out.push(`Automated checks passed at ${Math.round(m.avgDeterministicScore * 100)}/100 on average`);
  }
  for (const kpi of m.kpis) if (kpi.met === true) out.push(kpiLine(kpi, true));
  return out.slice(0, MAX_ITEMS);
}

function problemsFrom(e: ReviewEvidence): string[] {
  const m = e.metrics;
  const out: string[] = [];
  if (m.runs === 0) out.push(`No finished runs in the last ${m.windowDays} days`);

  if (m.failed > 0) out.push(failureLine(m, e.failedRunErrors));
  if (m.rejected > 0) {
    const [first, ...rest] = e.rejectedFeedback;
    out.push(
      `${m.rejected} of ${plural(m.accepted + m.rejected, "reviewed deliverable")} ${m.rejected === 1 ? "was" : "were"} sent back` +
        (first ? ` — feedback on “${first.title}”: ${quote(first.feedback)}` : ""),
    );
    for (const item of rest.slice(0, 2)) out.push(`Also sent back “${item.title}”: ${quote(item.feedback)}`);
  }
  if (m.avgJudgeScore !== null && m.avgJudgeScore < 0.7) {
    out.push(`The reviewer rated quality only ${Math.round(m.avgJudgeScore * 100)}/100 on average`);
  }
  if (m.avgDeterministicScore !== null && m.avgDeterministicScore < 0.7) {
    out.push(`Automated checks passed at only ${Math.round(m.avgDeterministicScore * 100)}/100 on average`);
  }
  for (const kpi of m.kpis) if (kpi.met === false) out.push(kpiLine(kpi, false));
  return out.slice(0, MAX_ITEMS);
}

function summaryFrom(e: ReviewEvidence): string {
  const m = e.metrics;
  const scoreText = e.score.score === null ? "There is no quality score yet." : `Overall quality score: ${Math.round(e.score.score)}/100.`;
  if (m.runs === 0) {
    return `${e.workerName} has no finished runs in the last ${m.windowDays} days on “${e.jobTitle}”, so there is little to assess. ${scoreText}`;
  }
  const pending = m.deliverables - m.accepted - m.rejected;
  const review =
    m.deliverables === 0
      ? "produced no deliverables"
      : `delivered ${plural(m.deliverables, "deliverable")} (${m.accepted} accepted, ${m.rejected} sent back${pending > 0 ? `, ${pending} awaiting review` : ""})`;
  const cost = m.avgCostPerRunUsd !== null ? ` Runs cost ${formatKpiValue(m.avgCostPerRunUsd, "$")} on average.` : "";
  return `${e.workerName} completed ${plural(m.runs, "run")} in the last ${m.windowDays} days (${m.succeeded} succeeded, ${m.failed} failed) and ${review}. ${scoreText}${cost}`;
}

export function mockReviewNarrative(e: ReviewEvidence): ReviewNarrative {
  const verdict = recommendFromMetrics(e.score.score, e.metrics);
  const problems = problemsFrom(e);
  const strengths = strengthsFrom(e);
  const because = verdict.reasons.join(" and ");
  const focus = problems[0] ? ` Start with: ${problems[0].charAt(0).toLowerCase()}${problems[0].slice(1)}.` : "";

  const recommendationDetail =
    verdict.recommendation === "REPLACE"
      ? `Replace ${e.workerName} because ${because}. A replacement should address the problems above before it takes over.${focus}`
      : verdict.recommendation === "IMPROVE"
        ? `Keep ${e.workerName} but tighten the brief: ${because}.${focus}`
        : `Keep ${e.workerName} as is — ${because}${e.metrics.runs > 0 ? `, with ${e.metrics.succeeded} of ${plural(e.metrics.runs, "run")} succeeding` : ""}.`;

  return {
    summary: summaryFrom(e),
    strengths,
    problems,
    recommendation: verdict.recommendation,
    recommendationDetail,
  };
}
