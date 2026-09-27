import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { Section } from "@/components/section";
import { Stat, StatStrip } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatPercent, formatUsd, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getWorkerOverview, type ActiveVersionRef, type PipelineStep, type WorkerReviewRow } from "@/server/queries/worker-profile";
import { formatKpiValue, kpiVerdict } from "../_components/kpi-format";
import { beforeChangeLabel, exampleTitle, operationLabel, reviewVerdict } from "../_components/labels";
import { Row, RowList, RowMeta, RowTitle, Sep } from "../_components/rows";
import { RunsTable } from "../_components/runs-table";
import { TierChip } from "../_components/tier-chip";
import type { WorkerTabProps } from "./types";

export default async function OverviewTab({ session, workerId, workerName }: WorkerTabProps) {
  const data = await getWorkerOverview(session.organizationId, workerId);
  const review = data.latestReview;
  const { metrics } = data;
  const href = (tab: string) => `/workers/${workerId}?tab=${tab}`;
  const successRate = metrics.runs > 0 ? metrics.succeeded / metrics.runs : null;
  const reviewed = metrics.accepted + metrics.rejected;
  // The job usually sets its own cost target; the plan then rides on that row instead of a second "Cost per run".
  const planned = data.cost.estimatedPerRunUsd;
  const hasCostKpi = data.kpis.some((k) => k.metric === COST_METRIC);

  return (
    <>
      {/* A verdict only drives the page while it is about the version running today; once the worker has been
          replaced (or changed), an old "replace" call is history and must not push the user to act on it. */}
      {review && review.recommendation !== "KEEP" ? (
        review.forCurrentVersion ? (
          <ReviewNote workerId={workerId} workerName={workerName} review={review} />
        ) : data.activeVersion ? (
          <StaleReviewNote workerId={workerId} workerName={workerName} review={review} active={data.activeVersion} />
        ) : null
      ) : null}

      <StatStrip>
        <Stat
          label={`Runs, last ${metrics.windowDays} days`}
          value={metrics.runs}
          hint={metrics.runs === 0 ? "Nothing yet" : `${metrics.failed} failed`}
        />
        <Stat
          label="Finished cleanly"
          value={successRate === null ? "—" : formatPercent(successRate)}
          hint={metrics.runs > 0 ? `${metrics.succeeded} of ${pluralize(metrics.runs, "run")}` : "No runs to judge"}
        />
        <Stat
          label="Work accepted"
          value={reviewed > 0 ? formatPercent(metrics.accepted / reviewed) : "—"}
          hint={reviewed > 0 ? `${metrics.accepted} accepted · ${metrics.rejected} sent back` : "Nothing reviewed yet"}
        />
        <Stat
          label="Spend so far"
          value={formatUsd(metrics.totalCostUsd)}
          hint={metrics.runs > 0 ? `across ${pluralize(metrics.runs, "run")}` : "Nothing spent yet"}
        />
      </StatStrip>

      <Section title={`About ${workerName}`} description={data.summary ?? undefined}>
        {data.responsibilities.length === 0 ? (
          <Card>
            <CardContent>
              <p className="text-muted-foreground">
                {workerName} has no active version, so there is nothing to describe yet.
              </p>
            </CardContent>
          </Card>
        ) : (
          <RowList>
            {data.responsibilities.map((r) => (
              <Row key={r}>
                <p className="text-[15px] text-pretty">{r}</p>
              </Row>
            ))}
          </RowList>
        )}
      </Section>

      <Section
        title={`How ${workerName} works`}
        description={`Every run goes through these steps in order.${
          data.deliverable ? ` It ends with “${exampleTitle(data.deliverable.titleTemplate)}”.` : ""
        }`}
        actions={
          <Button variant="link" asChild>
            <Link href={href("permissions")}>
              Tools and access <ChevronRight data-icon="inline-end" />
            </Link>
          </Button>
        }
      >
        {data.pipeline.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                title="No working steps yet"
                description={`${workerName} has no active version, so there is no pipeline to show.`}
                className="py-12"
              />
            </CardContent>
          </Card>
        ) : (
          <>
            <RowList>
              {data.pipeline.map((step, index) => (
                <PipelineRow key={step.id} step={step} index={index} />
              ))}
            </RowList>
            {data.tools.length > 0 ? (
              <p className="text-footnote mt-4 text-pretty text-muted-foreground">
                {toolSentence(workerName, data.tools)}{" "}
                <Link href={href("permissions")} className="text-link hover:underline">
                  Change what they can touch ›
                </Link>
              </p>
            ) : null}
          </>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          className="flex flex-col"
          title="Targets"
          description={`What ${workerName} was hired to hit, over the last ${metrics.windowDays} days.`}
        >
          <Card className="flex-1 gap-0 py-0">
            {data.kpis.length === 0 ? (
              <CardContent className="py-6">
                <p className="text-muted-foreground">No targets were set for this job.</p>
              </CardContent>
            ) : (
              <ul role="list" className="flex flex-col">
                {data.kpis.map((kpi) => {
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
                          <span
                            className={cn(
                              verdict === "met" ? "text-success" : verdict === "missed" ? "text-danger" : "",
                            )}
                          >
                            {verdict === "met" ? "On target" : verdict === "missed" ? "Behind" : "Not enough data"}
                          </span>
                          {kpi.metric === COST_METRIC && planned !== null ? (
                            <>
                              <Sep />
                              <span>
                                planned <span className="metric">{formatKpiValue(COST_METRIC, planned)}</span>
                              </span>
                            </>
                          ) : null}
                        </RowMeta>
                      </div>
                      <span className="metric shrink-0 text-[17px] font-semibold">
                        {formatKpiValue(kpi.metric, kpi.actual)}
                      </span>
                    </Row>
                  );
                })}
                {planned !== null && !hasCostKpi ? (
                  <Row className="items-center">
                    <div className="min-w-0 flex-1">
                      <RowTitle>Cost per run</RowTitle>
                      <RowMeta>
                        <span>
                          Planned <span className="metric">{formatKpiValue(COST_METRIC, planned)}</span>
                        </span>
                        <Sep />
                        <span>{costVerdict(planned, data.cost.actualAvgPerRunUsd)}</span>
                      </RowMeta>
                    </div>
                    <span className="metric shrink-0 text-[17px] font-semibold">
                      {formatKpiValue(COST_METRIC, data.cost.actualAvgPerRunUsd)}
                    </span>
                  </Row>
                ) : null}
              </ul>
            )}
          </Card>
        </Section>

        <Section
          className="flex flex-col"
          title="Latest deliverable"
          description={
            data.latestDeliverable ? undefined : `Everything ${workerName} produces will show up here.`
          }
          actions={
            data.latestDeliverable ? (
              <Button variant="link" asChild>
                <Link href={href("deliverables")}>
                  All deliverables <ChevronRight data-icon="inline-end" />
                </Link>
              </Button>
            ) : undefined
          }
        >
          <Card className="flex-1">
            <CardContent className="flex h-full flex-col">
              {data.latestDeliverable ? (
                <>
                  <Link
                    href={`/deliverables/${data.latestDeliverable.id}`}
                    className="text-title-3 text-pretty hover:text-link"
                  >
                    {data.latestDeliverable.title}
                  </Link>
                  <p className="text-footnote mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                    <StatusBadge kind="deliverable" status={data.latestDeliverable.status} emphasis="dot" />
                    <Sep />
                    <RelativeTime iso={data.latestDeliverable.createdAt} />
                    {data.latestDeliverable.recordCount !== null ? (
                      <>
                        <Sep />
                        <span>{pluralize(data.latestDeliverable.recordCount, "record")}</span>
                      </>
                    ) : null}
                  </p>
                  {data.latestDeliverable.summary ? (
                    <p className="mt-4 line-clamp-3 text-[15px] text-pretty text-muted-foreground">
                      {data.latestDeliverable.summary}
                    </p>
                  ) : null}
                  <p className="mt-auto pt-5">
                    <Link
                      href={`/deliverables/${data.latestDeliverable.id}`}
                      className="text-[15px] font-medium text-link hover:underline"
                    >
                      {data.latestDeliverable.status === "PENDING_REVIEW" ? "Read and review" : "Read it"} ›
                    </Link>
                  </p>
                </>
              ) : (
                <EmptyState
                  title="Nothing delivered yet"
                  description={`${workerName}'s first finished run will leave its work here.`}
                  className="py-12"
                />
              )}
            </CardContent>
          </Card>
        </Section>
      </div>

      <Section
        title="Recent runs"
        description={data.recentRuns.length > 0 ? `The last ${pluralize(data.recentRuns.length, "run")}.` : undefined}
        actions={
          <Button variant="link" asChild>
            <Link href={href("activity")}>
              All activity <ChevronRight data-icon="inline-end" />
            </Link>
          </Button>
        }
      >
        <RunsTable runs={data.recentRuns} workerName={workerName} compact />
      </Section>
    </>
  );
}

