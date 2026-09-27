import type { ReactNode } from "react";
import type { RunStatus } from "@prisma/client";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { ScoreRing } from "@/components/score-ring";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { WorkerAvatar } from "@/components/worker-avatar";
import { formatUsd, pluralize } from "@/lib/format";
import type { WorkerCardView } from "@/server/queries/workforce";
import { RunNowButton } from "./run-now-button";

/** What the last finished run did, in one word — read as a sentence with the time ("Delivered 4 hours ago"). */
const LAST_RUN_VERB: Record<RunStatus, string> = {
  SUCCEEDED: "Delivered",
  FAILED: "Run failed",
  CANCELLED: "Cancelled",
  QUEUED: "Queued",
  RUNNING: "Running",
  WAITING_FOR_APPROVAL: "Paused",
};

function runNowBlocker(worker: WorkerCardView, canRun: boolean): string | undefined {
  if (!canRun) return "Your role can't start runs.";
  if (worker.status === "PAUSED") return `${worker.name} is paused — resume from the profile to run again.`;
  if (worker.status === "RETIRED") return `${worker.name} has been retired.`;
  if (worker.activeRun) return `${worker.name} already has a run going.`;
  return undefined;
}

/** Label over value, no icon, no inset box — the label is quiet and the value carries the weight. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-footnote text-muted-foreground">{label}</p>
      <p className="text-body-app mt-0.5 break-words text-pretty text-foreground tabular-nums">{children}</p>
    </div>
  );
}

/** The one state that matters right now: working → needs attention → paused → on the job. */
function StatusLine({ worker }: { worker: WorkerCardView }) {
  if (worker.activeRun) {
    return (
      <Link
        href={`/runs/${worker.activeRun.id}`}
        className="w-fit rounded-sm outline-none"
        title="Open the run"
      >
        <StatusBadge kind="run" status={worker.activeRun.status} emphasis="dot" />
      </Link>
    );
  }
  if (worker.health === "NEEDS_ATTENTION") {
    // One line that never wraps: the reason clips with an ellipsis (full text on hover) rather than breaking
    // onto a second line that would start with the separator.
    return (
      <p className="flex min-w-0 items-center gap-x-1.5 text-footnote text-warning">
        <StatusBadge kind="health" status="NEEDS_ATTENTION" emphasis="dot" />
        {worker.healthReason ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate" title={worker.healthReason}>
              {worker.healthReason}
            </span>
          </>
        ) : null}
      </p>
    );
  }
  return <StatusBadge kind="worker" status={worker.status} emphasis="dot" />;
}

export interface WorkerCardProps {
  worker: WorkerCardView;
  /** The viewer's role may start runs. The server checks again. */
  canRun: boolean;
}

/** Roster entry: who they are, how they're doing, the four facts a manager checks, and the next two things to do. */
export function WorkerCard({ worker, canRun }: WorkerCardProps) {
  const profile = `/workers/${worker.id}`;
  const blocker = runNowBlocker(worker, canRun);
  // Server-rendered, so a plain clock comparison is fine; AutoRefresh re-renders the page while runs are in flight.
  const nextRunDue = worker.nextRunAt !== null && new Date(worker.nextRunAt).getTime() <= Date.now();

  return (
    <Card className="transition-shadow duration-[280ms] ease-out hover:shadow-card-hover">
      <CardHeader>
        <div className="flex items-start gap-4">
          <Link href={profile} className="shrink-0 rounded-full outline-none">
            <WorkerAvatar name={worker.name} color={worker.avatarColor} size="lg" />
          </Link>
          <div className="min-w-0 flex-1">
            <Link
              href={profile}
              title={`Hired for ${worker.jobTitle}`}
              className="text-title-3 block truncate text-foreground outline-none hover:text-link"
            >
              {worker.name}
            </Link>
            <p className="text-callout truncate text-muted-foreground">{worker.title}</p>
          </div>
          <ScoreRing score={worker.score} size={44} />
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <StatusLine worker={worker} />

        <div className="grid grid-cols-2 gap-x-5 gap-y-4">
          <Fact label="Last run">
            {worker.lastRun ? (
              <Link href={`/runs/${worker.lastRun.id}`} className="outline-none hover:text-link">
                {LAST_RUN_VERB[worker.lastRun.status]} <RelativeTime iso={worker.lastRun.at} />
              </Link>
            ) : worker.activeRun ? (
              <span className="text-muted-foreground">First run in progress</span>
            ) : (
              <span className="text-muted-foreground">Nothing yet</span>
            )}
          </Fact>

          <Fact label="Next run">
            {worker.nextRunAt === null ? (
              <span className="text-muted-foreground">{worker.status === "ACTIVE" ? worker.schedule : "Not scheduled"}</span>
            ) : nextRunDue ? (
              // The scheduler only queues a slot once the worker is free, so a past slot means "as soon as possible".
              <span title={worker.schedule} className="text-muted-foreground">
                {worker.activeRun ? "After this run" : "Due now"}
              </span>
            ) : (
              <span title={worker.schedule}>
                <RelativeTime iso={worker.nextRunAt} />
              </span>
            )}
          </Fact>

          <Fact label="Cost this month">{formatUsd(worker.costThisMonthUsd)}</Fact>

          <Fact label="Awaiting review">
            {worker.deliverablesAwaitingReview > 0 ? (
              <span className="text-warning">{pluralize(worker.deliverablesAwaitingReview, "deliverable")}</span>
            ) : (
              <span className="text-muted-foreground">
                {worker.deliverables === 0 ? "None yet" : "Nothing waiting"}
              </span>
            )}
          </Fact>
        </div>
      </CardContent>

      {/* Grid rows stretch every card to the tallest; pinning the footer keeps the pills level across the row. */}
      <CardFooter className="mt-auto justify-between gap-3">
        <RunNowButton workerId={worker.id} workerName={worker.name} disabledReason={blocker} />
        <Button variant="link" asChild>
          <Link href={profile}>
            View <ChevronRight data-icon="inline-end" />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
