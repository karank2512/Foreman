"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate, formatUsd, formatUsdPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dayLabelStep } from "../_lib/chart-days";

export interface UsageChartProps {
  /** One entry per calendar day, oldest first, zero-filled (`date` = yyyy-MM-dd). */
  byDay: Array<{ date: string; modelCostUsd: number; toolCostUsd: number }>;
  className?: string;
}

type Point = UsageChartProps["byDay"][number] & { label: string; totalCostUsd: number };

const AXIS_TICK = { fill: "var(--chart-axis)", fontSize: 12 } as const;
/** The chart margins and y-axis width below; the plot is what is left of the container for the day labels. */
const MARGIN = { top: 8, right: 4, bottom: 0, left: -12 } as const;
const Y_AXIS_WIDTH = 56;

/** Local-day parse: `new Date("2026-09-12")` would be UTC midnight and shift a day in western time zones. */
function localDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function shortDay(key: string): string {
  return formatDate(localDay(key)).replace(/, \d{4}$/, "");
}

function LegendDot({ className }: { className: string }) {
  return <span className={cn("size-2 rounded-full", className)} aria-hidden="true" />;
}

/** Daily cost: tool fees on the baseline, model time stacked on top. Hover a day for the split. */
export function UsageChart({ byDay, className }: UsageChartProps) {
  const data = useMemo<Point[]>(
    () => byDay.map((d) => ({ ...d, label: shortDay(d.date), totalCostUsd: d.modelCostUsd + d.toolCostUsd })),
    [byDay],
  );
  const max = Math.max(0, ...data.map((d) => d.totalCostUsd));
  // Measured so the day labels thin out on a phone instead of running together; 0 until the first measure.
  const [width, setWidth] = useState(0);
  const tickEvery = dayLabelStep(data.length, width - Y_AXIS_WIDTH - MARGIN.left - MARGIN.right);

  return (
    <div className={cn("space-y-4", className)}>
      <ul className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1 text-footnote text-muted-foreground" aria-label="Legend">
        <li className="flex items-center gap-2">
          <LegendDot className="bg-chart-1" />
          Model time
        </li>
        <li className="flex items-center gap-2">
          <LegendDot className="bg-chart-2" />
          Tool fees
        </li>
      </ul>

      <div
        className="h-64 w-full sm:h-72"
        role="img"
        aria-label="Daily cost, model time stacked on tool fees, oldest to newest"
      >
        <ResponsiveContainer width="100%" height="100%" onResize={(w) => setWidth(w)}>
          <BarChart
            data={data}
            margin={MARGIN}
            barCategoryGap={data.length > 31 ? "14%" : "26%"}
          >
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="label"
              interval={tickEvery - 1}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              minTickGap={16}
            />
            <YAxis
              domain={[0, max > 0 ? "auto" : 1]}
              tickCount={4}
              tickFormatter={(v: number) => (v === 0 ? "$0" : formatUsd(v))}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={Y_AXIS_WIDTH}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)", opacity: 0.7 }}
              content={({ active, payload }) => {
                const d = active && payload && payload.length > 0 ? (payload[0].payload as Point) : null;
                if (!d) return null;
                return (
                  <div className="material-thick min-w-48 rounded-lg px-3.5 py-2.5 shadow-popover">
                    <p className="text-footnote text-muted-foreground">{formatDate(localDay(d.date))}</p>
                    <p className="metric mt-0.5 text-[15px] font-semibold text-foreground">
                      {d.totalCostUsd > 0 ? formatUsdPrecise(d.totalCostUsd) : "No usage"}
                    </p>
                    {d.totalCostUsd > 0 ? (
                      <dl className="text-footnote mt-2 space-y-1">
                        <div className="flex items-center justify-between gap-6">
                          <dt className="flex items-center gap-2 text-muted-foreground">
                            <LegendDot className="bg-chart-1" />
                            Model time
                          </dt>
                          <dd className="metric text-foreground">{formatUsdPrecise(d.modelCostUsd)}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-6">
                          <dt className="flex items-center gap-2 text-muted-foreground">
                            <LegendDot className="bg-chart-2" />
                            Tool fees
                          </dt>
                          <dd className="metric text-foreground">{formatUsdPrecise(d.toolCostUsd)}</dd>
                        </div>
                      </dl>
                    ) : null}
                  </div>
                );
              }}
            />
            <Bar dataKey="toolCostUsd" stackId="cost" fill="var(--chart-2)" maxBarSize={28} isAnimationActive={false} />
            <Bar
              dataKey="modelCostUsd"
              stackId="cost"
              fill="var(--chart-1)"
              radius={[6, 6, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
