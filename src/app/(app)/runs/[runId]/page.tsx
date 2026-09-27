import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { LocalNav } from "@/components/shell/local-nav";
import { StatusBadge } from "@/components/status-badge";
import { WorkerAvatar } from "@/components/worker-avatar";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime, formatNumber, pluralize } from "@/lib/format";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { getRunDetail, type RunDetail, type RunStepDetailView } from "@/server/queries/runs";
import { EvaluationFindings } from "../_components/evaluation-findings";
import { DebugTrace } from "./_components/debug-trace";
import { RunMetaLine, RunProgressLine, RunProgressRail } from "./_components/live-header";
import { RunActions, RunStickyActions } from "./_components/run-actions";
import { RunLiveProvider } from "./_components/run-live";
import { RunTimeline } from "./_components/run-timeline";
import { runHeading, TRIGGER_LABEL } from "./_components/step-meta";

type Params = { params: Promise<{ runId: string }> };

/** Anchors sit below the global nav (48) + local nav (52), with air. */
const ANCHOR = "scroll-mt-[116px]";

/** generateMetadata and the page both need the detail view — one set of DB round trips per request. */
const load = cache(async (runId: string): Promise<RunDetail | null> => {
  const s = await requireSession();
  try {
    return await getRunDetail(s.organizationId, runId, { role: s.role });
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") return null;
    throw e;
  }
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { runId } = await params;
  const detail = await load(runId);
  if (!detail) return { title: "Run" };
  const { run } = detail.live;
  return { title: `${runHeading(run.startedAt, run.createdAt)} · ${detail.worker.name}` };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-0 text-footnote">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-foreground">{children}</dd>
    </div>
  );
}

