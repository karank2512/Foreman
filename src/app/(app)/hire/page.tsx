import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/server/auth";
import { can } from "@/server/auth/permissions";
import { isAppError } from "@/server/errors";
import { getHireView, listOpenHireJobs, type HireView } from "@/server/queries/hire";
import { ClarifyForm } from "./_components/clarify-form";
import { DescribeForm } from "./_components/describe-form";
import { HireProgress } from "./_components/hire-progress";
import { ProposalActions } from "./_components/proposal-actions";
import { ProposalPending } from "./_components/proposal-pending";
import { ProposalDetails } from "./_components/proposal-details";
import { ProposalPipeline, ProposalResume } from "./_components/proposal-profile";
import { ProposalCost, ProposalKpis } from "./_components/proposal-terms";
import { ResumeList } from "./_components/resume-list";
import { SpecDocument } from "./_components/spec-document";
import { exampleJobById, stepKeyFor } from "./schema";

export const metadata: Metadata = { title: "Hire a worker" };

/** The whole flow lives in one 720px reading column — no side rails, no second thing to look at. */
function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[720px]">{children}</div>;
}

/**
 * The same "‹ Hire" link PageHeader draws, for the two steps that own their own heading (the résumé's `<h1>`
 * is the worker's name, so it can't come from PageHeader).
 */
function BackToHire() {
  return (
    <Link href="/hire" className="mb-5 block w-fit rounded-sm text-callout text-link outline-none hover:underline">
      ‹ Hire
    </Link>
  );
}

/**
 * /hire and /hire?jobId=… — the headline flow. The step is always derived on the server from
 * `staffing.getHireFlowState`; the client only ever submits an action and refreshes.
 */
