import type { WorkerProposal } from "@/server/domain";
import { computeNextRunAt, describeCadence } from "@/server/domain";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime, formatDuration, formatNumber, formatTokens, formatUsd, formatUsdPrecise } from "@/lib/format";
import { CONFIDENCE_LABELS, MODEL_TIER_LABELS, formatKpiTarget } from "../schema";

/** What the worker is measured on, run after run: one row each, target right-aligned in tabular figures. */
export function ProposalKpis({ proposal }: { proposal: WorkerProposal }) {
  const { blueprint } = proposal;
  return (
    <Card className="py-0">
      <CardContent className="divide-y divide-border px-0">
        {blueprint.kpis.map((kpi) => (
          <div key={kpi.id} className="flex items-start justify-between gap-6 px-6 py-4">
            <div className="min-w-0">
              <p className="font-medium">{kpi.name}</p>
              <p className="text-footnote text-pretty text-muted-foreground">{kpi.description}</p>
            </div>
            <p className="metric shrink-0 font-medium">{formatKpiTarget(kpi)}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Cost, schedule and the hard limits, with the arithmetic tucked into a disclosure for whoever wants it.
 * The résumé above already carries the per-run figure, so this section leads with the monthly number — the
 * one fact it adds — and keeps the repeat quiet. Nothing on this page outsizes the worker's name.
 */
export function ProposalCost({ proposal }: { proposal: WorkerProposal }) {
  const { costEstimate, limits, schedule } = proposal.blueprint;
  const next = computeNextRunAt(schedule, new Date());

  return (
    <Card className="[--card-spacing:--spacing(7)]">
      <CardContent className="space-y-7">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-metric text-foreground">{formatUsd(costEstimate.monthlyUsd)}</p>
            <p className="mt-1 text-footnote text-muted-foreground">
              a month at about <span className="metric">{formatNumber(costEstimate.runsPerMonth, 1)}</span> runs
            </p>
          </div>
          <div className="text-right max-sm:text-left">
            <p className="metric text-title-3">{formatUsdPrecise(costEstimate.perRunUsd)}</p>
            <p className="mt-1 text-footnote text-muted-foreground">
              per run · {CONFIDENCE_LABELS[costEstimate.confidence].toLowerCase()}
            </p>
          </div>
        </div>

        <div className="space-y-2 border-t border-border pt-6">
          <p>
            {describeCadence(schedule)}.{" "}
            <span className="text-muted-foreground">
              {next ? <>First run starts on hire, then {formatDateTime(next)}.</> : "Runs start when you ask for one."}
            </span>
          </p>
          <p className="text-muted-foreground">
            Each run stops at <span className="metric">{formatUsd(limits.maxCostPerRunUsd)}</span>,{" "}
            <span className="metric">{formatNumber(limits.maxToolCallsPerRun, 0)}</span> tool calls or{" "}
            <span className="metric">{formatDuration(limits.maxRunDurationSec * 1000)}</span>, whichever comes first.
          </p>
        </div>

        {costEstimate.breakdown.length > 0 || costEstimate.assumptions.length > 0 ? (
          <details className="group/details border-t border-border pt-6">
            <summary className="w-fit cursor-pointer list-none rounded-sm text-footnote font-medium text-link outline-none hover:underline">
              <span className="group-open/details:hidden">Show how that is worked out</span>
              <span className="hidden group-open/details:inline">Hide the working</span>
            </summary>

            {costEstimate.breakdown.length > 0 ? (
              <table className="mt-5 w-full text-footnote">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th scope="col" className="pb-2 font-semibold">
                      Step
                    </th>
                    <th scope="col" className="pb-2 font-semibold">
                      Model
                    </th>
                    <th scope="col" className="pb-2 text-right font-semibold">
                      Tokens in / out
                    </th>
                    <th scope="col" className="pb-2 text-right font-semibold">
                      Per run
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {costEstimate.breakdown.map((item) => (
                    <tr key={item.componentId} className="border-b border-border last:border-0">
                      <td className="py-2.5 pr-4 font-medium">{item.label}</td>
                      <td className="py-2.5 pr-4 text-muted-foreground">{item.modelTier ? MODEL_TIER_LABELS[item.modelTier] : "—"}</td>
                      <td className="metric py-2.5 pr-4 text-right text-muted-foreground">
                        {formatTokens(item.estInputTokens)} / {formatTokens(item.estOutputTokens)}
                      </td>
                      <td className="metric py-2.5 text-right">{formatUsdPrecise(item.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {costEstimate.assumptions.length > 0 ? (
              <ul className="mt-5 space-y-2 text-footnote text-muted-foreground">
                {costEstimate.assumptions.map((line, i) => (
                  <li key={`${i}-${line}`} className="text-pretty">
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
