"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { RunStatus, WorkerStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { WorkerPermissions } from "@/server/queries/permissions";
import { pauseWorkerAction, resumeWorkerAction, retireWorkerAction, runNowAction } from "../actions";
import { useGenerateReview } from "./generate-review";

export interface WorkerActionsProps {
  workerId: string;
  workerName: string;
  status: WorkerStatus;
  /** False when the worker has no current version (nothing to run). */
  hasCurrentVersion: boolean;
  /** What the viewer's role may do. The server enforces the same rules regardless. */
  permissions: WorkerPermissions;
  /**
   * On a narrow screen the cluster becomes a sticky bottom bar. The chat tab turns this off — its composer
   * already owns the bottom of the screen.
   */
  floatOnMobile?: boolean;
  /** The run already under way, if any — "Run now" then reads "Run again" and the dialog says so. */
  inFlightStatus?: RunStatus | null;
  /** One-off instructions from the chat that the next run (this one) will pick up. */
  queuedInstructions?: number;
}

/** Where the run already under way stands, in the dialog's words. */
const IN_FLIGHT_PHRASE: Partial<Record<RunStatus, string>> = {
  QUEUED: "has a run queued",
  RUNNING: "is in the middle of a run",
  WAITING_FOR_APPROVAL: "has a run waiting on your approval",
};

/**
 * One primary pill ("Run now") and a "…" menu for everything else — pause, replace, performance review, retire.
 * On a narrow screen the cluster becomes the sticky bottom action bar instead of crowding the header.
 */