/** The KPI metric a job uses for its cost target (see `KPI_METRICS` in the domain). */
const COST_METRIC = "cost_per_run_usd";

function toolSentence(workerName: string, tools: Array<{ label: string; requiresApproval: boolean }>): string {
  const open = tools.filter((t) => !t.requiresApproval).map((t) => t.label);
  const gated = tools.filter((t) => t.requiresApproval).map((t) => t.label);
  const list = (items: string[]) =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const parts: string[] = [];
  if (open.length > 0) parts.push(`${workerName} can use ${list(open)} on their own.`);
  if (gated.length > 0) parts.push(`${open.length > 0 ? "They ask" : `${workerName} asks`} first before using ${list(gated)}.`);
  return parts.join(" ");
}

function costVerdict(estimated: number, actual: number | null): string {
  if (actual === null) return "No finished runs to compare yet";
  if (estimated <= 0) return "No estimate on file";
  const delta = (actual - estimated) / estimated;
  if (delta > 0.1) return `${formatPercent(delta)} over plan`;
  if (delta < -0.1) return `${formatPercent(-delta)} under plan`;
  return "On plan";
}

function PipelineRow({ step, index }: { step: PipelineStep; index: number }) {
  return (
    <Row>
      <span className="metric text-footnote w-5 shrink-0 pt-0.5 text-tertiary">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <RowTitle>{step.name}</RowTitle>
        <p className="text-callout mt-1 text-pretty text-muted-foreground">{step.description}</p>
        <RowMeta>
          {step.tier ? <TierChip tier={step.tier} /> : <span>{operationLabel(step.operation)}</span>}
          {step.tools.length > 0 ? (
            <>
              <Sep />
              <span>Uses {step.tools.map((t) => t.label).join(", ")}</span>
            </>
          ) : null}
        </RowMeta>
      </div>
    </Row>
  );
}

