import type { EvaluationType } from "@prisma/client";
import { EmptyState } from "@/components/empty-state";
import { SimulatedBadge } from "@/components/simulated-badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { SCORE_BAND_CLASSES, scoreBand } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { EvaluationDetails } from "@/server/domain/evaluation";

/**
 * How a deliverable measured up, written as findings rather than a table of numbers: one headline score, the
 * automated checks as sentences, the reviewer's criteria as quiet bars, and the human verdict last. Shared by
 * /runs/[runId] and /deliverables/[id]. Server-safe (no hooks).
 */

export interface EvaluationCardData {
  id: string;
  type: EvaluationType;
  /** 0..1 */
  score: number;
  passed: boolean;
  summary: string | null;
  details: EvaluationDetails | null;
  createdAt: string;
}

export interface EvaluationFindingsProps {
  evaluations: EvaluationCardData[];
  workerName: string;
  /** Blended 0..100 score for the headline. Omitted → the average of the automated verdicts. */
  score?: number | null;
  /** Shown when there is nothing yet. */
  emptyDescription?: string;
  /** "tile" = the flat #f5f5f7 card, for a white page (the deliverable reading view). */
  surface?: "default" | "tile";
}

/**
 * How much a criterion counts, as a share of the rubric: "counts for 29%". Weights are relative (a 2 beside five
 * 1s is 2/7, not "200%"), and when every criterion counts the same the line says nothing, so it is left out.
 */
export function criterionShare(weight: number, weights: number[]): string | null {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0) || weights.every((w) => w === weights[0])) return null;
  return `counts for ${Math.round((weight / total) * 100)}%`;
}

