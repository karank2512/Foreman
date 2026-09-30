import type { ModelPrice, ModelTier, ProviderId } from "./types";

/**
 * Central price table, USD per 1M tokens, keyed "<provider>:<model>".
 *
 * VERIFY BEFORE BILLING — last checked 2026-09-30.
 *  - Anthropic: the bundled Claude API reference (standard first-party rates).
 *  - OpenAI: developers.openai.com/api/docs/pricing, Standard tier, short context, uncached input.
 *  - Google: ai.google.dev/gemini-api/docs/pricing, paid tier, prompts ≤ 200k tokens (output includes thinking).
 * Providers change prices without notice; treat these as COGS estimates, not invoices. They also drive the
 * workspace budget guard, so where a published price is a time-limited promotion we use the regular price.
 */
export const PRICING_VERIFIED_ON = "2026-09-30";

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic
  "anthropic:claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "anthropic:claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "anthropic:claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic:claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "anthropic:claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic:claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic:claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic:claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "anthropic:claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
  "anthropic:claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  // OpenAI
  "openai:gpt-6-astra": { inputPerMTok: 10, outputPerMTok: 50 },
  "openai:gpt-6.1-sol": { inputPerMTok: 2, outputPerMTok: 10 },
  "openai:gpt-6-sol": { inputPerMTok: 2, outputPerMTok: 10 },
  "openai:gpt-6-luna": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "openai:gpt-5.6-sol": { inputPerMTok: 4, outputPerMTok: 20 },
  "openai:gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12 },
  "openai:gpt-5.6-luna": { inputPerMTok: 0.2, outputPerMTok: 1.2 },
  // Shut down 2026-12-11; kept so existing MODEL_TIER_* pins and past usage still price correctly.
  "openai:gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "openai:gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2 },
  "openai:gpt-5-nano": { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  // Google. gemini-3.8-flash is $0.75 / $3.75 until 2026-12-31 and $1.50 / $7.50 from 2027-01-01 (regular price used).
  "google:gemini-3.8-flash": { inputPerMTok: 1.5, outputPerMTok: 7.5 },
  "google:gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9 },
  "google:gemini-3.5-flash-lite": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "google:gemini-3.1-pro-preview": { inputPerMTok: 2, outputPerMTok: 12 },
  // Only served to projects that already used them (no shutdown date announced).
  "google:gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "google:gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "google:gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
};

/**
 * Reference model per tier. Used to price (a) the mock provider, so Simulated-mode cost pages look realistic,
 * and (b) any live model missing from the table (e.g. a MODEL_TIER_* override we have never heard of).
 */
export const TIER_REFERENCE_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: "anthropic:claude-haiku-4-5",
  standard: "anthropic:claude-sonnet-5",
  reasoning: "anthropic:claude-opus-5",
};

export function tierReferencePrice(tier: ModelTier): ModelPrice {
  return MODEL_PRICES[TIER_REFERENCE_MODELS[tier]];
}

/** Dated / aliased snapshot ids ("claude-haiku-4-5-20251001", "gpt-5-2025-08-07", "…-latest") price like their base model. */
const SNAPSHOT_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

export function priceFor(provider: ProviderId, model: string, tier: ModelTier): ModelPrice {
  const exact = MODEL_PRICES[`${provider}:${model}`];
  if (exact) return exact;
  const base = model.replace(SNAPSHOT_SUFFIX, "");
  if (base !== model) {
    const snapshot = MODEL_PRICES[`${provider}:${base}`];
    if (snapshot) return snapshot;
  }
  return tierReferencePrice(tier);
}

/** Pure cost math. Rounded to micro-dollars — the precision of the Decimal(12, 6) columns it is stored in. */
export function computeCostUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  const input = Math.max(0, Number.isFinite(inputTokens) ? inputTokens : 0);
  const output = Math.max(0, Number.isFinite(outputTokens) ? outputTokens : 0);
  const usd = (input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
