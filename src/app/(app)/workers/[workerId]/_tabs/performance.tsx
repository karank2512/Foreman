import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { Section } from "@/components/section";
import { Stat, StatStrip } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, formatDuration, formatNumber, formatPercent, formatUsdPrecise, pluralize } from "@/lib/format";
import { SCORE_BAND_CLASSES, scoreBand } from "@/lib/status";
import { cn } from "@/lib/utils";
import { can } from "@/server/auth/permissions";
import { getWorkerPerformance, type ActiveVersionRef, type WorkerReviewRow } from "@/server/queries/worker-profile";
import { GenerateReviewButton } from "../_components/generate-review";
import { describeScore, formatKpiValue, kpiVerdict } from "../_components/kpi-format";
import { beforeChangeLabel, evaluationHint, evaluationLabel, RECOMMENDATION_META } from "../_components/labels";
import { Row, RowList, RowMeta, RowTitle, Sep } from "../_components/rows";
import { PerformanceChart } from "./performance-chart";
import type { WorkerTabProps } from "./types";

const COMPONENT_LABELS = {
  deterministic: { label: "Automated checks", hint: "Record counts, required fields, duplicates, sections, cost limits." },
  judge: { label: "AI judge", hint: "A reviewer model scores each deliverable against the job's rubric." },
  user: { label: "Your feedback", hint: "Deliverables you accepted or sent back." },
} as const;

