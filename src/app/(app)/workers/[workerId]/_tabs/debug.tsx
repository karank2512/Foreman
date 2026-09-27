import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { JsonView } from "@/components/json-view";
import { Section } from "@/components/section";
import { SimulatedBadge } from "@/components/simulated-badge";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { isAppError } from "@/server/errors";
import { getWorkerDebug, type WorkerDebugView } from "@/server/queries/worker-manage";
import { Fact, Facts } from "../_components/rows";
import { DebugModelCallList, DebugToolCallList, simulatedNote } from "./debug-call-lists";
import type { WorkerTabProps } from "./types";

/**
 * Debug tab — the raw material behind the worker, for engineers and demos: the live blueprint, the latest run's
 * checkpoint, recent model and tool calls, and the grant rows as stored. Everything is org-scoped by the query.
 */
export default async function DebugTab({ session, workerId, workerName }: WorkerTabProps) {
  let data: WorkerDebugView;
  try {
    data = await getWorkerDebug(session.organizationId, workerId);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }

  return (
    <>
      <div>
        <p className="max-w-[65ch] text-[15px] text-pretty text-muted-foreground">
          Raw model calls and tool traces, for troubleshooting. Nothing here is needed to manage {workerName} —
          everything is collapsed by default.
        </p>
        {/* The worker's id is already in the address bar; the version id is the one a trace needs. */}
        <Facts className="mt-3">
          {data.currentVersion ? (
            <>
              <Fact>Version {data.currentVersion.version}</Fact>
              <Fact>
                <StatusBadge kind="version" status={data.currentVersion.status} emphasis="dot" />
              </Fact>
              <Fact>{data.currentVersion.locked ? "Locked (has run)" : "Unlocked"}</Fact>
              <Fact>
                <span className="min-w-0 truncate font-mono">{data.currentVersion.id}</span>
                <CopyButton value={data.currentVersion.id} />
              </Fact>
            </>
          ) : (
            <Fact>No current version</Fact>
          )}
        </Facts>
      </div>

      <Section title="Current blueprint" description="The design the runtime executes, exactly as stored.">
        {data.blueprint === null ? (
          <Card>
            <CardContent>
              <EmptyState title="No blueprint" description={`${workerName} has no active version.`} />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {!data.blueprintValid ? (
              <p className="text-footnote rounded-[14px] bg-warning-soft px-4 py-3 text-foreground">
                The stored blueprint no longer matches the current schema — showing the raw JSON.
              </p>
            ) : null}
            <JsonView
              label={`WorkerVersion.blueprint${data.currentVersion ? ` (v${data.currentVersion.version})` : ""}`}
              value={data.blueprint}
            />
          </div>
        )}
      </Section>

      <Section title="Latest checkpoint" description="Where the most recent run left off — what a resume starts from.">
        {data.latestRun ? (
          <div className="space-y-3">
            <Facts>
              <Fact>
                <StatusBadge kind="run" status={data.latestRun.status} emphasis="dot" />
              </Fact>
              <Fact>{data.latestRun.trigger.toLowerCase()}</Fact>
              <Fact>attempt {data.latestRun.attempt}</Fact>
              <Fact>
                {formatDateTime(data.latestRun.createdAt)}
                {data.latestRun.simulated ? <SimulatedBadge /> : null}
              </Fact>
              <Fact>
                <Link href={`/runs/${data.latestRun.id}`} className="text-link hover:underline">
                  Open run ›
                </Link>
              </Fact>
            </Facts>
            {data.latestRun.error ? <p className="text-footnote text-danger">{data.latestRun.error}</p> : null}
            {data.latestRun.checkpoint === null ? (
              <p className="text-footnote text-muted-foreground">
                No checkpoint saved yet — the run has not reached a component boundary.
              </p>
            ) : (
              <JsonView label="Run.checkpoint" value={data.latestRun.checkpoint} />
            )}
          </div>
        ) : (
          <Card>
            <CardContent>
              <EmptyState
                title="No runs yet"
                description={`${workerName} has not started a run, so there is no checkpoint to show.`}
              />
            </CardContent>
          </Card>
        )}
      </Section>

      <Section
        title="Model calls"
        description={withNote(
          `The last ${data.modelCalls.length} LLM calls made on behalf of ${workerName}, newest first. Expand a row for the request and response.`,
          simulatedNote(data.modelCalls),
        )}
      >
        <Card className="gap-0 py-0">
          {data.modelCalls.length === 0 ? (
            <EmptyState
              title="No model calls yet"
              description="Calls appear as soon as a run, a chat reply or a replacement analysis happens."
              className="py-14"
            />
          ) : (
            <DebugModelCallList calls={data.modelCalls} />
          )}
        </Card>
      </Section>

      <Section
        title="Tool calls"
        description={withNote(
          `The last ${data.toolCalls.length} tool calls across ${workerName}'s runs, newest first.`,
          simulatedNote(data.toolCalls),
        )}
      >
        <Card className="gap-0 py-0">
          {data.toolCalls.length === 0 ? (
            <EmptyState
              title="No tool calls yet"
              description={`${workerName} has not used a tool in a run yet.`}
              className="py-14"
            />
          ) : (
            <DebugToolCallList calls={data.toolCalls} />
          )}
        </Card>
      </Section>

      <Section title="Raw grants" description="WorkerToolGrant rows as stored — what the permission check reads.">
        <JsonView label={`WorkerToolGrant × ${data.grants.length}`} value={data.grants} />
      </Section>
    </>
  );
}

function withNote(description: string, note: string | null): string {
  return note ? `${description} ${note}` : description;
}
