import type { ReactNode } from "react";
import { Stat, StatStrip } from "@/components/stat-card";
import { Card } from "@/components/ui/card";
import { formatDuration, formatNumber, formatPercent, formatUsd, pluralize } from "@/lib/format";
import { SCORE_BAND_CLASSES, scoreBand } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { EstimatedDeltasView, VersionCard } from "@/server/queries/worker-manage";
import { exampleTitle, formatLabel, operationLabel } from "../../../_components/labels";
import { TIER_LABELS } from "../../../_tabs/versions-labels";
import { targetCardHeading } from "./replace-labels";

/**
 * The compare page's two halves: the estimated impact strip, and an aligned before/after table. Rows that
 * differ are marked once, on the proposed side — everything else reads as unchanged and stays quiet.
 */

// ── Estimated impact ────────────────────────────────────────────────────────

function signed(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  const rounded = Math.round(pct);
  return `${rounded > 0 ? "+" : ""}${formatNumber(rounded, 0)}%`;
}

/** Up is good for quality; down is good for cost and latency. Zero is neutral. */
function tone(pct: number | null, upIsGood: boolean): "positive" | "negative" | "neutral" {
  if (pct === null || !Number.isFinite(pct) || Math.round(pct) === 0) return "neutral";
  return (pct > 0) === upIsGood ? "positive" : "negative";
}

function direction(pct: number | null): "up" | "down" | "flat" {
  if (pct === null || !Number.isFinite(pct) || Math.round(pct) === 0) return "flat";
  return pct > 0 ? "up" : "down";
}

export function EstimatedDeltas({
  deltas,
  base,
  target,
}: {
  deltas: EstimatedDeltasView;
  base: VersionCard | null;
  target: VersionCard;
}) {
  const fromAnalysis = deltas.source === "analysis";
  return (
    <StatStrip className="md:grid-cols-3">
      <Stat
        label="Quality"
        value={signed(deltas.qualityPct)}
        hint={fromAnalysis ? "expected change in deliverable scores" : "not estimated for this change"}
        trend={{ direction: direction(deltas.qualityPct), tone: tone(deltas.qualityPct, true) }}
      />
      <Stat
        label="Cost a run"
        value={signed(deltas.costPct)}
        hint={
          base
            ? `${formatUsd(base.costPerRunUsd)} → ${formatUsd(target.costPerRunUsd)}`
            : `${formatUsd(target.costPerRunUsd)} a run`
        }
        trend={{ direction: direction(deltas.costPct), tone: tone(deltas.costPct, false) }}
      />
      <Stat
        label="Run time"
        value={signed(deltas.latencyPct)}
        hint={fromAnalysis ? "expected change in time per run" : "not estimated for this change"}
        trend={{ direction: direction(deltas.latencyPct), tone: tone(deltas.latencyPct, false) }}
      />
    </StatStrip>
  );
}

// ── Side by side ────────────────────────────────────────────────────────────

interface CompareRow {
  label: string;
  base: ReactNode;
  target: ReactNode;
  changed: boolean;
}

