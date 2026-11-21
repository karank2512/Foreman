/**
 * Small-sample statistics for `scripts/bench-cost.ts`. Pure and deterministic: the bootstrap uses a fixed-seed
 * generator, so the same runs always give the same interval.
 */

export interface Interval {
  low: number;
  high: number;
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

export function mean(values: readonly number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  return finite.length === 0 ? null : finite.reduce((s, v) => s + v, 0) / finite.length;
}

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** (after − before) / before × 100, one decimal; null when there is nothing to compare. */
export function pctChange(after: number | null, before: number | null): number | null {
  if (after === null || before === null || before <= 0) return null;
  return round(((after - before) / before) * 100, 1);
}

/** Two-sided 97.5% quantiles of Student's t for 1–29 degrees of freedom (MAX_RUNS is 20). */
const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069,
  2.064, 2.06, 2.056, 2.052, 2.048, 2.045,
];

/** 95% confidence interval of a mean (Student's t). Needs at least two values; identical values give a zero width. */
export function tInterval95(values: readonly number[]): Interval | null {
  const n = values.length;
  if (n < 2 || n - 1 > T_975.length) return null;
  const m = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1);
  const half = T_975[n - 2] * Math.sqrt(variance / n);
  return { low: m - half, high: m + half };
}

/** mulberry32: a tiny seeded PRNG, so the bootstrap is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_RESAMPLES = 10_000;
const BOOTSTRAP_SEED = 20_261_003;

/**
 * 95% percentile-bootstrap interval of Σnumerator / Σdenominator over pairs resampled with replacement (a ratio of
 * means, kept paired). Needs at least two pairs.
 */
export function bootstrapRatio95(pairs: ReadonlyArray<{ numerator: number; denominator: number }>, resamples = BOOTSTRAP_RESAMPLES): Interval | null {
  const n = pairs.length;
  if (n < 2) return null;
  const random = prng(BOOTSTRAP_SEED);
  const ratios: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const pick = pairs[Math.floor(random() * n)];
      num += pick.numerator;
      den += pick.denominator;
    }
    if (den > 0) ratios.push(num / den);
  }
  if (ratios.length === 0) return null;
  ratios.sort((x, y) => x - y);
  const at = (q: number) => ratios[Math.min(ratios.length - 1, Math.max(0, Math.floor(q * (ratios.length - 1))))];
  return { low: at(0.025), high: at(0.975) };
}
