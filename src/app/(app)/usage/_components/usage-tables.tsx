import type { ReactNode } from "react";
import Link from "next/link";
import { SimulatedBadge } from "@/components/simulated-badge";
import { WorkerAvatar } from "@/components/worker-avatar";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatTokens, formatUsd, formatUsdPrecise, pluralize } from "@/lib/format";
import { initialsOf } from "@/lib/initials";
import type { ModelTier } from "@/server/domain";
import type { UsageModelRow, UsageToolRow, UsageWorkerRow } from "@/server/queries/usage";
import { modelRowLabel } from "@/app/(app)/workers/[workerId]/_tabs/cost-labels";

/**
 * The three breakdowns. Every row is plain JSON from `getUsagePage`, so these stay server components.
 * Above 640px each is a table with right-aligned tabular numbers; below it, the same rows become a list —
 * name on the first line, the numbers that matter on the second.
 */

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-6 py-8 text-[15px] text-muted-foreground">{children}</p>;
}

/** The mobile form of one row: a sentence, then the money. */
function ListRow({ title, meta, value }: { title: ReactNode; meta: ReactNode; value: string }) {
  return (
    <li className="mx-6 flex items-start justify-between gap-4 border-b border-border py-4 last:border-0">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-[15px] font-medium text-foreground">{title}</p>
        <p className="text-footnote text-muted-foreground">{meta}</p>
      </div>
      <p className="metric shrink-0 text-right text-[15px] font-medium text-foreground">{value}</p>
    </li>
  );
}

/**
 * Platform work (scoping, reviews, chat) has no worker behind it, so its row wears the workspace's own
 * monogram in the neutral grey — the same shape as the avatars above it, without pretending to be one.
 */
function OrganizationMonogram({ name }: { name: string }) {
  return (
    <span
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tracking-tight text-muted-foreground select-none"
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}

function WorkerName({ row, organizationName }: { row: UsageWorkerRow; organizationName: string }) {
  return (
    <span className="flex items-center gap-2.5">
      {row.workerId === null ? (
        <OrganizationMonogram name={organizationName} />
      ) : (
        <WorkerAvatar name={row.workerName} color={row.avatarColor ?? "violet"} size="sm" />
      )}
      {row.href ? (
        <Link href={`${row.href}?tab=cost`} className="font-medium hover:text-link">
          {row.workerName}
        </Link>
      ) : (
        <span className={row.workerId === null ? "text-muted-foreground" : "font-medium"}>{row.workerName}</span>
      )}
    </span>
  );
}

export function WorkerCostTable({ rows, organizationName }: { rows: UsageWorkerRow[]; organizationName: string }) {
  if (rows.length === 0) {
    return (
      <Card className="py-0">
        <Empty>No worker used a model or a tool in this window.</Empty>
      </Card>
    );
  }

  return (
    <Card className="py-2 sm:py-0">
      <ul className="sm:hidden">
        {rows.map((row) => (
          <ListRow
            key={row.workerId ?? "platform"}
            title={row.workerName}
            meta={
              <>
                {row.runs > 0 ? pluralize(row.runs, "run") : "No runs"}
                {row.costPerRunUsd !== null ? ` · ${formatUsdPrecise(row.costPerRunUsd)} each` : ""}
              </>
            }
            value={formatUsd(row.costUsd)}
          />
        ))}
      </ul>

      <div className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Worker</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Per run</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.workerId ?? "platform"} className="h-14">
                <TableCell>
                  <WorkerName row={row} organizationName={organizationName} />
                </TableCell>
                <TableCell className="metric text-right">{row.runs > 0 ? formatNumber(row.runs, 0) : "—"}</TableCell>
                <TableCell className="metric text-right text-muted-foreground">{formatUsdPrecise(row.costPerRunUsd)}</TableCell>
                <TableCell className="metric text-right font-medium">{formatUsd(row.costUsd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

/**
 * The ledger stores model ids; a manager thinks in tiers. Rows are named the way the worker profile's Cost tab
 * names them (`modelRowLabel`): "Standard model", with a live model's id kept as a quiet second detail and a
 * simulator id ("mock-standard") dropped as noise. `routes` is today's tier routing, from `llm.route()`.
 */
export function ModelCostTable({
  rows,
  markSimulated,
  routes,
}: {
  rows: UsageModelRow[];
  markSimulated: boolean;
  routes: ReadonlyArray<{ tier: ModelTier; model: string }>;
}) {
  if (rows.length === 0) {
    return (
      <Card className="py-0">
        <Empty>No model call in this window.</Empty>
      </Card>
    );
  }

  return (
    <Card className="py-2 sm:py-0">
      <ul className="sm:hidden">
        {rows.map((row) => {
          const label = modelRowLabel(row.model, routes);
          return (
            <ListRow
              key={`${row.provider}:${row.model}`}
              title={label.title}
              meta={
                <>
                  {label.detail ? `${label.detail} · ` : ""}
                  {row.providerLabel} · {pluralize(row.calls, "call")} · {formatTokens(row.inputTokens)} in ·{" "}
                  {formatTokens(row.outputTokens)} out
                </>
              }
              value={formatUsdPrecise(row.costUsd)}
            />
          );
        })}
      </ul>

      <div className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Tokens in</TableHead>
              <TableHead className="text-right">Tokens out</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const label = modelRowLabel(row.model, routes);
              return (
                <TableRow key={`${row.provider}:${row.model}`} className="h-14">
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="font-medium">{label.title}</span>
                      <span className="text-footnote text-muted-foreground">
                        {label.detail ? `${label.detail} · ${row.providerLabel}` : row.providerLabel}
                      </span>
                      {markSimulated && row.simulated ? <SimulatedBadge /> : null}
                    </span>
                  </TableCell>
                  <TableCell className="metric text-right">{formatNumber(row.calls, 0)}</TableCell>
                  <TableCell className="metric text-right text-muted-foreground">{formatTokens(row.inputTokens)}</TableCell>
                  <TableCell className="metric text-right text-muted-foreground">{formatTokens(row.outputTokens)}</TableCell>
                  <TableCell className="metric text-right font-medium">{formatUsdPrecise(row.costUsd)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

export function ToolCostTable({ rows }: { rows: UsageToolRow[] }) {
  if (rows.length === 0) {
    return (
      <Card className="py-0">
        <Empty>No tool call in this window.</Empty>
      </Card>
    );
  }

  return (
    <Card className="py-2 sm:py-0">
      <ul className="sm:hidden">
        {rows.map((row) => (
          <ListRow
            key={row.toolName}
            title={row.displayName}
            meta={
              <>
                {pluralize(row.calls, "call")} ·{" "}
                {row.costPerCallUsd === 0 ? "free" : `${formatUsdPrecise(row.costPerCallUsd)} each`}
              </>
            }
            value={row.costUsd === 0 ? "Free" : formatUsdPrecise(row.costUsd)}
          />
        ))}
      </ul>

      <div className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Per call</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.toolName} className="h-14">
                <TableCell>
                  <span className="font-medium">{row.displayName}</span>
                </TableCell>
                <TableCell className="metric text-right">{formatNumber(row.calls, 0)}</TableCell>
                <TableCell className="metric text-right text-muted-foreground">
                  {row.costPerCallUsd === 0 ? "Free" : formatUsdPrecise(row.costPerCallUsd)}
                </TableCell>
                <TableCell className="metric text-right font-medium">
                  {row.costUsd === 0 ? "—" : formatUsdPrecise(row.costUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
