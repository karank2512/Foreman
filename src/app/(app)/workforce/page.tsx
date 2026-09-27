import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import { EmptyState } from "@/components/empty-state";
import { LiveDot } from "@/components/live-dot";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Stat, StatStrip, type StatTrend } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatUsd, pluralize } from "@/lib/format";
import { requireSession } from "@/server/auth";
import { getWorkforce, type AttentionItem, type WorkforceStats } from "@/server/queries/workforce";
import type { WorkforcePermissions } from "@/server/queries/permissions";
import { tools } from "@/server/tools";
import { ActivityRow } from "@/app/(app)/activity/_components/activity-row";
import { HireFirst } from "./_components/hire-first";
import { NeedsYou } from "./_components/needs-you";
import { WorkerCard } from "./_components/worker-card";

export const metadata: Metadata = { title: "Workforce" };

const RECENT_ACTIVITY_ROWS = 6;

/**
 * Tools whose approval needs an admin. The attention item carries the tool's display name rather than its
 * registry name (see CONTRACT ISSUES), so the match is on the label.
 */
const EXTERNAL_TOOL_LABELS = new Set(
  tools
    .list()
    .filter((tool) => tool.sideEffect === "external_write")
    .map((tool) => tool.displayName),
);

/** Month-over-month movement for the spend stat. Up is bad news here, so the tone is inverted. */
function spendTrend(stats: WorkforceStats): StatTrend {
  const { spendThisMonthUsd: now, spendLastMonthUsd: prev, spendByDay } = stats;
  const values = spendByDay.length > 1 ? spendByDay : undefined;
  if (prev <= 0 || now <= 0) return { values, label: prev <= 0 && now > 0 ? "first month of spend" : undefined };
  const change = (now - prev) / prev;
  if (Math.abs(change) < 0.005) return { direction: "flat", label: "same as last month", tone: "neutral", values };
  const pct = `${Math.abs(Math.round(change * 100))}% vs last month`;
  return { direction: change > 0 ? "up" : "down", label: pct, tone: change > 0 ? "negative" : "positive", values };
}

/**
 * Which pending requests this viewer can't answer from here. `decideApproval` re-checks the role in the DB —
 * this only stops someone clicking into a refusal.
 */
function blockedApprovals(items: AttentionItem[], permissions: WorkforcePermissions): Record<string, string> {
  if (permissions["approvals.decide"] && permissions["workers.manage"]) return {};
  const blocked: Record<string, string> = {};
  for (const item of items) {
    if (item.kind !== "approval") continue;
    if (!permissions["approvals.decide"]) {
      blocked[item.approvalId] = "Your role can't decide requests.";
      continue;
    }
    // approvals.decideExternal and workers.manage are both ADMIN, so the roster's permission set answers it.
    if (EXTERNAL_TOOL_LABELS.has(item.toolLabel) && !permissions["workers.manage"]) {
      blocked[item.approvalId] = "This one leaves the workspace — an admin has to answer it.";
    }
  }
  return blocked;
}

export default async function WorkforcePage() {
  const s = await requireSession();
  const data = await getWorkforce(s.organizationId, new Date(), { role: s.role });
  const { stats, workers, attention, recentActivity, permissions } = data;
  const freshOrg = workers.length === 0 && stats.retiredWorkers === 0;

  if (freshOrg) {
    return (
      <>
        <PageHeader title="Workforce" description="Your AI workers and how they're doing." />
        <HireFirst canHire={permissions["workers.hire"]} />
      </>
    );
  }

  const idle = [
    stats.pausedWorkers > 0 ? pluralize(stats.pausedWorkers, "paused") : null,
    stats.retiredWorkers > 0 ? pluralize(stats.retiredWorkers, "retired") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <PageHeader
        title="Workforce"
        description="Your AI workers and how they're doing."
        actions={data.hasRunsInFlight ? <LiveDot /> : undefined}
      />

      <div className="space-y-14">
        {attention.length > 0 ? (
          <NeedsYou items={attention} blockedReasons={blockedApprovals(attention, permissions)} />
        ) : null}

        <StatStrip>
          <Stat label="Active workers" value={stats.activeWorkers} hint={idle || "Everyone is on the job"} />
          <Stat
            label="Runs today"
            value={stats.runsToday}
            hint={
              stats.runsInFlight > 0 ? (
                <LiveDot label={`${pluralize(stats.runsInFlight, "run")} going now`} />
              ) : (
                "Nothing running right now"
              )
            }
          />
          <Stat
            label="Awaiting review"
            value={stats.deliverablesAwaitingReview}
            hint={
              stats.deliverablesTotal > 0
                ? `of ${pluralize(stats.deliverablesTotal, "deliverable")} so far`
                : "No deliverables yet"
            }
          />
          <Stat
            label="Spend this month"
            value={formatUsd(stats.spendThisMonthUsd)}
            trend={spendTrend(stats)}
            // "Simulated" is said once, in the nav, and on generated artifacts — not under every number.
            hint={
              <Link href="/usage" className="outline-none hover:text-foreground">
                See usage
              </Link>
            }
          />
        </StatStrip>

        <Section title="Your team" description={`${pluralize(workers.length, "worker")} on the roster.`}>
          {workers.length === 0 ? (
            <Card>
              <EmptyState
                title="No one on the roster"
                description="Everyone here has been retired. Hire a new worker to pick the work back up."
                action={
                  permissions["workers.hire"] ? (
                    <Button size="lg" asChild>
                      <Link href="/hire">Hire a worker</Link>
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              {workers.map((worker) => (
                <WorkerCard key={worker.id} worker={worker} canRun={permissions["workers.run"]} />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Recent activity"
          actions={
            recentActivity.length > 0 ? (
              <Button variant="link" asChild>
                <Link href="/activity">
                  View all <ChevronRight data-icon="inline-end" />
                </Link>
              </Button>
            ) : undefined
          }
        >
          <Card>
            {recentActivity.length === 0 ? (
              <EmptyState
                title="Quiet so far"
                description="Runs, deliverables and decisions show up here as they happen."
              />
            ) : (
              <CardContent className="divide-y divide-border">
                {recentActivity.slice(0, RECENT_ACTIVITY_ROWS).map((item) => (
                  <ActivityRow key={item.id} item={item} dense />
                ))}
              </CardContent>
            )}
          </Card>
        </Section>
      </div>

      <AutoRefresh active={data.hasRunsInFlight} />
    </>
  );
}
