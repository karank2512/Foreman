import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { SimulatedBadge } from "@/components/simulated-badge";
import { WorkerAvatar } from "@/components/worker-avatar";
import { formatDate, formatDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { getReplacePageData, type ReplacePageView } from "@/server/queries/worker-manage";
import { ChangeList } from "./_components/change-list";
import { FailureAnalysis } from "./_components/failure-analysis";
import { ReplaceDecision } from "./_components/replace-decision";
import { impactDescription, replaceCrumb, replacePageTitle, targetNoun } from "./_components/replace-labels";
import { EstimatedDeltas, VersionCompare } from "./_components/version-compare";

interface PageProps {
  params: Promise<{ workerId: string; versionId: string }>;
}

/** generateMetadata and the page share one load per request. */
const loadPage = cache(async (workerId: string, versionId: string): Promise<ReplacePageView | null> => {
  const s = await requireSession();
  try {
    return await getReplacePageData(s.organizationId, workerId, versionId, { role: s.role });
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") return null;
    throw e;
  }
});

/** Depends on the decision too: after the hire the same URL shows the adopted version, not a proposal. */
function pageTitle(data: ReplacePageView): string {
  return replacePageTitle({
    workerName: data.worker.name,
    changeReason: data.changeReason,
    status: data.target.status,
    version: data.target.version,
  });
}

/** The heading asks the question the page exists to answer, while it is still open. */
function heading(data: ReplacePageView): string {
  if (data.target.status !== "PROPOSED") return pageTitle(data);
  if (data.changeReason === "REPLACEMENT") return `Replace ${data.worker.name} with version ${data.target.version}?`;
  if (data.changeReason === "SPEC_CHANGE") return `Change how ${data.worker.name} works?`;
  return pageTitle(data);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { workerId, versionId } = await params;
  const data = await loadPage(workerId, versionId);
  return { title: data ? pageTitle(data) : "Proposed version" };
}

export default async function ReplacePage({ params }: PageProps) {
  const { workerId, versionId } = await params;
  const data = await loadPage(workerId, versionId);
  if (!data) notFound();

  const { worker, target, base } = data;
  const labelInput = { changeReason: data.changeReason, status: target.status, version: target.version };
  const targetSide = targetNoun(labelInput);
  const baseLabel = base ? (base.status === "ACTIVE" ? "the current version" : `version ${base.version}`) : "nothing";
  const open = target.status === "PROPOSED";

  return (
    <>
      <PageHeader
        className="mb-8"
        backHref={`/workers/${worker.id}?tab=versions`}
        backLabel={worker.name}
        title={
          <span className="flex min-w-0 items-center gap-4">
            <WorkerAvatar name={worker.name} color={worker.avatarColor} size="lg" />
            <span className="min-w-0">{heading(data)}</span>
          </span>
        }
        description={
          open ? (
            data.changeReason === "REPLACEMENT" ? (
              <>Here&apos;s what changes. {worker.name}&apos;s history stays with the old version, whatever you decide.</>
            ) : (
              <>Here&apos;s what changes. Same name, same history — only the design is different.</>
            )
          ) : target.changeSummary ? (
            target.changeSummary.split("\n")[0]
          ) : (
            `${replaceCrumb(labelInput)} · compared with ${baseLabel}.`
          )
        }
      />

      {!open ? <OutcomeLine data={data} /> : null}

      <div className="space-y-14 pb-24">
        {data.deltas ? (
          <Section title="What it should change" description={impactDescription(data.deltas.source, target.status)}>
            <EstimatedDeltas deltas={data.deltas} base={base} target={target} />
          </Section>
        ) : null}

        {data.analysis ? <FailureAnalysis analysis={data.analysis} workerName={worker.name} /> : null}

        <Section
          title="Side by side"
          description={
            base
              ? `${baseLabel[0].toUpperCase()}${baseLabel.slice(1)} on the left, ${targetSide} on the right. Only the rows that differ are marked.`
              : "The design as proposed."
          }
        >
          <VersionCompare base={base} target={target} changeReason={data.changeReason} />
        </Section>

        {base ? (
          <Section
            title={open ? "Every difference" : "What changed"}
            description={`The full diff between ${baseLabel} and version ${target.version}, in plain terms.`}
          >
            <ChangeList
              entries={data.diff}
              baseLabel={baseLabel}
              targetLabel={`Version ${target.version}`}
              toolNames={Object.fromEntries([...base.tools, ...target.tools].map((t) => [t.toolName, t.displayName]))}
            />
          </Section>
        ) : null}

        {/* The version's story in one line; its id is for the Debug tab, not for the person deciding. */}
        <p className="text-footnote flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <span title={formatDateTime(target.createdAt)}>
            Version {target.version}, drafted {formatDate(target.createdAt)}
          </span>
          {target.activatedAt ? <span title={formatDateTime(target.activatedAt)}>· hired {formatDate(target.activatedAt)}</span> : null}
          {target.retiredAt ? <span title={formatDateTime(target.retiredAt)}>· retired {formatDate(target.retiredAt)}</span> : null}
          {data.simulated ? <SimulatedBadge /> : null}
        </p>
      </div>

      <ReplaceDecision
        workerId={worker.id}
        workerName={worker.name}
        versionId={target.id}
        version={target.version}
        changeReason={data.changeReason}
        status={target.status}
        canDecide={data.canDecide}
        mayHire={data.permissions["workers.hire"]}
        mayManage={data.permissions["workers.manage"]}
        workerStatus={worker.status}
      />
    </>
  );
}

/** Decided already: one quiet sentence instead of a banner. */
function OutcomeLine({ data }: { data: ReplacePageView }) {
  const status = data.target.status;
  return (
    <p className="mb-10 max-w-[70ch] text-[15px] text-pretty text-muted-foreground" role="status">
      {status === "ACTIVE" ? (
        <>
          <span className="font-medium text-foreground">This version is live.</span> {data.worker.name} has worked this
          way since {formatDateTime(data.target.activatedAt)}.
        </>
      ) : status === "REPLACED" ? (
        <>
          <span className="font-medium text-foreground">This version has since been replaced.</span> It was live from{" "}
          {formatDateTime(data.target.activatedAt)} to {formatDateTime(data.target.retiredAt)}.
        </>
      ) : (
        <>
          <span className="font-medium text-foreground">This proposal was declined.</span> {data.worker.name} kept
          working as before.{" "}
          <Link href={`/workers/${data.worker.id}?tab=versions`} className="text-link hover:underline">
            All versions ›
          </Link>
        </>
      )}
    </p>
  );
}
