import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { JsonView } from "@/components/json-view";
import { formatDateTime, formatDuration, formatTokens, formatUsdPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DebugModelCall, DebugToolCall } from "@/server/queries/worker-manage";
import { TIER_LABELS } from "./versions-labels";

/**
 * Engineer-facing call lists for the Debug tab. Native `<details>` rows (no client state) with the raw
 * request/response or input/output as collapsible JSON underneath. Whether calls ran on the simulator is said
 * once per list by the section (see `simulatedNote`), not with a pill on every row.
 */

/** "Standard model"; the provider/model id is trace detail and sits in the expanded row. */
function tierName(tier: string): string {
  return tier in TIER_LABELS ? `${TIER_LABELS[tier as keyof typeof TIER_LABELS]} model` : tier;
}

/** One sentence for a whole list: "All 20 calls below ran on the simulator." */
export function simulatedNote(calls: ReadonlyArray<{ simulated: boolean }>): string | null {
  const simulated = calls.filter((c) => c.simulated).length;
  if (simulated === 0) return null;
  if (simulated === calls.length) return calls.length === 1 ? "It ran on the simulator." : `All ${calls.length} ran on the simulator.`;
  return `${simulated} of ${calls.length} ran on the simulator.`;
}

const SUMMARY =
  "flex cursor-pointer list-none items-center gap-3 px-5 py-3 transition-colors duration-200 hover:bg-muted sm:px-6 [&::-webkit-details-marker]:hidden";

const ROW = "relative [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:inset-x-5 [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:h-px [&:not(:first-child)]:before:bg-border sm:[&:not(:first-child)]:before:inset-x-6";

function Meta({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("text-footnote truncate text-muted-foreground", className)}>{children}</span>;
}

function RunLink({ runId }: { runId: string | null }) {
  if (!runId) return <Meta className="font-mono">no run</Meta>;
  return (
    <Link href={`/runs/${runId}`} className="text-footnote truncate font-mono text-link hover:underline">
      run {runId.slice(-8)}
    </Link>
  );
}

export function DebugModelCallList({ calls }: { calls: DebugModelCall[] }) {
  return (
    <ul role="list" className="flex flex-col">
      {calls.map((c) => (
        <li key={c.id} className={ROW}>
          <details className="group/call">
            <summary className={SUMMARY}>
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open/call:rotate-90"
                aria-hidden="true"
              />
              <div className="grid min-w-0 flex-1 grid-cols-2 items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_repeat(3,minmax(0,0.9fr))]">
                <span className="truncate text-callout font-medium">{c.purpose}</span>
                <Meta>{tierName(c.tier)}</Meta>
                <Meta className="metric">
                  {formatTokens(c.inputTokens)} in · {formatTokens(c.outputTokens)} out
                </Meta>
                <Meta className="metric">
                  {formatUsdPrecise(c.costUsd)} · {formatDuration(c.latencyMs)}
                </Meta>
                <span className="flex items-center gap-2">
                  {c.error ? <span className="text-footnote truncate text-danger">error</span> : null}
                </span>
              </div>
            </summary>
            <div className="space-y-3 bg-muted px-5 py-4 sm:px-6">
              <p className="text-footnote flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                <span className="font-mono">{c.id}</span>
                <span className="font-mono">
                  {c.provider}:{c.model}
                </span>
                <RunLink runId={c.runId} />
                <span>{formatDateTime(c.createdAt)}</span>
                {c.error ? <span className="text-danger">{c.error}</span> : null}
              </p>
              <JsonView label="Request" value={c.request} />
              <JsonView label="Response" value={c.response} />
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function DebugToolCallList({ calls }: { calls: DebugToolCall[] }) {
  return (
    <ul role="list" className="flex flex-col">
      {calls.map((t) => (
        <li key={t.id} className={ROW}>
          <details className="group/call">
            <summary className={SUMMARY}>
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open/call:rotate-90"
                aria-hidden="true"
              />
              <div className="grid min-w-0 flex-1 grid-cols-2 items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_repeat(2,minmax(0,0.9fr))_minmax(0,1fr)]">
                <span className="truncate font-mono text-callout font-medium">{t.toolName}</span>
                <Meta className={cn(t.status === "FAILED" || t.status === "DENIED" ? "text-danger" : undefined)}>
                  {t.status.toLowerCase().replace(/_/g, " ")}
                </Meta>
                <Meta className="metric">attempt {t.attempt}</Meta>
                <Meta className="metric">
                  {formatUsdPrecise(t.costUsd)} · {t.latencyMs === null ? "—" : formatDuration(t.latencyMs)}
                </Meta>
                <span className="flex min-w-0 items-center gap-2">
                  <RunLink runId={t.runId} />
                </span>
              </div>
            </summary>
            <div className="space-y-3 bg-muted px-5 py-4 sm:px-6">
              <p className="text-footnote flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                <span className="font-mono">{t.id}</span>
                <span>{formatDateTime(t.createdAt)}</span>
                {t.error ? <span className="text-danger">{t.error}</span> : null}
              </p>
              <JsonView label="Input" value={t.input} />
              <JsonView label="Output" value={t.output} />
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
