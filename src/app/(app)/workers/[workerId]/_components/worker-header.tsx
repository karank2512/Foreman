import type { ReactNode } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { ScoreMetric } from "@/components/score-ring";
import { StatusBadge } from "@/components/status-badge";
import { WorkerAvatar } from "@/components/worker-avatar";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { WorkerHeaderView } from "@/server/queries/worker-profile";
import { attentionSentence } from "./labels";
import { Fact, Facts } from "./rows";
import { WorkerActions } from "./worker-actions";

/**
 * The profile header: one dominant name, one status, a calm score and a single primary action. Everything else
 * (facts, callouts) is demoted to a quiet 13px line so the eye lands on the person, not on chrome.
 */
export function WorkerHeader({
  worker,
  floatingMobileActions = true,
  queuedInstructions = 0,
  now = new Date(),
}: {
  worker: WorkerHeaderView;
  /** The chat tab owns the bottom of a phone screen, so its actions stay in the header instead. */
  floatingMobileActions?: boolean;
  /** One-off instructions from the chat that the next run will pick up (shown in the Run now dialog). */
  queuedInstructions?: number;
  /** Render time; a parameter so the "next run" wording can be tested without a clock. */
  now?: Date;
}) {
  const inFlight = worker.inFlightRun;
  const waiting = inFlight?.status === "WAITING_FOR_APPROVAL";

  return (
    <>
      <PageHeader
        className="mb-5"
        backHref="/workforce"
        backLabel="Workforce"
        title={
          <span className="flex min-w-0 items-center gap-4 sm:gap-5">
            <WorkerAvatar name={worker.name} color={worker.avatarColor} size="xl" className="max-sm:size-14" />
            <span className="text-headline min-w-0 truncate">{worker.name}</span>
          </span>
        }
        description={
          <>
            <span className="block truncate">{worker.title}</span>
            {/* Under `md` padding grows the 22px line to a 44px tap box (a `::before` band would be clipped by the
                truncation's overflow); the negative margins keep the text where it was, 4px under the title.
                `relative` lifts the box above the title's text, which would otherwise take the taps it overlaps. */}
            <Link
              href={`/jobs/${worker.job.id}`}
              className="relative mt-1 block w-fit max-w-full truncate text-[15px] text-link hover:underline max-md:-mt-[7px] max-md:-mb-[11px] max-md:py-[11px]"
            >
              Hired for {worker.job.title} ›
            </Link>
          </>
        }
        actions={
          <div className="flex items-center gap-7 max-sm:mt-1">
            <ScoreMetric score={worker.score} />
            <WorkerActions
              workerId={worker.id}
              workerName={worker.name}
              status={worker.status}
              hasCurrentVersion={worker.currentVersion !== null}
              permissions={worker.permissions}
              floatOnMobile={floatingMobileActions}
              inFlightStatus={inFlight?.status ?? null}
              queuedInstructions={queuedInstructions}
            />
          </div>
        }
      />

      {/* One status for the worker, then the facts a manager glances at — all on one quiet line. The separator is
          drawn before each fact, so when the line wraps on a phone a dot never dangles at the end of a row. */}
      <Facts label={`${worker.name} at a glance`} className="mb-6 gap-x-2.5 gap-y-1.5">
        <Fact className="gap-x-2.5">
          {inFlight ? (
            <>
              <StatusBadge kind="run" status={inFlight.status} />
              {/* While a run waits on you, the callout below carries the one link to the request. */}
              {waiting ? null : (
                <Link href={`/runs/${inFlight.id}`} className="text-link hover:underline">
                  Watch live ›
                </Link>
              )}
            </>
          ) : (
            <StatusBadge kind="worker" status={worker.status} />
          )}
        </Fact>
        <Fact className="gap-x-2.5">
          <span title={formatDateTime(worker.hiredAt)}>Hired {formatDate(worker.hiredAt)}</span>
        </Fact>
        <Fact className="gap-x-2.5">{worker.schedule.description}</Fact>
        <Fact className="gap-x-2.5">{nextRunFact(worker, now)}</Fact>
        {worker.currentVersion ? (
          <Fact className="gap-x-2.5">
            <span className="metric">Version {worker.currentVersion.version}</span>
          </Fact>
        ) : null}
      </Facts>

      <div className="mb-8 space-y-3 empty:mb-0">
        {headerCallouts(worker).map((c) => (
          <Callout key={c.href} {...c} />
        ))}
      </div>
    </>
  );
}

