/**
 * How this window's spend compares with the one before it. Pure, so the wording rules can be tested without
 * a database: the page only turns the result into a sentence.
 */

export type SpendDirection = "up" | "down" | "flat";

export type SpendTrend =
  /** Nothing at all was spent in the previous window, so there is no comparison to make. */
  | { kind: "none" }
  /** Within a hair of the previous window. */
  | { kind: "flat" }
  /** A percentage that means something: the previous window was a real amount and the change is modest. */
  | { kind: "percent"; direction: Exclude<SpendDirection, "flat">; ratio: number }
  /**
   * The previous window was pennies or the change is a multiple, where "↑ 491%" reads as an alarm and says
   * less than the amount itself. The page renders "from $0.33 in the previous 7 days" instead.
   */
  | { kind: "amount"; direction: Exclude<SpendDirection, "flat">; previousUsd: number };

/** Below a cent the previous window is a rounding error, not a baseline. */
const PENNIES_USD = 0.01;
/** Past a tripling the percentage stops helping; say the amount. */
const MAX_PERCENT_RATIO = 2;
/** Under half a percent either way is "the same". */
const FLAT_RATIO = 0.005;

export function spendTrend(currentUsd: number, previousUsd: number): SpendTrend {
  if (!(previousUsd > 0)) return { kind: "none" };
  const ratio = (currentUsd - previousUsd) / previousUsd;
  if (Math.abs(ratio) < FLAT_RATIO) return { kind: "flat" };
  const direction = ratio > 0 ? "up" : "down";
  if (previousUsd < PENNIES_USD || Math.abs(ratio) > MAX_PERCENT_RATIO) {
    return { kind: "amount", direction, previousUsd };
  }
  return { kind: "percent", direction, ratio: Math.abs(ratio) };
}