/** The headline is a whole number everywhere it appears — the section intro rounds the same way. */
export function headlineScore(score: number | null | undefined, automated: Array<{ score: number }>): number | null {
  if (score !== null && score !== undefined) return Math.round(score);
  if (automated.length === 0) return null;
  return Math.round((automated.reduce((s, e) => s + e.score, 0) / automated.length) * 100);
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-6 first:border-0 first:pt-0">
      <h3 className="text-title-3">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A 6px rail: neutral fill, because a colour per criterion turns the page into a rainbow. */
function CriterionBar({ score }: { score: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  return (
    <span className="flex items-center gap-3">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary sm:w-32" aria-hidden="true">
        <span className="block h-full rounded-full bg-foreground/75" style={{ width: `${pct}%` }} />
      </span>
      <span className="metric w-7 text-right text-footnote text-foreground">{pct}</span>
    </span>
  );
}

function Checks({ evaluation, workerName }: { evaluation: EvaluationCardData; workerName: string }) {
  const checks = evaluation.details?.kind === "deterministic" ? evaluation.details.checks : [];
  const passed = checks.filter((c) => c.passed).length;

  return (
    <>
      <p className="text-[15px] text-pretty text-muted-foreground">
        {checks.length > 0
          ? `${passed} of ${checks.length} checks passed on what ${workerName} handed in.`
          : (evaluation.summary ?? `Rules applied to what ${workerName} delivered.`)}
      </p>
      {checks.length > 0 ? (
        <ul className="mt-3">
          {/* Sentence first, the measurement under it: a long "expected …" detail can't squeeze the check's own
              words into a one-word column or run past the card. */}
          {checks.map((c) => (
            <li key={c.id} className="flex items-baseline gap-2.5 border-b border-border py-3 last:border-0">
              <span
                aria-hidden="true"
                className={cn("size-[7px] shrink-0 translate-y-[-1px] rounded-full", c.passed ? "bg-success" : "bg-danger")}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] text-pretty">{c.description}</span>
                <span className="metric mt-0.5 block text-footnote break-words text-muted-foreground">
                  {c.observed}
                  {c.expected ? ` · expected ${c.expected}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Judge({ evaluation }: { evaluation: EvaluationCardData }) {
  const details = evaluation.details?.kind === "llm_judge" ? evaluation.details : null;
  if (!details) {
    return <p className="text-[15px] text-pretty text-muted-foreground">{evaluation.summary ?? "Scored against the job’s rubric."}</p>;
  }
  const weights = details.criteria.map((c) => c.weight);

  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-muted-foreground">
        <span>Scored against the job’s rubric by {details.model}</span>
        {details.simulated ? <SimulatedBadge /> : null}
      </p>
      <ul className="mt-3">
        {details.criteria.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 border-b border-border py-4 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
            <span className="min-w-0">
              <span className="block text-[15px] font-medium">{c.criterion}</span>
              <span className="mt-0.5 block text-footnote text-pretty text-muted-foreground">{c.reasoning}</span>
            </span>
            <span className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
              <CriterionBar score={c.score} />
              {criterionShare(c.weight, weights) ? (
                <span className="text-caption text-muted-foreground">{criterionShare(c.weight, weights)}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {details.overallReasoning ? (
        <blockquote className="mt-5 border-l-[3px] border-input pl-5 text-[17px] leading-[1.5] text-pretty text-muted-foreground">
          {details.overallReasoning}
        </blockquote>
      ) : null}
    </>
  );
}

function Verdict({ evaluation }: { evaluation: EvaluationCardData }) {
  const details = evaluation.details?.kind === "user_feedback" ? evaluation.details : null;
  const accepted = details ? details.decision === "accepted" : evaluation.passed;
  return (
    <>
      <p className="flex flex-wrap items-center gap-2 text-[15px]">
        <span aria-hidden="true" className={cn("size-[7px] rounded-full", accepted ? "bg-success" : "bg-danger")} />
        {accepted ? "You accepted this" : "You sent this back"}
        <span className="text-muted-foreground">· {formatDate(evaluation.createdAt)}</span>
      </p>
      {details?.feedback ? (
        <blockquote className="mt-4 border-l-[3px] border-input pl-5 text-[17px] leading-[1.5] text-pretty text-muted-foreground">
          {details.feedback}
        </blockquote>
      ) : null}
    </>
  );
}

const ORDER: Record<EvaluationType, number> = { DETERMINISTIC: 0, LLM_JUDGE: 1, USER_FEEDBACK: 2 };

export function EvaluationFindings({ evaluations, workerName, score, emptyDescription, surface = "default" }: EvaluationFindingsProps) {
  if (evaluations.length === 0) {
    return (
      <Card variant={surface}>
        <EmptyState
          title="Not evaluated yet"
          description={emptyDescription ?? `Automated checks and the reviewer run as soon as ${workerName} finishes.`}
          className="py-14"
        />
      </Card>
    );
  }

  const automated = evaluations.filter((e) => e.type !== "USER_FEEDBACK");
  const headline = headlineScore(score, automated);
  const band = SCORE_BAND_CLASSES[scoreBand(headline)];
  const sorted = [...evaluations].sort((a, b) => ORDER[a.type] - ORDER[b.type]);

  return (
    <Card variant={surface}>
      <CardContent className="space-y-6">
        {headline !== null ? (
          <div>
            <p className="text-metric text-foreground">{headline}</p>
            <p className="mt-1 text-footnote text-muted-foreground">
              out of 100 · <span className={band.text}>{band.label}</span>
            </p>
          </div>
        ) : null}

        {sorted.map((e) =>
          e.type === "DETERMINISTIC" ? (
            <Block key={e.id} title="Automated checks">
              <Checks evaluation={e} workerName={workerName} />
            </Block>
          ) : e.type === "LLM_JUDGE" ? (
            <Block key={e.id} title="Reviewer’s assessment">
              <Judge evaluation={e} />
            </Block>
          ) : (
            <Block key={e.id} title="Your verdict">
              <Verdict evaluation={e} />
            </Block>
          ),
        )}
      </CardContent>
    </Card>
  );
}
