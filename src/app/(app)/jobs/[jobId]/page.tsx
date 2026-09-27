import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { LocalNav } from "@/components/shell/local-nav";
import { Stat, StatStrip } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import { formatDate, formatUsd, pluralize } from "@/lib/format";
import { statusLabel } from "@/lib/status";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { getJobDetail, type JobDetailView } from "@/server/queries/jobs";
import { JobActions } from "./_components/job-actions";
import { JobActivity } from "./_components/job-activity";
import { JobDeliverables } from "./_components/job-deliverables";
import { isUnstaffed, openSeatLine, specDescription } from "./_components/job-layout";
import { JobRuns } from "./_components/job-runs";
import { JobWorkers } from "./_components/job-workers";
import { SpecVersions } from "./_components/spec-versions";
import { SpecView } from "./_components/spec-view";

type Params = { params: Promise<{ jobId: string }> };

/** Anchors sit below the global nav (48) + local nav (52), with air. */
const ANCHOR = "scroll-mt-[116px]";

/** generateMetadata and the page both need the detail view — one set of DB round trips per request. */
const load = cache(async (jobId: string): Promise<JobDetailView | null> => {
  const s = await requireSession();
  try {
    return await getJobDetail(s.organizationId, jobId, { role: s.role });
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") return null;
    throw e;
  }
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { jobId } = await params;
  const data = await load(jobId);
  return { title: data?.job.title ?? "Job" };
}

export default async function JobDetailPage({ params }: Params) {
  const { jobId } = await params;
  const data = await load(jobId);
  if (!data) notFound();
  const { job, currentWorker, stats } = data;
  const shownSpec = data.specVersions.find((v) => v.shown) ?? null;
  const unstaffed = isUnstaffed(data);

  const facts = [
    job.familyLabel,
    `opened ${formatDate(job.createdAt)}`,
    currentWorker ? `${currentWorker.name} is on it` : job.status === "SPEC_APPROVED" ? "seat open" : null,
  ].filter(Boolean);

  const specSection = (
    <section id="spec" className={ANCHOR}>
      <Section title="The job description" description={specDescription(data.spec !== null, shownSpec?.status === "APPROVED")}>
        {data.spec ? (
          <>
            <SpecView
              spec={data.spec}
              versionLabel={shownSpec ? `Version ${shownSpec.version} · ${statusLabel("spec", shownSpec.status)}` : undefined}
            />
            <div className="mt-6">
              <p className="text-footnote text-muted-foreground">You originally asked for:</p>
              <blockquote className="mt-1.5 border-l-[3px] border-input pl-5 text-[15px] text-pretty text-muted-foreground">
                {job.description}
              </blockquote>
            </div>
          </>
        ) : (
          // No button here: the header (and the phone's bottom bar) already carries "Continue setup".
          <Card>
            <EmptyState
              title="Not scoped yet"
              description={`“${job.description.length > 140 ? `${job.description.slice(0, 140)}…` : job.description}” — answer a few questions and we'll turn it into a job description.`}
              className="py-16"
            />
          </Card>
        )}
      </Section>
    </section>
  );

  return (
    <>
      <PageHeader
        backHref="/jobs"
        backLabel="Jobs"
        title={job.title}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-footnote text-muted-foreground">
            <StatusBadge kind="job" status={job.status} />
            <span aria-hidden="true">·</span>
            <span>{facts.join(" · ")}</span>
          </span>
        }
        actions={
          <JobActions
            jobId={job.id}
            title={job.title}
            status={job.status}
            can={data.can}
            permissions={data.permissions}
            currentWorker={currentWorker ? { id: currentWorker.id, name: currentWorker.name } : null}
          />
        }
      />

      {unstaffed ? (
        <div className="max-w-[820px] min-w-0 space-y-6">
          {specSection}
          <p className="text-[15px] text-pretty text-muted-foreground">{openSeatLine(job.status)}</p>
        </div>
      ) : (
        <>
          <LocalNav
            title={job.title}
            items={[
              { label: "Spec", href: "#spec", active: true },
              { label: "Workers", href: "#workers" },
              { label: "Runs", href: "#runs" },
              { label: "Deliverables", href: "#deliverables" },
              { label: "History", href: "#history" },
            ]}
          />

          <div className="mt-10 space-y-14">
            <StatStrip>
              <Stat
                label="Runs"
                value={stats.runs}
                hint={stats.runs > 0 ? `${stats.succeeded} completed · ${stats.failed} failed` : "None yet"}
              />
              <Stat
                label="Deliverables"
                value={stats.deliverables}
                hint={stats.deliverables > 0 ? `${stats.accepted} accepted` : "Nothing handed in yet"}
              />
              <Stat
                label="Workers"
                value={data.workers.length}
                hint={currentWorker ? `${currentWorker.name} holds the seat` : "Seat open"}
              />
              <Stat
                label="Spend"
                value={formatUsd(stats.totalCostUsd)}
                hint={stats.runs > 0 ? `across ${pluralize(stats.runs, "run")}` : "Nothing spent yet"}
              />
            </StatStrip>

            {/* Grid items default to min-width:auto, so the widest line in either column would set the width of
                the whole phone layout (and pan the page sideways); min-w-0 keeps both columns to the screen. */}
            <div className="grid gap-6 lg:grid-cols-12 lg:gap-10">
              <div className="min-w-0 space-y-14 lg:col-span-8">
                {specSection}

                <section id="runs" className={ANCHOR}>
                  <Section
                    title="Runs"
                    description={data.runs.length > 0 ? `The last ${pluralize(data.runs.length, "run")} on this job.` : undefined}
                  >
                    <JobRuns runs={data.runs} workerName={currentWorker?.name ?? null} />
                  </Section>
                </section>

                <section id="deliverables" className={ANCHOR}>
                  <Section
                    title="Deliverables"
                    description={
                      stats.deliverables > 0
                        ? `${pluralize(stats.deliverables, "deliverable")} so far · ${stats.accepted} accepted.`
                        : undefined
                    }
                  >
                    <JobDeliverables deliverables={data.deliverables} />
                  </Section>
                </section>

                <div id="history" className={ANCHOR}>
                  <SpecVersions versions={data.specVersions} />
                </div>
              </div>

              <aside className="min-w-0 space-y-6 lg:col-span-4">
                <div id="workers" className={ANCHOR}>
                  <JobWorkers workers={data.workers} currentWorkerId={currentWorker?.id ?? null} />
                </div>
                <JobActivity items={data.activity} workerId={currentWorker?.id ?? null} />
              </aside>
            </div>
          </div>
        </>
      )}

      <AutoRefresh active={data.hasRunsInFlight} />
      {/* Room for the mobile action bar. */}
      <div className="h-16 sm:hidden" aria-hidden="true" />
    </>
  );
}