export function WorkerActions({
  workerId,
  workerName,
  status,
  hasCurrentVersion,
  permissions,
  floatOnMobile = true,
  inFlightStatus = null,
  queuedInstructions = 0,
}: WorkerActionsProps) {
  const router = useRouter();
  const [runOpen, setRunOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [running, startRun] = useTransition();
  const [toggling, startToggle] = useTransition();
  const { reviewing, generate: review } = useGenerateReview(workerId, workerName);

  const retired = status === "RETIRED";
  const paused = status === "PAUSED";
  const mayRun = permissions["workers.run"];
  const mayManage = permissions["workers.manage"];
  const mayReview = permissions["reviews.generate"];
  const canRun = mayRun && status === "ACTIVE" && hasCurrentVersion;

  const runDisabledReason = !mayRun
    ? "Your role can't start runs. Ask a workspace admin."
    : retired
      ? `${workerName} has been retired.`
      : paused
        ? `Resume ${workerName} to start a run.`
        : !hasCurrentVersion
          ? `${workerName} has no active version yet.`
          : null;

  const menuItems = (mayReview ? 1 : 0) + (mayManage ? 1 : 0);

  function runNow() {
    startRun(async () => {
      const r = await runNowAction(workerId, { instructions });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setRunOpen(false);
      setInstructions("");
      toast.success(`${workerName} is on it`, {
        description: instructions.trim() || queuedInstructions > 0
          ? "Your one-off instructions will be applied to this run."
          : "The run has been queued and will start shortly.",
        action: { label: "Watch live", onClick: () => router.push(`/runs/${r.data.runId}`) },
      });
      router.refresh();
    });
  }

  function togglePause() {
    startToggle(async () => {
      const r = paused ? await resumeWorkerAction(workerId) : await pauseWorkerAction(workerId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(paused ? `${workerName} is back at work` : `${workerName} is paused`, {
        description: paused ? "Scheduled runs will resume." : "Queued runs were cancelled. Resume any time.",
      });
      router.refresh();
    });
  }

  const runButton = (
    <Button
      disabled={!canRun || running}
      onClick={canRun ? () => setRunOpen(true) : undefined}
      className="max-sm:h-11 max-sm:flex-1 max-sm:text-[15px]"
    >
      {running ? "Starting…" : inFlightStatus ? "Run again" : "Run now"}
    </Button>
  );

  return (
    <div
      className={cn(
        "flex items-center gap-2.5",
        // Desktop: beside the score. Mobile: the sticky bottom bar the design asks for instead of header buttons.
        floatOnMobile &&
          "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-30 max-sm:gap-3 max-sm:px-4 max-sm:py-3 max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] max-sm:shadow-bar max-sm:material-thick",
      )}
    >
      <Dialog open={runOpen} onOpenChange={(next) => (running ? undefined : setRunOpen(next))}>
        {runDisabledReason ? (
          <Tooltip>
            {/* A disabled button swallows pointer events, so the tooltip listens on a wrapper. */}
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-flex max-sm:flex-1">
                {runButton}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{runDisabledReason}</TooltipContent>
          </Tooltip>
        ) : (
          <DialogTrigger asChild>{runButton}</DialogTrigger>
        )}
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{inFlightStatus ? `Ask ${workerName} to run again` : `Ask ${workerName} to run now`}</DialogTitle>
            <DialogDescription>
              {inFlightStatus
                ? `${workerName} ${IN_FLIGHT_PHRASE[inFlightStatus] ?? "already has a run under way"}. This adds another run on top of it.`
                : `${workerName} will start a fresh run right away, on top of the regular schedule.`}{" "}
              Add one-off instructions if this run should be different.
            </DialogDescription>
          </DialogHeader>
          {queuedInstructions > 0 ? (
            <p className="text-callout rounded-[12px] bg-muted px-4 py-3 text-pretty">
              {queuedInstructions === 1
                ? "1 one-off instruction from your chat is already queued, so this run picks it up too."
                : `${queuedInstructions} one-off instructions from your chat are already queued, so this run picks them up too.`}{" "}
              <Link href={`/workers/${workerId}?tab=chat`} className="text-link hover:underline">
                See the chat ›
              </Link>
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="run-now-instructions">One-off instructions (optional)</Label>
            <Textarea
              id="run-now-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Focus on seed-stage rounds only, and keep it to the top 5."
              rows={4}
              maxLength={4_000}
              disabled={running}
            />
            <p className="text-footnote text-muted-foreground">
              One instruction per line. They apply to this run only — to change how {workerName} works for good,
              use{" "}
              <Link href={`/workers/${workerId}?tab=chat`} className="text-link hover:underline">
                Talk to {workerName}
              </Link>
              .
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={running} onClick={() => setRunOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={running} onClick={runNow}>
              {running ? "Starting…" : "Start run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {menuItems > 0 ? (
        /* Non-modal so a menu item can open the Retire dialog without Radix leaving the page unclickable. */
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="icon-lg"
              aria-label={`More actions for ${workerName}`}
              className="max-sm:size-11"
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {mayReview ? (
              <DropdownMenuItem disabled={reviewing || !hasCurrentVersion} onSelect={review}>
                {reviewing ? "Writing review…" : "Performance review"}
              </DropdownMenuItem>
            ) : null}
            {mayManage ? (
              <>
                {!retired ? (
                  <DropdownMenuItem disabled={toggling} onSelect={togglePause}>
                    {toggling ? "Saving…" : paused ? "Resume" : "Pause"}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <Link href={`/workers/${workerId}?tab=versions`}>Replace {workerName}…</Link>
                </DropdownMenuItem>
                {!retired ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setRetireOpen(true)}>
                      Retire…
                    </DropdownMenuItem>
                  </>
                ) : null}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {mayManage && !retired ? (
        <RetireDialog
          open={retireOpen}
          onOpenChange={setRetireOpen}
          workerName={workerName}
          onConfirm={async () => {
            const r = await retireWorkerAction(workerId);
            if (!r.ok) throw new Error(r.error);
            toast.success(`${workerName} has been retired`, {
              description: "Thanks for the work. The job is open for a new hire.",
            });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Controlled twin of ConfirmDialog (which owns its trigger and so cannot be opened from a menu item). While the
 * retirement is in flight the dialog cannot be dismissed — the outcome must land.
 */
function RetireDialog({
  open,
  onOpenChange,
  workerName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workerName: string;
  onConfirm: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Retire {workerName}?</DialogTitle>
          <DialogDescription>
            Queued runs and pending approvals are cancelled and the schedule stops. {workerName}&apos;s history,
            deliverables and reviews are kept, and the job can be re-staffed later.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={confirm}
            className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/30"
          >
            {pending ? "Retiring…" : "Retire worker"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