export default async function HirePage({
  searchParams,
}: {
  searchParams: Promise<{ jobId?: string | string[]; prefill?: string | string[] }>;
}) {
  const s = await requireSession();
  const { jobId: rawJobId, prefill: rawPrefill } = await searchParams;
  const jobId = Array.isArray(rawJobId) ? rawJobId[0] : rawJobId;

  if (!jobId) {
    const prefillId = Array.isArray(rawPrefill) ? rawPrefill[0] : rawPrefill;
    const example = exampleJobById(prefillId);
    const canManage = can(s.role, "jobs.manage");
    const openJobs = await listOpenHireJobs(s.organizationId);

    return (
      <Column>
        <HireProgress current="describe" />
        <PageHeader
          title={<span className="block text-headline">What do you need done?</span>}
          description="Describe it like you would brief a new contractor: the outcome, how often, and who it is for."
        />
        {canManage ? (
          <DescribeForm initialText={example?.description ?? ""} />
        ) : (
          <NoAccess
            title="Only admins can open a new job"
            description="You can follow every worker, run and deliverable in the workspace — but scoping a job and hiring for it is an admin's call."
          />
        )}
        {openJobs.length > 0 ? (
          <div className="mt-14">
            <ResumeList jobs={openJobs} />
          </div>
        ) : null}
      </Column>
    );
  }

  let view: HireView;
  try {
    view = await getHireView(s.organizationId, jobId, { role: s.role });
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }

  // A staffed job has nothing left to hire — send them to the worker who holds it.
  if (view.kind === "staffed") {
    if (view.workerId) redirect(`/workers/${view.workerId}`);
    return <ClosedJob jobId={view.jobId} status={view.status} />;
  }

  const { state, toolMeta, familyLabel, permissions } = view;
  const canManage = permissions["jobs.manage"];
  const step = stepKeyFor(state.step);

  if (step === "clarify") {
    const questions = state.intake?.questions ?? [];
    return (
      <Column>
        <HireProgress current="clarify" />
        <PageHeader
          title={<span className="block text-headline">{questions.length > 0 ? "A few quick questions" : "Ready for a spec"}</span>}
          description={
            questions.length > 0
              ? "They shape the job spec. Skip anything you are unsure about — sensible defaults apply."
              : "Nothing else to ask. Draft the spec and check it over."
          }
          backHref="/hire"
          backLabel="Hire"
        />
        <div className="mb-8 space-y-1.5">
          <p className="text-footnote text-muted-foreground">Your brief · {familyLabel}</p>
          <p className="text-callout whitespace-pre-line text-pretty text-muted-foreground">{state.job.description}</p>
        </div>
        <ClarifyForm
          jobId={state.job.id}
          jobTitle={state.job.title}
          questions={questions}
          initialAnswers={state.intake?.answers ?? {}}
          canManage={canManage}
        />
      </Column>
    );
  }

  if (step === "spec" && state.spec && state.jobSpecId) {
    return (
      <Column>
        <HireProgress current="spec" />
        <SpecDocument
          jobId={state.job.id}
          jobSpecId={state.jobSpecId}
          spec={state.spec}
          toolMeta={toolMeta}
          showTargetCount={state.spec.deliverable.fields.length > 0 || state.spec.deliverable.targetCount !== undefined}
          canManage={canManage}
        />
      </Column>
    );
  }

  if (step === "proposal" && state.spec) {
    if (!state.proposal) {
      return (
        <Column>
          <HireProgress current="proposal" />
          <BackToHire />
          <ProposalPending jobId={state.job.id} specTitle={state.spec.title} canManage={canManage} />
        </Column>
      );
    }

    const { proposal } = state;
    return (
      <Column>
        <HireProgress current="proposal" />
        <BackToHire />
        <ProposalResume proposal={proposal} toolMeta={toolMeta} />
        {/* The facts that decide a hire stay open; the reasoning and the review method fold away at the end. */}
        <div className="mt-14 space-y-14">
          <Section title="How the work flows" description="Every run walks these steps in order.">
            <ProposalPipeline proposal={proposal} jobTitle={state.spec.title} />
          </Section>
          <Section title="What they are measured on">
            <ProposalKpis proposal={proposal} />
          </Section>
          <Section title="Cost and schedule">
            <ProposalCost proposal={proposal} />
          </Section>
          <ProposalDetails proposal={proposal} specTitle={state.spec.title} />
        </div>
        <ProposalActions
          jobId={state.job.id}
          proposedName={proposal.blueprint.persona.name}
          simulated={proposal.simulated}
          canHire={permissions["workers.hire"]}
          canManage={canManage}
        />
      </Column>
    );
  }

  // Defensive: the flow state is always one of the three steps above, but never render a blank page.
  return (
    <Column>
      <HireProgress current={step} />
      <NoAccess title="This job is between steps" description="Refresh in a moment, or start again from your list of open jobs." />
    </Column>
  );
}

function NoAccess({ title, description }: { title: string; description: string }) {
  return (
    <EmptyState
      title={title}
      description={description}
      action={
        <Button variant="secondary" size="lg" asChild>
          <Link href="/workforce">Go to Workforce</Link>
        </Button>
      }
    />
  );
}

function ClosedJob({ jobId, status }: { jobId: string; status: string }) {
  const paused = status === "PAUSED";
  return (
    <Column>
      <PageHeader title="Hire a worker" description="This job is not open for hiring." backHref="/jobs" backLabel="Jobs" />
      <EmptyState
        title={paused ? "This job is paused" : "This job is closed"}
        description={
          paused
            ? "Its worker is paused rather than gone. Resume them from the Workforce page, or open the job for details."
            : "Its worker has been retired and the job was closed. Describe a new job to hire again, or open the job for its history."
        }
        action={
          <>
            <Button size="lg" asChild>
              <Link href="/hire">Describe a new job</Link>
            </Button>
            <Button variant="secondary" size="lg" asChild>
              <Link href={`/jobs/${jobId}`}>Open job</Link>
            </Button>
          </>
        }
      />
    </Column>
  );
}