export default async function RunPage({ params }: Params) {
  const { runId } = await params;
  const detail = await load(runId);
  if (!detail) notFound();
  const { live, worker, job, version, permissions } = detail;
  const run = live.run;
  const heading = runHeading(run.startedAt, run.createdAt);

  const stepDetails: Record<string, RunStepDetailView> = Object.fromEntries(detail.steps.map((step) => [step.id, step]));
  const firstDeliverable = detail.deliverables[0] ?? null;

  const staticFacts = [
    TRIGGER_LABEL[run.trigger],
    `v${version.version}`,
    detail.requestedByName ? `requested by ${detail.requestedByName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <RunLiveProvider runId={run.id} initial={live}>
      <RunProgressRail />

      <PageHeader
        backHref={`/workers/${worker.id}`}
        backLabel={worker.name}
        title={heading}
        description={
          <span className="flex flex-col gap-1.5">
            <RunMetaLine />
            <span className="text-footnote text-muted-foreground">
              For <Link href={`/jobs/${job.id}`}>{job.title}</Link> · {staticFacts}
            </span>
            <RunProgressLine workerName={worker.name} />
          </span>
        }
        actions={
          <RunActions
            runId={run.id}
            workerId={worker.id}
            workerName={worker.name}
            deliverable={firstDeliverable}
            canRun={permissions["workers.run"]}
          />
        }
      />

      <LocalNav
        title={heading}
        items={[
          { label: "Timeline", href: "#timeline", active: true },
          { label: "Deliverable", href: "#deliverable" },
          { label: "Evaluation", href: "#evaluation" },
          { label: "Debug", href: "#debug" },
        ]}
      />

      {/* Grid items default to min-width:auto, which lets a wide JSON line or table widen the phone layout;
          min-w-0 keeps every column to the screen. Debug is its own item so that, stacked on a phone, the facts
          card comes before it instead of reading as part of the troubleshooting section. */}
      <div className="mt-10 grid gap-y-14 lg:grid-cols-12 lg:gap-x-10">
        <div className="min-w-0 space-y-14 lg:col-span-8">
          {run.status === "FAILED" && run.error ? (
            <div className="rounded-xl bg-danger-soft p-6">
              <p className="text-title-3 text-danger">{worker.name} couldn’t finish this run</p>
              <p className="mt-1.5 text-[15px] text-pretty text-foreground/80">{run.error}</p>
            </div>
          ) : null}

          <section id="timeline" className={ANCHOR}>
          <Section title="What happened" description={`${worker.name}’s work, step by step.`}>
            <Card>
              <CardContent className="space-y-6">
                {detail.input.instructions.length > 0 ? (
                  <div className="rounded-lg bg-muted p-4">
                    <p className="text-footnote text-muted-foreground">Just for this run, you asked for:</p>
                    <ul className="mt-1.5 space-y-1 text-[15px] text-pretty">
                      {detail.input.instructions.map((text, i) => (
                        <li key={i}>“{text}”</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <RunTimeline
                  runId={run.id}
                  workerId={worker.id}
                  workerName={worker.name}
                  details={stepDetails}
                  canDecide={permissions["approvals.decide"]}
                />
              </CardContent>
            </Card>
          </Section>
          </section>

          <section id="deliverable" className={ANCHOR}>
          <Section
            title={detail.deliverables.length > 1 ? "Deliverables" : "Deliverable"}
            description={firstDeliverable ? "What came out of this run." : undefined}
          >
            {detail.deliverables.length === 0 ? (
              <Card>
                <EmptyState
                  title="Nothing handed in yet"
                  description={
                    run.status === "SUCCEEDED" || run.status === "FAILED" || run.status === "CANCELLED"
                      ? "This run didn’t produce a deliverable."
                      : `${worker.name} is still working on it.`
                  }
                  className="py-14"
                />
              </Card>
            ) : (
              <div className="grid gap-6">
                {detail.deliverables.map((d) => (
                  <Link
                    key={d.id}
                    href={`/deliverables/${d.id}`}
                    className="group/deliverable block rounded-xl outline-none"
                  >
                    <Card className="transition-[box-shadow,transform] duration-[280ms] ease-out group-hover/deliverable:-translate-y-0.5 group-hover/deliverable:shadow-card-hover">
                      <CardContent className="space-y-3">
                        <p className="text-title-3 text-pretty">{d.title}</p>
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-muted-foreground">
                          <StatusBadge kind="deliverable" status={d.status} />
                          <span aria-hidden="true">·</span>
                          <span>{d.format === "MARKDOWN" ? "Report" : d.format}</span>
                          {d.recordCount !== null ? (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{pluralize(d.recordCount, "record")}</span>
                            </>
                          ) : null}
                          <span aria-hidden="true">·</span>
                          <span>{formatDateTime(d.createdAt)}</span>
                        </p>
                        {d.summary ? <p className="line-clamp-3 text-[15px] text-pretty text-muted-foreground">{d.summary}</p> : null}
                        <span className="inline-flex items-center gap-1 text-footnote font-medium text-link">
                          Read it <ChevronRight className="size-3.5" aria-hidden="true" />
                        </span>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </Section>
          </section>

          <section id="evaluation" className={ANCHOR}>
          <Section
            title="How it measured up"
            description={
              detail.score !== null
                ? `Overall, this run scores ${formatNumber(detail.score, 0)} out of 100.`
                : "Automated checks, the reviewer’s read, and your own verdict."
            }
          >
            <EvaluationFindings
              evaluations={detail.evaluations}
              workerName={worker.name}
              score={detail.score}
              emptyDescription={
                run.status === "SUCCEEDED"
                  ? live.evaluationPending
                    ? "Checks are running now — this updates on its own."
                    : "No evaluation was recorded for this run."
                  : run.status === "FAILED" || run.status === "CANCELLED"
                    ? "The run didn’t finish, so there was nothing to evaluate."
                    : `Automated checks and the reviewer run as soon as ${worker.name} finishes.`
              }
            />
          </Section>
          </section>

        </div>

        <aside className="min-w-0 lg:col-span-4 lg:col-start-9 lg:row-span-2 lg:row-start-1">
          <Card className="lg:sticky lg:top-[124px]">
            <CardContent>
              <dl>
                <Fact label="Worker">
                  <Link href={`/workers/${worker.id}`} className="inline-flex items-center gap-2 text-link hover:underline">
                    <WorkerAvatar name={worker.name} color={worker.avatarColor} size="xs" />
                    {worker.name}
                  </Link>
                </Fact>
                <Fact label="Role">{worker.title}</Fact>
                <Fact label="Job">
                  <Link href={`/jobs/${job.id}`} className="text-link hover:underline">
                    {job.title}
                  </Link>
                </Fact>
                <Fact label="Version">
                  <Link href={`/workers/${worker.id}?tab=versions`} className="text-link hover:underline">
                    v{version.version}
                  </Link>
                </Fact>
                <Fact label="Queued">{formatDateTime(run.createdAt)}</Fact>
                <Fact label="Started">{run.startedAt ? formatDateTime(run.startedAt) : "—"}</Fact>
                <Fact label="Finished">{run.finishedAt ? formatDateTime(run.finishedAt) : "—"}</Fact>
                <Fact label="Model calls">
                  <span className="metric">{detail.usage.modelCalls}</span>
                </Fact>
                <Fact label="Tool calls">
                  <span className="metric">{detail.usage.toolCalls}</span>
                </Fact>
                <Fact label="Run id">
                  <span className="inline-flex items-center gap-1 font-mono text-caption">
                    {run.id.slice(0, 10)}…
                    <CopyButton value={run.id} />
                  </span>
                </Fact>
              </dl>
            </CardContent>
          </Card>
        </aside>

        <div id="debug" className={`${ANCHOR} min-w-0 lg:col-span-8 lg:col-start-1`}>
          <DebugTrace detail={detail} />
        </div>
      </div>

      <RunStickyActions
        runId={run.id}
        workerId={worker.id}
        workerName={worker.name}
        deliverable={firstDeliverable}
        canRun={permissions["workers.run"]}
      />
      {/* Room for the mobile action bar so the debug row is never trapped under it. */}
      <div className="h-16 sm:hidden" aria-hidden="true" />
    </RunLiveProvider>
  );
}