function stepsOf(card: VersionCard): ReactNode {
  return (
    <ol className="space-y-1.5">
      {card.steps.map((step, i) => (
        <li key={step.id} className="flex gap-2">
          <span className="metric text-footnote w-4 shrink-0 pt-0.5 text-tertiary">{i + 1}</span>
          <span className="min-w-0">
            {step.name}
            <span className="text-footnote block text-muted-foreground">
              {step.tier ? `${TIER_LABELS[step.tier]} model` : operationLabel(step.detail.replace(/ /g, "_"))}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function toolsOf(card: VersionCard): ReactNode {
  if (card.tools.length === 0) return "No tools — works from the data it is given.";
  return (
    <ul className="space-y-1">
      {card.tools.map((t) => (
        <li key={t.toolName}>
          {t.displayName}
          {t.requiresApproval ? <span className="text-muted-foreground"> · asks first</span> : null}
        </li>
      ))}
    </ul>
  );
}

function kpisOf(card: VersionCard): ReactNode {
  if (card.kpis.length === 0) return "No targets set.";
  return (
    <ul className="space-y-1">
      {card.kpis.map((k) => (
        <li key={k.id}>
          {k.name}
          <span className="metric text-muted-foreground">
            {" "}
            {k.direction === "higher_is_better" ? "≥" : "≤"} {k.target}
          </span>
        </li>
      ))}
    </ul>
  );
}

function trackRecordOf(card: VersionCard, isTarget: boolean): ReactNode {
  const m = card.trackRecord;
  const band = SCORE_BAND_CLASSES[scoreBand(card.score)];
  if (!m || card.runCount === 0) {
    return (
      <span className="text-muted-foreground">
        {isTarget ? "Nothing yet — the record starts with the first run." : "No finished runs to rate."}
      </span>
    );
  }
  return (
    <>
      <span className="metric text-[17px] font-semibold">{card.score === null ? "—" : Math.round(card.score)}</span>{" "}
      <span className={cn("text-footnote", band.text)}>{band.label}</span>
      <span className="text-footnote block text-muted-foreground">
        {pluralize(m.runs, "run")}
        {m.successRate !== null ? ` · ${formatPercent(m.successRate)} clean` : ""}
        {m.acceptanceRate !== null ? ` · ${formatPercent(m.acceptanceRate)} accepted` : ""}
      </span>
    </>
  );
}

function rowsFor(base: VersionCard | null, target: VersionCard): CompareRow[] {
  const differs = (a: unknown, b: unknown) => base !== null && JSON.stringify(a) !== JSON.stringify(b);
  const persona = (c: VersionCard) => (
    <>
      {c.persona.name}
      <span className="text-footnote block text-muted-foreground">{c.persona.title}</span>
    </>
  );
  const cost = (c: VersionCard) => (
    <>
      <span className="metric">{formatUsd(c.costPerRunUsd)}</span>
      <span className="text-footnote block text-muted-foreground">
        about {formatUsd(c.monthlyUsd)} a month at {formatNumber(c.runsPerMonth, 1)} runs
      </span>
    </>
  );
  const limits = (c: VersionCard) => (
    <>
      <span className="metric">{formatUsd(c.limits.maxCostPerRunUsd)}</span> a run at most
      <span className="text-footnote block text-muted-foreground">
        {c.limits.maxToolCallsPerRun} tool calls · {formatDuration(c.limits.maxRunDurationSec * 1000)}
      </span>
    </>
  );
  // What the next run would call it, and the kind of file — never the raw `{{date}}` template or enum.
  const deliverable = (c: VersionCard) => (
    <>
      {exampleTitle(c.deliverable.titleTemplate)}
      <span className="text-footnote block text-muted-foreground">{formatLabel(c.deliverable.format)}</span>
    </>
  );

  return [
    {
      label: "Who",
      base: base ? persona(base) : null,
      target: persona(target),
      changed: differs(base?.persona, target.persona),
    },
    {
      label: "Track record",
      base: base ? trackRecordOf(base, false) : null,
      target: trackRecordOf(target, true),
      changed: false,
    },
    {
      label: "How the work gets done",
      base: base ? stepsOf(base) : null,
      target: stepsOf(target),
      changed: differs(
        base?.steps.map((s) => [s.name, s.tier, s.detail]),
        target.steps.map((s) => [s.name, s.tier, s.detail]),
      ),
    },
    {
      label: "Tools and access",
      base: base ? toolsOf(base) : null,
      target: toolsOf(target),
      changed: differs(base?.tools, target.tools),
    },
    {
      label: "Targets",
      base: base ? kpisOf(base) : null,
      target: kpisOf(target),
      changed: differs(base?.kpis, target.kpis),
    },
    {
      label: "Schedule",
      base: base ? base.scheduleLabel : null,
      target: target.scheduleLabel,
      changed: differs(base?.scheduleLabel, target.scheduleLabel),
    },
    {
      label: "Cost per run",
      base: base ? cost(base) : null,
      target: cost(target),
      changed: differs(base?.costPerRunUsd, target.costPerRunUsd),
    },
    {
      label: "Limits",
      base: base ? limits(base) : null,
      target: limits(target),
      changed: differs(base?.limits, target.limits),
    },
    {
      label: "Deliverable",
      base: base ? deliverable(base) : null,
      target: deliverable(target),
      changed: differs(base?.deliverable, target.deliverable),
    },
  ];
}

export interface VersionCompareProps {
  base: VersionCard | null;
  target: VersionCard;
  changeReason: VersionCard["changeReason"];
}

export function VersionCompare({ base, target, changeReason }: VersionCompareProps) {
  const rows = rowsFor(base, target);
  const baseHeading = base ? (base.status === "ACTIVE" ? "Now" : `Version ${base.version}`) : null;
  const targetHeading = targetCardHeading({ changeReason, status: target.status, version: target.version });

  return (
    <Card className="gap-0 py-0">
      <dl className="flex flex-col">
        <div className="hidden gap-6 px-6 pt-5 pb-3 sm:grid sm:grid-cols-[168px_minmax(0,1fr)_minmax(0,1fr)]">
          <span />
          <span className="text-footnote font-semibold text-muted-foreground">
            {baseHeading ?? "—"}
            {base ? <span className="metric ml-1.5 font-normal">v{base.version}</span> : null}
          </span>
          <span className="text-footnote font-semibold text-foreground">
            {targetHeading}
            <span className="metric ml-1.5 font-normal text-muted-foreground">v{target.version}</span>
          </span>
        </div>

        {rows.map((row) => (
          <div
            key={row.label}
            className="relative grid gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-[168px_minmax(0,1fr)_minmax(0,1fr)] sm:px-6 sm:py-5 [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:inset-x-5 [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:h-px [&:not(:first-child)]:before:bg-border sm:[&:not(:first-child)]:before:inset-x-6"
          >
            <dt className="text-footnote font-medium text-muted-foreground sm:pt-0.5">{row.label}</dt>
            {base ? (
              <dd className="text-[15px] text-pretty text-muted-foreground">
                <span className="text-footnote mb-1 block font-medium text-tertiary sm:hidden">
                  {baseHeading} · before
                </span>
                {row.base}
              </dd>
            ) : null}
            <dd className="text-[15px] text-pretty text-foreground">
              {base ? (
                <span className="text-footnote mb-1 block font-medium text-tertiary sm:hidden">
                  {targetHeading} · after
                </span>
              ) : null}
              {row.target}
              {row.changed ? (
                <span className="text-caption mt-1.5 flex items-center gap-1.5 font-medium text-muted-foreground">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                  Changed
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
