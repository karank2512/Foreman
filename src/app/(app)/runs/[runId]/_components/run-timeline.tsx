"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { LiveDot } from "@/components/live-dot";
import { formatDuration, formatTokens } from "@/lib/format";
import { TONE_CLASSES } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { RunStepDetailView } from "@/server/queries/runs";
import type { RunLiveView } from "@/server/runtime/types";
import { ApprovalDecision } from "./approval-decision";
import { useRunLive } from "./run-live";
import { hasDetails, StepDetails } from "./step-details";
import { heldBackToolStepIds, STEP_STATUS_META } from "./step-meta";

/**
 * The step-by-step story of a run: a calm vertical sequence of human sentences, one small state dot each, with
 * the details a click away. Rows come from the live poll (status, title, timing); the expandable bodies come
 * from the server-rendered detail map and fill in on the refresh that follows the last poll.
 */

type LiveStep = RunLiveView["steps"][number];

export interface RunTimelineProps {
  runId: string;
  workerId: string;
  workerName: string;
  /** Server-rendered detail per step id (model/tool calls, approval, I/O). */
  details: Record<string, RunStepDetailView>;
  /** Whether this viewer's role may decide an approval request. */
  canDecide?: boolean;
}

/**
 * Wall-clock "now" that is null during SSR and hydration, then ticks every second — reading the clock
 * during render would make the server and client disagree on a live duration (hydration mismatch).
 */
function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function elapsed(step: LiveStep, now: number | null): string | null {
  if (step.durationMs !== null) return formatDuration(step.durationMs);
  if ((step.status === "RUNNING" || step.status === "WAITING") && now !== null) {
    const ms = now - new Date(step.startedAt).getTime();
    return ms > 0 ? formatDuration(ms) : null;
  }
  return null;
}

/** Tokens a step spent, when it called a model. */
function stepTokens(detail: RunStepDetailView | undefined): number {
  if (!detail) return 0;
  return detail.modelCalls.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0);
}

function StepDot({ status }: { status: LiveStep["status"] }) {
  const meta = STEP_STATUS_META[status];
  const tone = TONE_CLASSES[meta.tone];
  const faded = status === "PENDING" || status === "SKIPPED";
  return (
    <span className="relative z-10 mt-[7px] flex size-[9px] shrink-0 items-center justify-center" aria-hidden="true">
      <span className="absolute size-[17px] rounded-full bg-card" />
      {meta.pulse ? (
        <span className={cn("absolute size-[9px] rounded-full opacity-60 motion-safe:animate-ping", tone.dot)} />
      ) : null}
      <span className={cn("relative size-[9px] rounded-full", tone.dot, faded && "opacity-40")} />
    </span>
  );
}

interface StepRowProps {
  step: LiveStep;
  detail: RunStepDetailView | undefined;
  runId: string;
  runStatus: string;
  workerId: string;
  workerName: string;
  canDecide?: boolean;
  last: boolean;
}

function StepRow({ step, detail, runId, runStatus, workerId, workerName, canDecide, last }: StepRowProps) {
  const status = STEP_STATUS_META[step.status];
  const tone = TONE_CLASSES[status.tone];
  const needsDecision = step.kind === "APPROVAL" && step.status === "WAITING" && runStatus === "WAITING_FOR_APPROVAL";
  const expandable = hasDetails(detail);
  const [open, setOpen] = useState(needsDecision || step.kind === "ERROR" || step.status === "FAILED");
  const now = useNow(step.durationMs === null && (step.status === "RUNNING" || step.status === "WAITING"));
  const time = elapsed(step, now);
  const tokens = stepTokens(detail);
  const meta = [time, tokens > 0 ? `${formatTokens(tokens)} tokens` : null].filter(Boolean).join(" · ");

  // On a phone the duration/tokens drop under the sentence instead of squeezing it into a narrow column.
  const heading = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] text-pretty text-foreground">{step.title}</span>
        {step.detail ? <span className="mt-0.5 block text-footnote text-pretty text-muted-foreground">{step.detail}</span> : null}
        {step.error && !open ? <span className="mt-0.5 block line-clamp-2 text-footnote text-danger">{step.error}</span> : null}
        {step.status !== "SUCCEEDED" && step.status !== "PENDING" ? (
          <span className={cn("mt-0.5 block text-footnote", tone.text)}>{status.label}</span>
        ) : null}
        {meta ? <span className="metric mt-0.5 block text-footnote text-muted-foreground sm:hidden">{meta}</span> : null}
      </span>
      <span className="metric flex shrink-0 items-center gap-2 pt-0.5 text-footnote text-muted-foreground">
        {meta ? <span className="max-sm:hidden">{meta}</span> : null}
        {expandable ? (
          <ChevronDown
            className={cn("size-3.5 transition-transform duration-200 ease-standard", open && "rotate-180")}
            aria-hidden="true"
          />
        ) : null}
      </span>
    </>
  );

  return (
    <li className="relative flex gap-4">
      <StepDot status={step.status} />
      <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-6")}>
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-start gap-4 rounded-lg text-left outline-none"
          >
            {heading}
          </button>
        ) : (
          <div className="flex items-start gap-4">{heading}</div>
        )}

        {open && expandable ? (
          needsDecision ? (
            <div className="mt-4 rounded-xl bg-card p-5 shadow-card-hover">
              <p className="mb-4 text-footnote text-muted-foreground">{workerName} needs your go-ahead to carry on.</p>
              <StepDetails
                step={detail}
                runId={runId}
                runStatus={runStatus}
                workerId={workerId}
                workerName={workerName}
                canDecide={canDecide}
              />
            </div>
          ) : (
            <div className="mt-3.5 rounded-lg bg-muted p-4">
              <StepDetails
                step={detail}
                runId={runId}
                runStatus={runStatus}
                workerId={workerId}
                workerName={workerName}
                canDecide={canDecide}
              />
            </div>
          )
        ) : null}
      </div>
    </li>
  );
}

