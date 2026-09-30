import { db } from "@/server/db";
import { AppError, errorMessage, isAppError } from "@/server/errors";
import { assertOrgActive, assertWithinBudget, redactAndClip } from "@/server/security";
import { buildRequestTrace, buildResponseTrace, recordModelCall, type RequestTrace, type ResponseTrace } from "./persist";
import { computeCostUsd, priceFor } from "./pricing";
import { toProviderAppError } from "./provider-errors";
import { createAiSdkProvider } from "./providers/ai-sdk";
import { mockProvider } from "./providers/mock";
import { MOCK_TIER_MODELS, getStatus, isSimulated, routeTier } from "./registry";
import type {
  CallMeta,
  CallTracking,
  GenerateObjectRequest,
  GenerateObjectResult,
  GenerateTextRequest,
  GenerateTextResult,
  Llm,
  ModelProvider,
  ModelTier,
  ModelUsage,
  ProviderId,
  TierRoute,
} from "./types";

export type * from "./types";

// ModelCall.request / .response trace shapes, re-exported for the demo seed so seeded traces match live ones.
export { buildRequestTrace, buildResponseTrace } from "./persist";
export { isProviderSetupFailure } from "./provider-errors";

/**
 * The demo workspace is Simulated by definition, whatever keys the server has. Its seeded workers run on a schedule
 * and anyone can sign into it, so without this the first key someone puts in .env would start paying for demo runs
 * they never asked for (CLAUDE.md rule 6: never spend the user's money by surprise).
 */
async function isDemoOrg(organizationId: string | null | undefined): Promise<boolean> {
  if (!organizationId) return false;
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { isDemo: true } });
  return org?.isDemo === true;
}

/** Whether this workspace's model calls and tools are simulated: no live provider, or it is the demo workspace. */
export async function isOrgSimulated(organizationId: string | null | undefined): Promise<boolean> {
  return isSimulated() || (await isDemoOrg(organizationId));
}

const PROVIDERS: Readonly<Record<ProviderId, ModelProvider>> = {
  anthropic: createAiSdkProvider("anthropic"),
  openai: createAiSdkProvider("openai"),
  google: createAiSdkProvider("google"),
  mock: mockProvider,
};

const NO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0 };

/** Provider detail kept for operators (ModelCall.error, AppError.details) — never shown to a tenant. */
const MAX_PROVIDER_DETAIL_CHARS = 500;

/** Failed structured-output attempts still consumed tokens; repair.ts passes them along in AppError.details. */
function failureDetails(e: unknown): { usage: ModelUsage; text?: string } {
  const details = isAppError(e) ? (e.details as { usage?: Partial<ModelUsage>; text?: unknown } | undefined) : undefined;
  const usage = details?.usage;
  return {
    usage:
      typeof usage?.inputTokens === "number" && typeof usage.outputTokens === "number"
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : NO_USAGE,
    text: typeof details?.text === "string" ? details.text : undefined,
  };
}

/**
 * Provider SDK errors carry request ids, URLs, sometimes an echoed prompt fragment and even the API key
 * ("Incorrect API key provided: sk-…"). That text is for operators, so it goes to `details.providerMessage` and to
 * the ModelCall.error column (scrubbed); the AppError MESSAGE — which reaches tenants — is one sentence we wrote,
 * naming the fix ("Anthropic rejected the API key — check ANTHROPIC_API_KEY …", F-009). The live adapter already
 * throws those; this is the backstop for anything that escapes it.
 */
function toAppError(e: unknown, route: TierRoute, tier: ModelTier): AppError {
  if (isAppError(e)) return e;
  if (route.provider === "mock") {
    // Simulated mode runs our own deterministic producers — a crash there is a bug, not a provider outage.
    return new AppError("INTERNAL", `Simulated model call failed: ${errorMessage(e)}`);
  }
  return toProviderAppError(e, { provider: route.provider, model: route.model, tier });
}

/** What lands in ModelCall.error: the human line plus the scrubbed provider detail, for operators. */
function errorForTrace(failure: AppError, raw: unknown): string {
  const { providerMessage, statusCode } = (failure.details ?? {}) as { providerMessage?: unknown; statusCode?: unknown };
  const status = typeof statusCode === "number" ? `HTTP ${statusCode}: ` : "";
  const detail =
    typeof providerMessage === "string" && providerMessage
      ? `${status}${providerMessage}`
      : redactAndClip(errorMessage(raw), MAX_PROVIDER_DETAIL_CHARS);
  return detail && detail !== failure.message ? `${failure.message} — ${detail}` : failure.message;
}

