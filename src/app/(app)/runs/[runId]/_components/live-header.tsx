"use client";

import { SimulatedBadge } from "@/components/simulated-badge";
import { StatusBadge } from "@/components/status-badge";
import { formatDuration, formatTokens, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isTerminal, type RunLiveView } from "@/server/runtime/types";
import { useRunLive } from "./run-live";

/**
 * The live parts of the run header: one status, then quiet facts. Everything here is driven by the poller in
 * `run-live.tsx`, so the numbers tick up while the run is in flight without the page moving.
 */

/**
 * Active time to show — the executor's total of time spent working, never wall-clock since queueing. Only a run
 * that is working right now counts up ("so far"); one paused on you or back in the queue reports the work done,
 * so a run queued hours ago doesn't read as "49.5 s so far". Null when there is nothing worth saying.
 */
export function activeTime(run: Pick<RunLiveView["run"], "status" | "durationMs">): string | null {
  if (run.durationMs === null) return run.status === "RUNNING" ? "just started" : null;
  if (isTerminal(run.status)) return formatDuration(run.durationMs);
  if (run.status === "RUNNING") return `${formatDuration(run.durationMs)} so far`;
  return `${formatDuration(run.durationMs)} of work`;
}

export function RunMetaLine({ className }: { className?: string }) {
  const { live } = useRunLive();
  const { run } = live;
  const tokens = run.inputTokens + run.outputTokens;
  const time = activeTime(run);

  return (
    <span className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-footnote text-muted-foreground", className)}>
      <StatusBadge kind="run" status={run.status} />
      {time ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="metric">{time}</span>
        </>
      ) : null}
      <span aria-hidden="true">·</span>
      <span className="metric">{formatUsd(run.costUsd)}</span>
      {tokens > 0 ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="metric">{formatTokens(tokens)} tokens</span>
        </>
      ) : null}
      {run.attempt > 1 ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="metric">
            attempt {run.attempt} of {run.maxAttempts}
          </span>
        </>
      ) : null}
      {run.simulated ? <SimulatedBadge /> : null}
    </span>
  );
}

/** What the worker is doing right now, as one sentence — only while the run hasn't finished. */
export function RunProgressLine({ workerName }: { workerName: string }) {
  const { live } = useRunLive();
  const { run, steps } = live;
  if (isTerminal(run.status) && !live.evaluationPending) return null;

  const done = steps.filter((s) => s.status === "SUCCEEDED" || s.status === "SKIPPED" || s.status === "FAILED").length;
  const current = steps.find((s) => s.status === "RUNNING" || s.status === "WAITING");

  const sentence =
    run.status === "QUEUED"
      ? `${workerName} is waiting for a free slot.`
      : run.status === "WAITING_FOR_APPROVAL"
        ? `${workerName} is waiting for your decision.`
        : live.evaluationPending
          ? "Checking the deliverable against the job’s criteria."
          : current
            ? `Working — step ${done + 1} of about ${Math.max(steps.length + 1, done + 2)}.`
            : `${workerName} is getting started.`;

  return <span className="block text-footnote text-muted-foreground">{sentence}</span>;
}

/**
 * A 2px accent rail pinned under the global nav while the run is moving. It advances on real progress (steps
 * closed out of the steps seen so far), never on a timer, and disappears the moment the run is done.
 */
export function RunProgressRail() {
  const { live } = useRunLive();
  const { run, steps } = live;
  const active = !isTerminal(run.status);
  if (!active) return null;

  const done = steps.filter((s) => s.status === "SUCCEEDED" || s.status === "SKIPPED").length;
  const estimate = Math.max(steps.length + 1, 4);
  const pct = run.status === "QUEUED" ? 4 : Math.min(92, Math.round((done / estimate) * 100) + 6);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-(--nav-height) z-40 h-0.5" aria-hidden="true">
      <div
        className="h-full max-w-full bg-primary transition-[width] duration-[400ms] ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