export function RunTimeline({ runId, workerId, workerName, details, canDecide }: RunTimelineProps) {
  const { live, polling, refresh } = useRunLive();
  const { run } = live;
  // One row per event: a send waiting on you shows as its approval, not also as a pending tool step.
  const held = heldBackToolStepIds(live.steps, details);
  const steps = held.size > 0 ? live.steps.filter((s) => !held.has(s.id)) : live.steps;

  // A WAITING approval that appeared during polling has no server detail yet (and so no Approve button):
  // fetch it once. Other details can wait for the refresh that follows the last poll.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const step of live.steps) {
      if (step.kind === "APPROVAL" && step.status === "WAITING" && !details[step.id] && !requested.current.has(step.id)) {
        requested.current.add(step.id);
        refresh();
        break;
      }
    }
  }, [live.steps, details, refresh]);

  if (steps.length === 0) {
    return (
      <p className="flex flex-wrap items-center gap-2 py-2 text-[15px] text-muted-foreground">
        {polling ? <LiveDot label={null} /> : null}
        {run.status === "QUEUED"
          ? `${workerName} is about to start — waiting for a free slot.`
          : run.status === "CANCELLED"
            ? "This run was cancelled before any work started."
            : "No steps were recorded for this run."}
      </p>
    );
  }

  const multiAttempt = steps.some((s) => s.attempt !== steps[0]?.attempt);
  let lastAttempt: number | null = null;

  // Requests the poller knows about but no WAITING step can show yet (detail not loaded, or a step without a
  // link to its approval): surface them below the timeline so a decision is always one click away.
  const shownApprovalIds = new Set(
    steps
      .filter((s) => s.kind === "APPROVAL" && s.status === "WAITING")
      .map((s) => details[s.id]?.approval?.id)
      .filter((id): id is string => !!id),
  );
  const orphanApprovals = run.status === "WAITING_FOR_APPROVAL" ? live.pendingApprovals.filter((a) => !shownApprovalIds.has(a.id)) : [];

  return (
    <div>
      {/* One hairline runs the length of the sequence; each dot punches a hole in it with a white ring. */}
      <ol className="relative before:absolute before:top-3 before:bottom-3 before:left-[4px] before:w-px before:bg-border">
        {steps.map((step, i) => {
          const divider = multiAttempt && step.attempt !== lastAttempt;
          lastAttempt = step.attempt;
          return (
            <Fragment key={step.id}>
              {divider ? (
                <li className="relative flex gap-4 pb-3">
                  <span className="z-10 mt-[3px] size-[9px] shrink-0 rounded-full bg-card" aria-hidden="true" />
                  <p className="eyebrow">Attempt {step.attempt}</p>
                </li>
              ) : null}
              <StepRow
                step={step}
                detail={details[step.id]}
                runId={runId}
                runStatus={run.status}
                workerId={workerId}
                workerName={workerName}
                canDecide={canDecide}
                last={i === steps.length - 1}
              />
            </Fragment>
          );
        })}
      </ol>

      {orphanApprovals.length > 0 ? (
        <div className="mt-6 space-y-4">
          {orphanApprovals.map((approval) => (
            <div key={approval.id} className="rounded-xl bg-card p-5 shadow-card-hover">
              <p className="mb-4 text-footnote text-muted-foreground">{workerName} needs your go-ahead to carry on.</p>
              <ApprovalDecision
                runId={runId}
                workerId={workerId}
                workerName={workerName}
                approval={approval}
                canDecide={canDecide}
              />
            </div>
          ))}
        </div>
      ) : null}

      {polling ? (
        <p className="mt-6 flex items-center gap-2 text-footnote text-muted-foreground">
          <LiveDot label={null} />
          {run.status === "WAITING_FOR_APPROVAL"
            ? `${workerName} is waiting for your decision.`
            : run.status === "QUEUED"
              ? `${workerName} will pick this up in a moment.`
              : live.evaluationPending
                ? "Checking the deliverable…"
                : "Updating as it happens."}
        </p>
      ) : null}
    </div>
  );
}
