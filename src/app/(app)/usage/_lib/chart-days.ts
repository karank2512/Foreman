import type { UsagePageData } from "@/server/queries/usage";
import type { UsageChartProps } from "../_components/usage-chart";

/**
 * The chart is a client component, so whatever the page hands it is serialized into the browser payload.
 * The query's day rows also carry `billableUsd` (cost × the platform margin); passing them through whole would
 * ship the markup to every customer's browser even though the page no longer shows it (design-detail-16).
 * Pick only what the chart draws.
 */
export function chartDays(byDay: UsagePageData["byDay"]): UsageChartProps["byDay"] {
  return byDay.map(({ date, modelCostUsd, toolCostUsd }) => ({ date, modelCostUsd, toolCostUsd }));
}

/** Room one "Sep 21" label needs with a gap after it. */
const MIN_LABEL_SPACING_PX = 64;
/** At most this many day labels, however wide the card. */
const MAX_LABELS = 8;

/**
 * Label every Nth day. A fixed N (a day count over eight) ran the labels together on a phone ("Sep 21Sep 22…")
 * and clipped the last one, so the step also grows until the labels fit the plot. With no width yet — on the
 * server, before the first measure — the desktop cadence applies.
 */
export function dayLabelStep(dayCount: number, plotWidthPx: number): number {
  const fit = plotWidthPx > 0 ? Math.max(1, Math.floor(plotWidthPx / MIN_LABEL_SPACING_PX)) : MAX_LABELS;
  return Math.max(1, Math.ceil(dayCount / Math.min(MAX_LABELS, fit)));
}
