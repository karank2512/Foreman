import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { Section } from "@/components/section";
import { Card, CardContent } from "@/components/ui/card";
import { formatDuration, formatUsd } from "@/lib/format";
import { isAppError } from "@/server/errors";
import { getWorkerPermissions, type WorkerPermissionsView } from "@/server/queries/worker-manage";
import { timeZoneLabel } from "../_components/labels";
import { Row, RowList, RowTitle } from "../_components/rows";
import { PermissionsGrantsTable } from "./permissions-grants-table";
import { PermissionsScheduleEditor } from "./permissions-schedule-editor";
import type { WorkerTabProps } from "./types";

/**
 * Permissions tab — what the worker may touch, when it works and how much a run may spend. Grants and schedule
 * change in place; run limits belong to the blueprint and only move through a new version.
 */
export default async function PermissionsTab({ session, workerId, workerName }: WorkerTabProps) {
  let data: WorkerPermissionsView;
  try {
    data = await getWorkerPermissions(session.organizationId, workerId, { role: session.role });
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const retired = data.worker.status === "RETIRED";
  const mayManage = data.permissions["workers.manage"];

  return (
    <>
      <Section
        title="What they can touch"
        description={`Every tool ${workerName} can use, and whether it asks you first. Checked on our servers before each call, not just here.`}
      >
        {data.grants.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                title="No tools yet"
                description={`${workerName} works from what the job gives them. Tools come from the worker's design and appear here once hired.`}
              />
            </CardContent>
          </Card>
        ) : (
          <>
            <PermissionsGrantsTable
              workerId={data.worker.id}
              workerName={workerName}
              grants={data.grants}
              readOnly={retired || !mayManage}
            />
            <p className="text-footnote mt-4 max-w-[70ch] text-pretty text-muted-foreground">
              {retired ? (
                `${workerName} is retired, so access can no longer change.`
              ) : !mayManage ? (
                "Your role can see access but not change it. Ask a workspace admin."
              ) : (
                <>
                  A tool set to &ldquo;Asks first&rdquo; pauses the run until you decide in{" "}
                  <Link href="/approvals" className="text-link hover:underline">
                    Approvals
                  </Link>
                  . Tools that ship approval-gated, like sending a message outside the workspace, cannot be loosened.
                </>
              )}
            </p>
          </>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          className="flex flex-col"
          title="Schedule"
          description={`When the next run starts. Times are in ${timeZoneLabel()}.`}
        >
          <Card className="flex-1">
            <CardContent>
              <PermissionsScheduleEditor
                workerId={data.worker.id}
                workerName={workerName}
                schedule={data.schedule}
                scheduleLabel={data.scheduleLabel}
                nextRunAt={data.worker.nextRunAt}
                status={data.worker.status}
                readOnly={!mayManage}
              />
            </CardContent>
          </Card>
        </Section>

        <Section
          className="flex flex-col"
          title="Run limits"
          description={
            data.currentVersion
              ? `Guardrails from version ${data.currentVersion.version} of ${workerName}'s design.`
              : "Guardrails every run stays inside."
          }
        >
          {data.limits ? (
            <RowList className="flex-1">
              <Row className="items-center">
                <div className="min-w-0 flex-1">
                  <RowTitle className="font-normal">Most a run may spend</RowTitle>
                </div>
                <span className="metric shrink-0 text-[15px] font-medium">
                  {formatUsd(data.limits.maxCostPerRunUsd)}
                  {data.estimatedCostPerRunUsd !== null ? (
                    <span className="text-footnote ml-2 font-normal text-muted-foreground">
                      ~{formatUsd(data.estimatedCostPerRunUsd)} expected
                    </span>
                  ) : null}
                </span>
              </Row>
              <Row className="items-center">
                <div className="min-w-0 flex-1">
                  <RowTitle className="font-normal">Most tool calls in a run</RowTitle>
                </div>
                <span className="metric shrink-0 text-[15px] font-medium">{data.limits.maxToolCallsPerRun}</span>
              </Row>
              <Row className="items-center">
                <div className="min-w-0 flex-1">
                  <RowTitle className="font-normal">Longest a run may take</RowTitle>
                </div>
                <span className="metric shrink-0 text-[15px] font-medium">
                  {formatDuration(data.limits.maxRunDurationSec * 1000)}
                </span>
              </Row>
              <Row>
                <p className="text-footnote text-pretty text-muted-foreground">
                  Limits are part of the design, so they change through a new version.{" "}
                  <Link href={`/workers/${data.worker.id}?tab=versions`} className="text-link hover:underline">
                    Propose a change ›
                  </Link>
                </p>
              </Row>
            </RowList>
          ) : (
            <Card className="flex-1">
              <CardContent>
                <p className="text-muted-foreground">Limits appear once {workerName} has an active version.</p>
              </CardContent>
            </Card>
          )}
        </Section>
      </div>
    </>
  );
}