/**
 * "Next run in 2 days" — or, when the scheduled time has already passed, why it has not happened: the scheduler
 * never starts a second run while one is still in flight, so a past time is not a date to print as "5 days ago".
 */
export function nextRunFact(worker: WorkerHeaderView, now: Date): ReactNode {
  if (worker.status === "RETIRED") return `Retired ${formatDate(worker.retiredAt)}`;
  if (worker.status === "PAUSED") return "Paused — no runs scheduled";
  const next = worker.schedule.nextRunAt;
  if (!next) return "Runs when you ask";
  if (Date.parse(next) > now.getTime()) {
    // One inline span: the fact is a flex item, so bare text and the time would be spaced as two items.
    return (
      <span>
        Next run <RelativeTime iso={next} />
      </span>
    );
  }
  if (worker.inFlightRun?.status === "WAITING_FOR_APPROVAL") return "Next run once you approve this one";
  if (worker.inFlightRun) return "Next run after this one";
  return "Next run due now";
}

interface CalloutSpec {
  tone: "warning" | "neutral";
  text: string;
  href: string;
  linkLabel: string;
}

/**
 * At most one warning panel. Approval beats health; when health dips while a replacement is already drafted,
 * both facts share one panel whose link is the decision itself.
 */
export function headerCallouts(worker: WorkerHeaderView): CalloutSpec[] {
  const out: CalloutSpec[] = [];
  const proposal = worker.openProposal;
  const proposalText = proposal
    ? proposal.changeReason === "REPLACEMENT"
      ? `A replacement for ${worker.name} is drafted as version ${proposal.version}, and is not live until you decide.`
      : `A change to how ${worker.name} works is drafted as version ${proposal.version}, and is not live until you decide.`
    : null;
  const compare = proposal ? `/workers/${worker.id}/replace/${proposal.versionId}` : null;
  let proposalShown = false;

  if (worker.inFlightRun?.status === "WAITING_FOR_APPROVAL") {
    out.push({
      tone: "warning",
      text: `${worker.name} is waiting on your go-ahead${
        worker.pendingApprovals > 1 ? ` for ${worker.pendingApprovals} actions` : ""
      } before this run can continue.`,
      href: "/approvals",
      linkLabel: "Review the request",
    });
  } else if (worker.health === "NEEDS_ATTENTION" && worker.healthReason) {
    const attention = attentionSentence(worker.name, worker.healthReason);
    if (proposalText && compare) {
      out.push({ tone: "warning", text: `${attention} ${proposalText}`, href: compare, linkLabel: "Compare and decide" });
      proposalShown = true;
    } else {
      out.push({ tone: "warning", text: attention, href: `/workers/${worker.id}?tab=performance`, linkLabel: "See performance" });
    }
  }

  if (proposalText && compare && !proposalShown) {
    out.push({ tone: "neutral", text: proposalText, href: compare, linkLabel: "Compare and decide" });
  }
  return out;
}

/** The one soft-tinted panel on the page — used only when something is actually waiting on a person. */
function Callout({ tone, text, href, linkLabel }: CalloutSpec) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[14px] px-4 py-3.5 text-[15px] text-pretty text-foreground sm:flex-row sm:items-center sm:gap-6",
        // The neutral note sits on the gray canvas, so it is a white card rather than a gray fill that vanishes.
        tone === "warning" ? "bg-warning-soft" : "bg-card shadow-card",
      )}
    >
      <p className="min-w-0 flex-1">{text}</p>
      <Link
        href={href}
        className="relative shrink-0 text-[15px] font-medium text-link hover:underline max-md:before:absolute max-md:before:inset-x-0 max-md:before:top-[calc(50%_-_22px)] max-md:before:h-11"
      >
        {linkLabel} ›
      </Link>
    </div>
  );
}
