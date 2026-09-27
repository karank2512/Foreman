import { EmptyState } from "@/components/empty-state";
import { Section } from "@/components/section";
import { Stat, StatStrip } from "@/components/stat-card";
import { Card, CardContent } from "@/components/ui/card";
import { formatNumber, formatPercent, formatUsd, formatUsdPrecise, pluralize } from "@/lib/format";
import { llm } from "@/server/models";
import type { ModelTier } from "@/server/domain";
import { getWorkerCost } from "@/server/queries/worker-profile";
import { Row, RowList, RowMeta, RowTitle, Sep } from "../_components/rows";
import { CostChart } from "./cost-chart";
import { modelRowLabel } from "./cost-labels";
import type { WorkerTabProps } from "./types";

export default async function CostTab({ session, workerId, workerName }: WorkerTabProps) {
  const cost = await getWorkerCost(session.organizationId, workerId);
  const hasSpend = cost.totalCostUsd > 0;
  const estimate = cost.estimatedPerRunUsd;
  const actual = cost.avgCostPerRunUsd;
  const delta = estimate !== null && actual !== null && estimate > 0 ? (actual - estimate) / estimate : null;
  const billable = cost.modelCostUsd + cost.toolCostUsd;
  const modelShare = billable > 0 ? cost.modelCostUsd / billable : null;
  const everythingSimulated = cost.simulated || cost.simulatedShare === 1;
  const someSimulated = cost.simulatedShare !== null && cost.simulatedShare > 0;
  // The ledger keeps the model id; a manager thinks in tiers. Map ids back through today's routing.
  const routes = (["fast", "standard", "reasoning"] as const satisfies readonly ModelTier[]).map((tier) => ({
    tier,
    model: llm.route(tier).model,
  }));

  return (
    <>
      <div>
        <p className="text-metric-xl text-foreground">{formatUsd(cost.totalCostUsd)}</p>
        <p className="text-body mt-2 text-muted-foreground">
          {workerName}&apos;s spend over the last {cost.days} days
          {cost.runs > 0 ? `, across ${pluralize(cost.runs, "run")}` : ""}.
        </p>
        {everythingSimulated || someSimulated ? (
          <p className="text-footnote mt-2 max-w-[65ch] text-pretty text-muted-foreground">
            {everythingSimulated
              ? "Simulated. Every call was priced at its tier's reference model for comparison — nothing was billed."
              : `${formatPercent(cost.simulatedShare)} of this came from simulated calls, priced for reference rather than billed.`}
          </p>
        ) : null}
      </div>

      <StatStrip>
        <Stat
          label="Average a run"
          value={formatUsdPrecise(actual)}
          hint={
            // The plan is an estimate, so it reads in whole cents; the actual spend above keeps its precision.
            estimate === null
              ? "No estimate on file"
              : delta === null
                ? `${formatUsd(estimate)} planned`
                : delta > 0.1
                  ? `${formatPercent(delta)} over the ${formatUsd(estimate)} plan`
                  : delta < -0.1
                    ? `${formatPercent(-delta)} under the ${formatUsd(estimate)} plan`
                    : `On the ${formatUsd(estimate)} plan`
          }
        />
        <Stat label="Per deliverable" value={formatUsdPrecise(cost.costPerDeliverableUsd)} hint="Spend ÷ work produced" />
        <Stat
          label="Thinking"
          value={formatUsd(cost.modelCostUsd)}
          hint={modelShare === null ? "No model calls yet" : `${formatPercent(modelShare)} of the bill`}
        />
        <Stat
          label="Tools"
          value={formatUsd(cost.toolCostUsd)}
          hint={modelShare === null ? "No tool calls yet" : `${formatPercent(1 - modelShare)} of the bill`}
        />
      </StatStrip>

      <Section title="Day by day" description={`What ${workerName} cost each day over the last ${cost.days} days.`}>
        <Card>
          <CardContent>
            {hasSpend ? (
              <CostChart byDay={cost.byDay} />
            ) : (
              <EmptyState
                title="No spend yet"
                description={`${workerName} hasn't used a model or a tool in this window.`}
                className="py-14"
              />
            )}
          </CardContent>
        </Card>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          className="flex flex-col"
          title="Where the money went"
          description={
            modelShare === null
              ? "Nothing to break down yet."
              : modelShare >= 0.8
                ? "Almost all of it is model time — a faster tier on one step is where savings come from."
                : modelShare >= 0.5
                  ? "Model time is the bigger half; tool fees are charged per call."
                  : "Tool fees dominate — a tighter per-run call limit is the quickest lever."
          }
        >
          {cost.byResource.length === 0 ? (
            <Card className="flex-1">
              <CardContent>
                <p className="text-muted-foreground">No usage recorded in this window.</p>
              </CardContent>
            </Card>
          ) : (
            <RowList className="flex-1">
              {cost.byResource.map((r) => {
                const model = r.kind === "MODEL" ? modelRowLabel(r.resource, routes) : null;
                return (
                  <Row key={`${r.kind}:${r.resource}`} className="items-center">
                    <div className="min-w-0 flex-1">
                      <RowTitle>{model ? model.title : r.label}</RowTitle>
                      <RowMeta>
                        {/* A live model's id is worth a glance (which one is billing); a simulator id is noise. */}
                        <span>{model ? (model.detail ?? "Model") : "Tool"}</span>
                        <Sep />
                        <span>{formatNumber(r.calls, 0)} calls</span>
                        {cost.totalCostUsd > 0 ? (
                          <>
                            <Sep />
                            <span>{formatPercent(r.costUsd / cost.totalCostUsd)} of spend</span>
                          </>
                        ) : null}
                      </RowMeta>
                    </div>
                    <span className="metric shrink-0 text-[15px] font-medium">{formatUsdPrecise(r.costUsd)}</span>
                  </Row>
                );
              })}
            </RowList>
          )}
        </Section>

        <Section className="flex flex-col" title="By version" description="Did a change make runs cheaper or dearer?">
          {cost.byVersion.length === 0 ? (
            <Card className="flex-1">
              <CardContent>
                <p className="text-muted-foreground">No runs in this window.</p>
              </CardContent>
            </Card>
          ) : (
            <RowList className="flex-1">
              {cost.byVersion.map((v) => (
                <Row key={v.workerVersionId} className="items-center">
                  <div className="min-w-0 flex-1">
                    <RowTitle>Version {v.version}</RowTitle>
                    <RowMeta>
                      <span>{pluralize(v.runs, "run")}</span>
                      <Sep />
                      <span>{formatUsdPrecise(v.avgCostPerRunUsd)} a run</span>
                    </RowMeta>
                  </div>
                  <span className="metric shrink-0 text-[15px] font-medium">{formatUsd(v.totalCostUsd)}</span>
                </Row>
              ))}
              {cost.estimatedMonthlyUsd !== null ? (
                <Row className="items-center">
                  <div className="min-w-0 flex-1">
                    <RowTitle className="font-normal text-muted-foreground">Planned monthly budget</RowTitle>
                  </div>
                  <span className="metric shrink-0 text-[15px] font-medium">{formatUsd(cost.estimatedMonthlyUsd)}</span>
                </Row>
              ) : null}
            </RowList>
          )}
        </Section>
      </div>
    </>
  );
}