export default async function PerformanceTab({ session, workerId, workerName }: WorkerTabProps) {
  const data = await getWorkerPerformance(session.organizationId, workerId);
  const { score, metrics } = data;
  const band = SCORE_BAND_CLASSES[scoreBand(score.score)];
  const active = data.activeVersion;
  const mayReview = can(session.role, "reviews.generate");
  // Reviews are newest first; after a replacement the old verdicts stay visible, but only as history.
  const latestCurrentId = data.reviews.find((r) => r.forCurrentVersion)?.id ?? null;
  const onlyHistory = active !== null && data.reviews.length > 0 && latestCurrentId === null;

  return (
    <>
      <Card>
        <CardContent className="grid gap-8 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:gap-12">
          <div>
            <p className="text-metric-xl text-foreground">{score.score === null ? "—" : Math.round(score.score)}</p>
            <p className="text-footnote mt-1.5 text-muted-foreground">
              Performance · <span className={band.text}>{band.label}</span>
            </p>
            <p className="mt-4 max-w-[34ch] text-[15px] text-pretty text-muted-foreground">
              {score.sampleSize.runs > 0
                ? `${workerName} is ${describeScore(score.score)}, over the last ${pluralize(score.sampleSize.runs, "finished run")}${
                    data.currentVersion ? ` of version ${data.currentVersion}` : ""
                  }.`
                : `${workerName} gets a score once the first run has been evaluated.`}
            </p>
          </div>

          <ul className="flex flex-col justify-center gap-5">
            {(["deterministic", "judge", "user"] as const).map((key) => {
              const value = score.components[key];
              const weight = score.weightsUsed[key];
              const n = score.sampleSize[key];
              return (
                <li key={key} title={COMPONENT_LABELS[key].hint}>
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <span className="text-[15px] font-medium">{COMPONENT_LABELS[key].label}</span>
                    <span className="metric text-footnote text-muted-foreground">
                      {value === null ? "No data yet" : `${Math.round(value * 100)} · ${pluralize(n, "sample")} · weight ${formatPercent(weight)}`}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-foreground/80"
                      style={{ width: value === null ? "0%" : `${Math.max(2, Math.round(value * 100))}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <StatStrip>
        <Stat
          label="Finished cleanly"
          value={formatPercent(metrics.successRate)}
          hint={`${metrics.succeeded} of ${pluralize(metrics.runs, "run")}`}
        />
        <Stat
          label="Work accepted"
          value={formatPercent(metrics.acceptanceRate)}
          hint={
            metrics.accepted + metrics.rejected > 0
              ? `${metrics.accepted} accepted · ${metrics.rejected} sent back`
              : "Nothing reviewed yet"
          }
        />
        <Stat
          label="AI judge"
          value={metrics.avgJudgeScore === null ? "—" : formatNumber(metrics.avgJudgeScore * 100, 0)}
          hint="Average out of 100"
        />
        <Stat
          label="Cost a run"
          value={formatUsdPrecise(metrics.avgCostPerRunUsd)}
          hint={`${metrics.avgDurationSec === null ? "—" : formatDuration(metrics.avgDurationSec * 1000)} of working time`}
        />
      </StatStrip>

      <Section
        title="Score per run"
        description={`Every finished run, scored 0–100 over the last ${metrics.windowDays} days.`}
      >
        <Card>
          <CardContent>
            {metrics.scoreTrend.length < 2 ? (
              <EmptyState
                title="Not enough runs for a trend"
                description={`A line appears once ${workerName} has finished two evaluated runs.`}
                className="py-14"
              />
            ) : (
              <PerformanceChart points={metrics.scoreTrend} workerName={workerName} />
            )}
          </CardContent>
        </Card>
      </Section>

      <Section title="Targets" description={`Measured over the last ${metrics.windowDays} days.`}>
        {metrics.kpis.length === 0 ? (
          <Card>
            <CardContent>
              <p className="text-muted-foreground">No targets were set for this job.</p>
            </CardContent>
          </Card>
        ) : (
          <RowList>
            {metrics.kpis.map((kpi) => {
              const verdict = kpiVerdict(kpi);
              return (
                <Row key={kpi.kpiId} className="items-center">
                  <div className="min-w-0 flex-1">
                    <RowTitle>{kpi.name}</RowTitle>
                    <RowMeta>
                      <span>
                        Target {kpi.direction === "lower_is_better" ? "at most" : "at least"}{" "}
                        <span className="metric">{formatKpiValue(kpi.metric, kpi.target)}</span>
                      </span>
                      <Sep />
                      <span className={cn(verdict === "met" ? "text-success" : verdict === "missed" ? "text-danger" : "")}>
                        {verdict === "met" ? "On target" : verdict === "missed" ? "Behind" : "Not enough data"}
                      </span>
                    </RowMeta>
                  </div>
                  <span className="metric shrink-0 text-[17px] font-semibold">{formatKpiValue(kpi.metric, kpi.actual)}</span>
                </Row>
              );
            })}
          </RowList>
        )}
      </Section>

      <Section
        title="Performance reviews"
        description={`A written verdict on ${workerName}'s recent work: keep, improve or replace.`}
        actions={
          mayReview && data.reviews.length > 0 && active ? (
            <GenerateReviewButton workerId={workerId} workerName={workerName} label="Write a review" />
          ) : undefined
        }
      >
        {data.reviews.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                title="No reviews yet"
                description={`Have ${workerName}'s recent work assessed: a score, what went well, what didn't, and a clear call.`}
                action={
                  mayReview && active ? (
                    <GenerateReviewButton workerId={workerId} workerName={workerName} size="lg" label="Write a performance review" />
                  ) : undefined
                }
              />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {onlyHistory && active ? (
              <p className="text-[15px] text-pretty text-muted-foreground">
                The reviews below were written about earlier versions. {workerName} has worked as version{" "}
                {active.version}
                {active.activatedAt ? ` since ${formatDate(active.activatedAt)}` : ""}, so they no longer describe
                today&apos;s work.
              </p>
            ) : null}
            {data.reviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                workerId={workerId}
                workerName={workerName}
                latest={review.id === latestCurrentId}
                active={active}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Evaluations"
        description={`Every check run on ${workerName}'s deliverables, newest first.${
          data.evaluations.some((e) => e.simulated) ? " The AI judge's scores come from the simulator." : ""
        }`}
        actions={
          <Button variant="link" asChild>
            <Link href={`/workers/${workerId}?tab=deliverables`}>
              The deliverables <ChevronRight data-icon="inline-end" />
            </Link>
          </Button>
        }
      >
        {data.evaluations.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                title="No evaluations yet"
                description="Each finished run is checked automatically and scored by an AI judge."
              />
            </CardContent>
          </Card>
        ) : (
          <RowList>
            {data.evaluations.map((e) => {
              const pct = Math.round(e.score * 100);
              const evalBand = SCORE_BAND_CLASSES[scoreBand(pct)];
              return (
                <Row key={e.id} href={e.deliverableId ? `/deliverables/${e.deliverableId}` : e.runId ? `/runs/${e.runId}` : undefined}>
                  <div className="min-w-0 flex-1">
                    <RowTitle>
                      <span title={evaluationHint(e.type)}>{evaluationLabel(e.type)}</span>
                      {e.deliverableTitle ? (
                        <span className="font-normal text-muted-foreground"> · {e.deliverableTitle}</span>
                      ) : null}
                    </RowTitle>
                    {e.summary ? (
                      <p className="text-footnote mt-1 line-clamp-2 text-pretty text-muted-foreground">{e.summary}</p>
                    ) : null}
                    <RowMeta>
                      <span className={e.passed ? "text-success" : "text-danger"}>{e.passed ? "Passed" : "Did not pass"}</span>
                      <Sep />
                      <RelativeTime iso={e.createdAt} />
                    </RowMeta>
                  </div>
                  <span className={cn("metric shrink-0 text-[17px] font-semibold", evalBand.text)}>{pct}</span>
                </Row>
              );
            })}
          </RowList>
        )}
      </Section>
    </>
  );
}

function ReviewCard({
  review,
  workerId,
  workerName,
  latest,
  active,
}: {
  review: WorkerReviewRow;
  workerId: string;
  workerName: string;
  latest: boolean;
  active: ActiveVersionRef | null;
}) {
  const meta = RECOMMENDATION_META[review.recommendation];
  const historical = !review.forCurrentVersion;
  const band = SCORE_BAND_CLASSES[scoreBand(review.overallScore)];

  return (
    <Card id={latest ? "latest-review" : undefined} className="scroll-mt-32">
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <h3 className="text-title-2 text-balance">
              {historical ? `Review of version ${review.version}` : meta.headline(workerName)}
            </h3>
            <p className="text-footnote mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
              <span>
                {formatDate(review.periodStart)} – {formatDate(review.periodEnd)}
              </span>
              <Sep />
              <span className="metric">Version {review.version}</span>
              <Sep />
              <span>
                written <RelativeTime iso={review.createdAt} />
              </span>
              {latest ? (
                <>
                  <Sep />
                  <span className="font-medium text-foreground">Latest</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-metric text-foreground">{Math.round(review.overallScore)}</p>
            <p className={cn("text-footnote mt-0.5", band.text)}>{band.label}</p>
          </div>
        </div>

        <p className="max-w-[65ch] text-[17px] text-pretty">{review.summary}</p>

        {review.strengths.length > 0 || review.problems.length > 0 ? (
          <div className="grid gap-8 sm:grid-cols-2">
            {review.strengths.length > 0 ? (
              <div>
                <p className="eyebrow mb-2">What went well</p>
                <ul className="space-y-2">
                  {review.strengths.map((s) => (
                    <li key={s} className="text-[15px] text-pretty">
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {review.problems.length > 0 ? (
              <div>
                <p className="eyebrow mb-2">What didn&apos;t</p>
                <ul className="space-y-2">
                  {review.problems.map((p) => (
                    <li key={p} className="text-[15px] text-pretty">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="border-t border-border pt-5">
          <p className="max-w-[65ch] text-[15px] text-pretty text-muted-foreground">
            <span className="font-medium text-foreground">
              {historical ? `The call on version ${review.version} was ${meta.label.toLowerCase()}.` : `The call: ${meta.label.toLowerCase()}.`}
            </span>{" "}
            {review.recommendationDetail}
            {historical && active ? (
              <>
                {" "}
                {workerName} has worked as version {active.version}
                {active.activatedAt ? ` since ${formatDate(active.activatedAt)}` : ""}, {beforeChangeLabel(active.changeReason)}, so this
                no longer applies.
              </>
            ) : null}
          </p>
          {!historical && review.recommendation !== "KEEP" ? (
            <p className="mt-3">
              <Link
                href={
                  review.recommendation === "REPLACE"
                    ? `/workers/${workerId}?tab=versions`
                    : `/workers/${workerId}?tab=chat`
                }
                className="text-[15px] font-medium text-link hover:underline"
              >
                {review.recommendation === "REPLACE" ? "Look at a replacement" : `Talk to ${workerName} about it`} ›
              </Link>
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
