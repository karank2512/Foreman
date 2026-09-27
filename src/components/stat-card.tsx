import type { ReactNode } from "react";
import type { IconProp } from "@/components/icon-slot";
import { Sparkline } from "@/components/sparkline";
import { cn } from "@/lib/utils";

export interface StatTrend {
  /** Arrow direction. Omit when you only want the sparkline. */
  direction?: "up" | "down" | "flat";
  /** Short caption after the arrow: "12% vs last month", "3 more than last month". */
  label?: string;
  /**
   * Whether the movement is good news. Defaults: up = positive, down = negative, flat = neutral —
   * override for metrics where up is bad (cost, failure rate).
   */
  tone?: "positive" | "negative" | "neutral";
  /** Optional series drawn as a sparkline (oldest first). Keep it to one stat per strip — spend. */
  values?: number[];
}

export interface StatProps {
  /** Short noun phrase: "Active workers", "Spend this month". */
  label: string;
  /** Pre-formatted headline value (use the helpers in `@/lib/format`). */
  value: ReactNode;
  /** One quiet line of context under the value. */
  hint?: ReactNode;
  /**
   * Accepted for source compatibility and deliberately not rendered: an icon on every stat is one of the tells
   * this design removes. Numbers carry the hierarchy.
   */
  icon?: IconProp;
  trend?: StatTrend;
  className?: string;
}

export type StatCardProps = StatProps;

const TREND_TONE = {
  positive: "text-success",
  negative: "text-danger",
  neutral: "text-muted-foreground",
} as const;

const TREND_ARROW = { up: "↑", down: "↓", flat: "→" } as const;

function defaultTone(direction: StatTrend["direction"]): NonNullable<StatTrend["tone"]> {
  if (direction === "up") return "positive";
  if (direction === "down") return "negative";
  return "neutral";
}

/**
 * One cell of a `StatStrip`: quiet label, big number, one optional line of context.
 *
 * The number is the point of the cell, so it wraps rather than truncates, and in the 2×2 strip under `md`
 * (about 140px of content per cell) the sparkline steps aside — "$…" next to an intact trend line is the wrong
 * thing to keep.
 */
export function Stat({ label, value, hint, trend, className }: StatProps) {
  const tone = trend ? (trend.tone ?? defaultTone(trend.direction)) : "neutral";
  const arrow = trend?.direction ? TREND_ARROW[trend.direction] : null;
  const hasTrendLine = Boolean(trend && (trend.direction || trend.label));

  return (
    <div data-slot="stat" className={cn("flex flex-col gap-1.5 bg-card p-5 md:p-6", className)}>
      <p className="truncate text-footnote font-medium text-muted-foreground">{label}</p>

      <div className="flex items-end justify-between gap-4">
        <div className="text-metric min-w-0 [overflow-wrap:anywhere] text-foreground">{value}</div>
        {trend?.values && trend.values.length > 1 ? (
          <Sparkline values={trend.values} className="mb-1.5 hidden h-7 w-20 shrink-0 md:inline-block" />
        ) : null}
      </div>

      {hasTrendLine || hint ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-footnote text-muted-foreground">
          {hasTrendLine ? (
            <span className={TREND_TONE[tone]}>
              {arrow ? <span aria-hidden="true">{arrow} </span> : null}
              {trend?.label}
            </span>
          ) : null}
          {hint ? <span className="min-w-0">{hint}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

export interface StatStripProps {
  /** Two to four stats. More than four stops being scannable — move the rest into the page. */
  children: ReactNode;
  className?: string;
}

/**
 * The page's KPI row: one white card divided by hairlines, four across on desktop and 2×2 below 768px.
 * Wrap `<Stat>` cells — the gap-px trick draws the dividers, so no cell needs a border of its own.
 */
export function StatStrip({ children, className }: StatStripProps) {
  return (
    <div
      data-slot="stat-strip"
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-card md:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Standalone version of `Stat` for the few places a single KPI sits on its own. Prefer `StatStrip` + `Stat`:
 * four identical tiles side by side is exactly the equal-weight layout this design removes.
 */
export function StatCard({ className, ...props }: StatCardProps) {
  return <Stat {...props} className={cn("rounded-xl shadow-card", className)} />;
}