/**
 * Backstop for money and for the operator kill switch (F-004): the actions that spend already check these,
 * but every LIVE call passes through here, so a path that forgot to check cannot spend anyway. Simulated
 * calls cost nothing and are never blocked, which keeps the whole product usable without API keys.
 */
async function assertMaySpend(tracking: CallTracking, simulated: boolean): Promise<void> {
  if (simulated || !tracking.organizationId) return;
  await assertOrgActive(tracking.organizationId);
  await assertWithinBudget(tracking.organizationId);
}

/**
 * Shared call pipeline: route → provider call → measure latency → price → persist (ModelCall + usage).
 * A failed call is persisted with `error` and surfaces as an AppError; the mock is never a fallback for it.
 */
async function execute<R extends { usage: ModelUsage }>(args: {
  tier: ModelTier;
  tracking: CallTracking;
  request: RequestTrace;
  call: (provider: ModelProvider, model: string) => Promise<R>;
  response: (result: R) => ResponseTrace;
}): Promise<{ result: R; meta: CallMeta }> {
  const { tier, tracking } = args;
  let route = routeTier(tier);
  if (route.provider !== "mock" && (await isDemoOrg(tracking.organizationId))) {
    route = { provider: "mock", model: MOCK_TIER_MODELS[tier] };
  }
  const simulated = route.provider === "mock";
  const price = priceFor(route.provider, route.model, tier);
  await assertMaySpend(tracking, simulated);
  const startedAt = Date.now();
  const base = { tracking, provider: route.provider, model: route.model, tier, simulated, request: args.request };

  let result: R;
  try {
    result = await args.call(PROVIDERS[route.provider], route.model);
  } catch (e) {
    const { usage, text } = failureDetails(e);
    const failure = toAppError(e, route, tier);
    await recordModelCall({
      ...base,
      usage,
      costUsd: computeCostUsd(price, usage.inputTokens, usage.outputTokens),
      latencyMs: Date.now() - startedAt,
      response: text !== undefined ? buildResponseTrace({ text }) : undefined,
      error: errorForTrace(failure, e),
    });
    throw failure;
  }

  const latencyMs = Date.now() - startedAt;
  const costUsd = computeCostUsd(price, result.usage.inputTokens, result.usage.outputTokens);
  const modelCallId = await recordModelCall({
    ...base,
    usage: result.usage,
    costUsd,
    latencyMs,
    response: args.response(result),
  });

  return {
    result,
    meta: {
      provider: route.provider,
      model: route.model,
      tier,
      usage: result.usage,
      costUsd,
      latencyMs,
      simulated,
      ...(modelCallId ? { modelCallId } : {}),
    },
  };
}

export const llm: Llm = {
  async generateText(req: GenerateTextRequest, tracking: CallTracking): Promise<GenerateTextResult> {
    const { result, meta } = await execute({
      tier: req.tier,
      tracking,
      request: buildRequestTrace({
        system: req.system,
        messages: req.messages,
        tools: (req.tools ?? []).map((t) => t.name),
      }),
      call: (provider, model) => provider.generateText(model, req),
      response: (r) => buildResponseTrace({ text: r.text, toolCalls: r.toolCalls, finishReason: r.finishReason }),
    });
    return { ...meta, text: result.text, toolCalls: result.toolCalls, finishReason: result.finishReason };
  },

  async generateObject<T>(req: GenerateObjectRequest<T>, tracking: CallTracking): Promise<GenerateObjectResult<T>> {
    const { result, meta } = await execute({
      tier: req.tier,
      tracking,
      request: buildRequestTrace({ system: req.system, prompt: req.prompt, schemaName: req.schemaName }),
      call: (provider, model) => provider.generateObject<T>(model, req),
      response: (r) => buildResponseTrace({ object: r.object }),
    });
    return { ...meta, object: result.object };
  },

  status: getStatus,

  isSimulated,

  route: routeTier,

  priceFor,

  /** Priced at the tier's CURRENT route, so estimates match what a run would actually be charged (reference price when simulated). */
  estimateCostUsd(tier: ModelTier, inputTokens: number, outputTokens: number): number {
    const route = routeTier(tier);
    return computeCostUsd(priceFor(route.provider, route.model, tier), inputTokens, outputTokens);
  },
};
