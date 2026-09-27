import type { Metadata } from "next";
import Link from "next/link";
import { subDays } from "date-fns";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDate, formatNumber, formatPercent, formatTokens, formatUsd } from "@/lib/format";
import { requireSession } from "@/server/auth";
import { getUsagePage, parseUsageRange } from "@/server/queries/usage";
import { chartDays } from "./_lib/chart-days";
import { spendTrend, type SpendTrend } from "./_lib/trend";
import { RangePicker } from "./_components/range-picker";
import { UsageChart } from "./_components/usage-chart";
import { ModelCostTable, ToolCostTable, WorkerCostTable } from "./_components/usage-tables";

export const metadata: Metadata = { title: "Usage" };

/** One quiet figure beside the headline number. */
function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card p-5 sm:p-6">
      <p className="text-footnote font-medium text-muted-foreground">{label}</p>
      <p className="metric mt-1 text-[17px] font-semibold text-foreground">{value}</p>
      {hint ? <p className="text-footnote mt-0.5 truncate text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const ARROW = { up: "↑", down: "↓" } as const;

/**
 * The comparison line under the headline, in the same quiet grey as everything else: more spend is not an
 * alarm, it is usually more work done. Direction is a glyph for sighted readers and a word for the rest.
 */
function Trend({ trend, days }: { trend: SpendTrend; days: number }) {
  if (trend.kind === "none") return <>Nothing was spent in the {days} days before this.</>;
  if (trend.kind === "flat") return <>About the same as the previous {days} days.</>;
  return (
    <>
      <span aria-hidden="true">{ARROW[trend.direction]} </span>
      <span className="sr-only">{trend.direction === "up" ? "Up" : "Down"} </span>
      {trend.kind === "percent" ? (
        <>
          <span className="metric">{formatPercent(trend.ratio)}</span> vs the previous {days} days
        </>
      ) : (
        <>
          from <span className="metric">{formatUsd(trend.previousUsd)}</span> in the previous {days} days
        </>
      )}
    </>
  );
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ range?: string | string[] }> }) {
  const [s, params] = await Promise.all([requireSession(), searchParams]);
  const days = parseUsageRange(params.range);
  const now = new Date();
  const usage = await getUsagePage(s.organizationId, days, now);
  const { totals } = usage;

  // The same window, one window back — the only honest way to say "less than last time".
  const previous = usage.hasUsage ? await getUsagePage(s.organizationId, days, subDays(now, days)) : null;
  const trend = spendTrend(totals.costUsd, previous?.totals.costUsd ?? 0);
  const mixedSimulation = usage.byModel.some((m) => m.simulated) && usage.byModel.some((m) => !m.simulated);

  return (
    <>
      <PageHeader
        title="Usage"
        description={`What your workers cost between ${formatDate(usage.from)} and ${formatDate(usage.to)}.`}
        actions={<RangePicker active={usage.days} />}
      />

      <div className="space-y-14">
        {usage.hasUsage ? (
          <>
            <Card className="p-0">
              <div className="grid gap-px bg-border lg:grid-cols-[1.3fr_1fr]">
                <div className="bg-card p-6 sm:p-8">
                  <p className="text-footnote font-medium text-muted-foreground">Spent in the last {days} days</p>
                  <p className="text-metric-xl mt-2 text-foreground">{formatUsd(totals.costUsd)}</p>
                  <p className="text-footnote mt-2 text-muted-foreground">
                    <Trend trend={trend} days={days} />
                  </p>
                  {usage.simulatedMode ? (
                    <p className="text-footnote mt-5 max-w-[46ch] text-pretty text-muted-foreground">
                      Simulated. Costs are priced for reference, and nothing is billed.
                    </p>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-1">
                  <Figure
                    label="Runs"
                    value={formatNumber(totals.runs, 0)}
                    hint={totals.runs > 0 ? `${formatUsd(totals.costUsd / totals.runs)} each` : "platform work only"}
                  />
                  <Figure
                    label="Calls"
                    value={formatNumber(totals.modelCalls + totals.toolCalls, 0)}
                    hint={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
                  />
                </div>
              </div>
            </Card>

            <Section
              title="Day by day"
              description="Model time stacked on tool fees, one bar per day. Hover a day for the split."
            >
              {/* Card pads only top and bottom; without the side inset the legend and grid run into its edges. */}
              <Card className="px-(--card-spacing)">
                <UsageChart byDay={chartDays(usage.byDay)} />
              </Card>
            </Section>

            <Section
              title="By worker"
              description="Who is spending what. Open a worker to see the same money run by run."
            >
              <WorkerCostTable rows={usage.byWorker} organizationName={s.organizationName} />
            </Section>

            <Section title="By model" description="Every model that answered, and the tokens it read and wrote.">
              <ModelCostTable rows={usage.byModel} markSimulated={mixedSimulation} />
            </Section>

            <Section title="By tool" description="Per-call fees for tools with a real backend. Built-in tools are free.">
              <ToolCostTable rows={usage.byTool} />
            </Section>
          </>
        ) : (
          <Card>
            <EmptyState
              title="Nothing to report yet"
              description={`No worker used a model or a tool in the last ${days} days. Once one runs, every call lands here with what it cost.`}
              action={
                <>
                  <Button size="lg" asChild>
                    <Link href="/workforce">Go to your workforce</Link>
                  </Button>
                  {usage.days !== 90 ? (
                    <Button size="lg" variant="secondary" asChild>
                      <Link href="/usage?range=90">Look back 90 days</Link>
                    </Button>
                  ) : null}
                </>
              }
            />
          </Card>
        )}
      </div>
    </>
  );
}
