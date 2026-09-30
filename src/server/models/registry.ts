import { config } from "@/server/config";
import type { ModelStatus, ModelTier, ProviderId, TierRoute } from "./types";

/**
 * Provider availability + tier routing.
 *
 * Everything here is computed lazily from `process.env` on every call — never cached — so tests (and a restarted
 * server with a new .env) see changes immediately. Model-provider keys are env-only in Phase 1.
 */

export type LiveProviderId = Exclude<ProviderId, "mock">;

/** Routing preference: the first AVAILABLE provider in this order serves every tier without an override. */
export const LIVE_PROVIDER_ORDER: readonly LiveProviderId[] = ["anthropic", "openai", "google"];

export const MODEL_TIERS: readonly ModelTier[] = ["fast", "standard", "reasoning"];

const PROVIDER_INFO: Readonly<Record<ProviderId, { label: string; envVar: string | null }>> = {
  anthropic: { label: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  openai: { label: "OpenAI", envVar: "OPENAI_API_KEY" },
  google: { label: "Google Gemini", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
  mock: { label: "Simulated (built-in)", envVar: null },
};

/**
 * Default model per tier and provider. Checked 2026-09-30 against each provider's own docs:
 *  - Anthropic: the bundled Claude API reference (claude-haiku-4-5 / claude-sonnet-5 / claude-opus-5 are current ids).
 *  - OpenAI: the gpt-5 / gpt-5-mini snapshots shut down on 2026-12-11, so the defaults are the GA GPT-6 models.
 *  - Google: the 2.5 models are only served to projects that already used them; new keys need the 3.x models
 *    Google recommends for new projects (both stable, not preview).
 * Pin anything else with MODEL_TIER_<TIER>="<provider>:<model-id>"; `npm run smoke:live` checks the ids with one tiny call each.
 */
export const DEFAULT_TIER_MODELS: Readonly<Record<LiveProviderId, Readonly<Record<ModelTier, string>>>> = {
  anthropic: { fast: "claude-haiku-4-5", standard: "claude-sonnet-5", reasoning: "claude-opus-5" },
  openai: { fast: "gpt-6-luna", standard: "gpt-6.1-sol", reasoning: "gpt-6.1-sol" },
  google: { fast: "gemini-3.5-flash-lite", standard: "gemini-3.8-flash", reasoning: "gemini-3.8-flash" },
};

/** Model ids reported by the mock provider. Priced at the tier's reference model (see pricing.ts). */
export const MOCK_TIER_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: "mock-fast",
  standard: "mock-standard",
  reasoning: "mock-reasoning",
};

const TIER_ENV_VARS: Readonly<Record<ModelTier, string>> = {
  fast: "MODEL_TIER_FAST",
  standard: "MODEL_TIER_STANDARD",
  reasoning: "MODEL_TIER_REASONING",
};

export function providerLabel(id: ProviderId): string {
  return PROVIDER_INFO[id].label;
}

/** The env var that holds a live provider's key ("ANTHROPIC_API_KEY"). */
export function providerEnvVar(id: LiveProviderId): string {
  return PROVIDER_INFO[id].envVar ?? "";
}

/** The env var that pins a tier to a model ("MODEL_TIER_STANDARD"). */
export function tierEnvVar(tier: ModelTier): string {
  return TIER_ENV_VARS[tier];
}

function isLiveProviderId(value: string): value is LiveProviderId {
  return (LIVE_PROVIDER_ORDER as readonly string[]).includes(value);
}

/** The provider's API key from the environment; whitespace-only / empty counts as unset. */
export function providerApiKey(id: LiveProviderId): string | undefined {
  const envVar = PROVIDER_INFO[id].envVar;
  const value = envVar ? process.env[envVar]?.trim() : undefined;
  return value ? value : undefined;
}

export function isProviderAvailable(id: ProviderId): boolean {
  if (id === "mock") return true;
  if (config.forceSimulated) return false;
  return providerApiKey(id) !== undefined;
}

export function availableLiveProviders(): LiveProviderId[] {
  return LIVE_PROVIDER_ORDER.filter(isProviderAvailable);
}

export function isSimulated(): boolean {
  return availableLiveProviders().length === 0;
}

// route() runs on every model call and cost estimate; warn once per distinct problem instead of flooding the log.
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[models] ${message}`);
}

/** Test hook: forget which override warnings were already printed. */
export function resetRouteWarnings(): void {
  warned.clear();
}

function parseTierOverride(raw: string): { provider: string; model: string } {
  const separator = raw.indexOf(":");
  return {
    provider: separator > 0 ? raw.slice(0, separator).trim().toLowerCase() : "",
    model: separator > 0 ? raw.slice(separator + 1).trim() : "",
  };
}

/** Parse MODEL_TIER_<TIER>="<provider>:<model>". Invalid or unusable overrides are ignored (with a warning). */
function tierOverride(tier: ModelTier, available: readonly LiveProviderId[]): TierRoute | null {
  const envVar = TIER_ENV_VARS[tier];
  const raw = process.env[envVar]?.trim();
  if (!raw) return null;

  const { provider, model } = parseTierOverride(raw);
  if (!isLiveProviderId(provider) || !model) {
    warnOnce(
      `Ignoring ${envVar}="${raw}": expected "<provider>:<model>" with provider one of ${LIVE_PROVIDER_ORDER.join(", ")}.`,
    );
    return null;
  }
  if (!available.includes(provider)) {
    warnOnce(
      `Ignoring ${envVar}="${raw}": ${providerLabel(provider)} is not available (set ${PROVIDER_INFO[provider].envVar}).`,
    );
    return null;
  }
  return { provider, model };
}

export function routeTier(tier: ModelTier): TierRoute {
  const available = availableLiveProviders();
  // Simulated mode: overrides are inert by design (no warning — FORCE_SIMULATED with overrides set is a normal setup).
  if (available.length === 0) return { provider: "mock", model: MOCK_TIER_MODELS[tier] };

  const override = tierOverride(tier, available);
  if (override) return override;

  const provider = available[0];
  return { provider, model: DEFAULT_TIER_MODELS[provider][tier] };
}

/**
 * The model each tier would run on `provider` if it served that tier: the MODEL_TIER_* override when it names this
 * provider, otherwise the default. Used by `npm run smoke:live` to check every id a key would be asked to serve.
 */
export function providerTierModels(provider: LiveProviderId): Record<ModelTier, string> {
  const models = { ...DEFAULT_TIER_MODELS[provider] };
  for (const tier of MODEL_TIERS) {
    const override = parseTierOverride(process.env[TIER_ENV_VARS[tier]]?.trim() ?? "");
    if (override.provider === provider && override.model) models[tier] = override.model;
  }
  return models;
}

export function getStatus(): ModelStatus {
  const ids: ProviderId[] = [...LIVE_PROVIDER_ORDER, "mock"];
  return {
    mode: isSimulated() ? "simulated" : "live",
    providers: ids.map((id) => ({
      id,
      label: PROVIDER_INFO[id].label,
      available: isProviderAvailable(id),
      envVar: PROVIDER_INFO[id].envVar,
    })),
    tiers: {
      fast: routeTier("fast"),
      standard: routeTier("standard"),
      reasoning: routeTier("reasoning"),
    },
  };
}