/**
 * The verdict of a review of the version running today, as one quiet line. The header already carries the one
 * tinted "needs you" panel (health, or the drafted replacement), so this neither repeats it in a second panel
 * nor quotes the review's reasoning — that, with its score from the day it was written, lives on Performance.
 */
function ReviewNote({ workerId, workerName, review }: { workerId: string; workerName: string; review: WorkerReviewRow }) {
  return (
    <p className="text-[15px] text-pretty text-muted-foreground">
      <span className="font-medium text-foreground">{reviewVerdict(workerName, review.recommendation)}</span>{" "}
      <Link href={`/workers/${workerId}?tab=performance#latest-review`} className="font-medium text-link hover:underline">
        Read the review ›
      </Link>
    </p>
  );
}

/** The verdict was about a design that no longer runs — readable history, no call to action. */
function StaleReviewNote({
  workerId,
  workerName,
  review,
  active,
}: {
  workerId: string;
  workerName: string;
  review: WorkerReviewRow;
  active: ActiveVersionRef;
}) {
  return (
    <p className="text-[15px] text-pretty text-muted-foreground">
      The last review was written about version {review.version}, {beforeChangeLabel(active.changeReason)}, and no
      longer describes how {workerName} works today.{" "}
      <Link href={`/workers/${workerId}?tab=performance`} className="font-medium text-link hover:underline">
        Review version {active.version} ›
      </Link>
    </p>
  );
}
