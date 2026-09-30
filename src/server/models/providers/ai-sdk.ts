import type { FinishReason, LanguageModel, LanguageModelUsage, ToolSet } from "ai";
import { AppError } from "@/server/errors";
import { toModelMessages } from "../messages";
import { refusalError, toProviderAppError, type ProviderFailureContext } from "../provider-errors";
import { isProviderAvailable, providerApiKey, providerEnvVar, providerLabel, type LiveProviderId } from "../registry";
import { formatIssues, generateObjectWithReask, repairJsonText, validateObject, type ObjectAttempt } from "../repair";
import { withTransientRetry } from "../retry";
import type {
  GenerateObjectRequest,
  GenerateTextRequest,
  GenerateTextResult,
  ModelProvider,
  ModelTier,
  ModelUsage,
} from "../types";

/**
 * The one live adapter, parameterized by provider id (Vercel AI SDK v5).
 *
 * - The SDK is imported lazily: Simulated mode (and every test) never pays for loading it.
 * - Tools are declared WITHOUT `execute`, so the SDK returns the tool calls and stops after one step — the runtime
 *   owns the agent loop, permissions and approvals.
 * - `maxRetries: 0`: retries are ours (see retry.ts).
 * - Never enable OpenAI `strictJsonSchema` or Anthropic `structuredOutputMode: "outputFormat"` — our Zod schemas use
 *   optionals/defaults those modes reject. Provider defaults (JSON tool / non-strict schema) are what we want.
 * - Every failure leaves here as a MODEL_ERROR with a human message (provider-errors.ts); the raw provider text
 *   stays in the details for the ModelCall trace.
 */

/** Non-streaming default; leaves room for thinking tokens on models that think by default. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
/**
 * Every default model reasons before it answers (Claude Sonnet/Opus 5 think by default, GPT-6 and Gemini 3 are
 * reasoning models) and the provider cap covers reasoning AND answer. Callers size `maxOutputTokens` for the
 * visible answer — a 600-token chat reply would otherwise come back empty once the model thinks — so an explicit
 * cap gets this much room on top. It is a ceiling, not a spend: only tokens actually generated are billed.
 */
export const REASONING_HEADROOM_TOKENS = 6_000;
/** A hung request must not pin a run forever. A timeout counts as transient and is retried. */
const CALL_TIMEOUT_MS = 240_000;

/**
 * Claude models whose safety classifiers can decline a request (HTTP 200, stop_reason "refusal"). `fallbacks:
 * "default"` lets the API re-run a declined request on Anthropic's recommended fallback model inside the same call
 * (at that model's rates — Opus 4.8 for cyber-category refusals, the same price as Opus 5).
 */
const SERVER_FALLBACK_MODELS = /^claude-(?:opus-5|fable-5-1)(?:-\d{8})?$/;

/** Anthropic does not bill a request its safety classifiers decline before producing any output. */
function billableRefusalUsage(id: LiveProviderId, usage: ModelUsage): ModelUsage {
  return id === "anthropic" && usage.outputTokens === 0 ? { inputTokens: 0, outputTokens: 0 } : usage;
}

export function effectiveMaxOutputTokens(requested: number | undefined): number {
  return requested === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : requested + REASONING_HEADROOM_TOKENS;
}

/** Provider-specific request options (AI SDK `providerOptions`). */
export function providerOptionsFor(id: LiveProviderId, model: string): { anthropic: { fallbacks: "default" } } | undefined {
  if (id === "anthropic" && SERVER_FALLBACK_MODELS.test(model)) return { anthropic: { fallbacks: "default" } };
  return undefined;
}

/**
 * ANTHROPIC_BASE_URL means the API root WITHOUT /v1 to Anthropic's own SDKs and tools (shells running them often
 * export "https://api.anthropic.com"), but the AI SDK appends paths straight to it and expects "/v1" included — so an
 * inherited value would send every call to ".../messages" and 404. Accept both spellings; unset means the default.
 */
export function anthropicBaseURL(): string | undefined {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!raw) return undefined;
  return /\/v1$/.test(raw) ? raw : `${raw}/v1`;
}

async function languageModel(id: LiveProviderId, model: string, fetch?: typeof globalThis.fetch): Promise<LanguageModel> {
  const apiKey = providerApiKey(id);
  if (!apiKey) {
    throw new AppError("MODEL_ERROR", `${providerLabel(id)} has no API key — set ${providerEnvVar(id)} in your .env, then restart Foreman.`);
  }
  switch (id) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey, baseURL: anthropicBaseURL(), fetch })(model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey, fetch })(model);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey, fetch })(model);
    }
  }
}

/**
 * Gemini rejects a whole request whose function declarations use a string `format` other than "enum" / "date-time"
 * ("only 'enum' and 'date-time' are supported for STRING type") — and fetch_url's `url` is `format: "uri"`. The
 * hint is dropped for Gemini only; tools.invoke() still validates the input against the full Zod schema.
 */
export function withoutUnsupportedGeminiFormats(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutUnsupportedGeminiFormats);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // A string-valued "format" is the keyword; a property that happens to be named "format" is an object schema.
    if (key === "format" && typeof value === "string" && value !== "enum" && value !== "date-time") continue;
    out[key] = withoutUnsupportedGeminiFormats(value);
  }
  return out;
}

/** Retries (ours), then any provider failure becomes a MODEL_ERROR the workspace owner can act on. */
async function callProvider<T>(ctx: ProviderFailureContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await withTransientRetry(fn);
  } catch (e) {
    throw toProviderAppError(e, ctx);
  }
}

export function mapFinishReason(reason: FinishReason, hasToolCalls: boolean): GenerateTextResult["finishReason"] {
  if (hasToolCalls || reason === "tool-calls") return "tool_calls";
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "other";
}

/**
 * Billable usage. Gemini reports thinking tokens outside `outputTokens` (but bills them as output), so prefer
 * `totalTokens - inputTokens` whenever it is larger.
 */
export function toUsage(usage: LanguageModelUsage | undefined): ModelUsage {
  const inputTokens = usage?.inputTokens ?? 0;
  const reported = usage?.outputTokens ?? 0;
  const derived = usage?.totalTokens !== undefined ? usage.totalTokens - inputTokens : 0;
  return { inputTokens, outputTokens: Math.max(reported, derived, 0) };
}

/** OpenAI requires ^[a-zA-Z0-9_-]{1,64}$ for schema names; call sites use dotted names like "scoping.spec". */
function providerSchemaName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "output";
}

function hasIssues(value: unknown): value is { issues: unknown[] } {
  return value !== null && typeof value === "object" && Array.isArray((value as { issues?: unknown }).issues);
}

/** Turn the SDK's NoObjectGeneratedError into feedback the model can act on in the re-ask. */
function describeObjectFailure(error: { message: string; cause?: unknown; finishReason?: FinishReason }): string {
  if (error.finishReason === "length") {
    return "- (root): the response was cut off before the JSON was complete — respond more concisely";
  }
  // TypeValidationError.cause is whatever our validator returned: a ZodError (has issues) or a normalize() error.
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 3 && cause !== null && typeof cause === "object"; depth++) {
    if (hasIssues(cause)) return formatIssues(cause as Parameters<typeof formatIssues>[0]);
    cause = (cause as { cause?: unknown }).cause;
  }
  const name = (error.cause as { name?: unknown } | undefined)?.name;
  if (typeof name === "string" && name.includes("JSONParse")) return "- (root): the response was not valid JSON";
  return `- (root): ${error.message}`;
}

export interface AiSdkProviderOptions {
  /** Test seam: supply the SDK model (e.g. `MockLanguageModelV2`) instead of building one from the env key. */
  resolveModel?: (model: string) => LanguageModel | Promise<LanguageModel>;
  /** Test seam: the HTTP client handed to the provider SDK (default: global fetch). Exercises the real wire format. */
  fetch?: typeof globalThis.fetch;
}

export function createAiSdkProvider(id: LiveProviderId, options: AiSdkProviderOptions = {}): ModelProvider {
  const resolveModel = options.resolveModel ?? ((model: string) => languageModel(id, model, options.fetch));
  const context = (model: string, tier: ModelTier): ProviderFailureContext => ({ provider: id, model, tier });
  return {
    id,

    isAvailable: () => isProviderAvailable(id),

    async generateText(model: string, req: GenerateTextRequest) {
      const ai = await import("ai");
      const ctx = context(model, req.tier);
      const languageModelInstance = await resolveModel(model);
      const providerOptions = providerOptionsFor(id, model);

      const toolSet: ToolSet = {};
      for (const spec of req.tools ?? []) {
        const inputSchema =
          id === "google"
            ? ai.jsonSchema(withoutUnsupportedGeminiFormats(ai.zodSchema(spec.inputSchema).jsonSchema) as Parameters<typeof ai.jsonSchema>[0])
            : spec.inputSchema;
        toolSet[spec.name] = ai.tool({ description: spec.description, inputSchema });
      }
      const hasTools = Object.keys(toolSet).length > 0;

      const result = await callProvider(ctx, () =>
        ai.generateText({
          model: languageModelInstance,
          system: req.system,
          messages: toModelMessages(req.messages),
          // Some providers reject an empty tools array, so only send tools when there are any.
          ...(hasTools ? { tools: toolSet, toolChoice: "auto" as const } : {}),
          maxOutputTokens: effectiveMaxOutputTokens(req.maxOutputTokens),
          // Sampling parameters: the SDK drops them (with a warning) for models that reject them.
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        }),
      );

      // Malformed calls (unknown tool, unparsable input) are passed through untouched: tools.invoke() validates the
      // input and answers with an error tool message, which lets the agent correct itself.
      const toolCalls = result.toolCalls.map((call) => ({ id: call.toolCallId, name: call.toolName, input: call.input }));
      const usage = toUsage(result.usage);
      // A bare safety refusal must not look like an empty-but-successful answer.
      if (result.finishReason === "content-filter" && toolCalls.length === 0 && result.text.trim() === "") {
        throw refusalError(ctx, billableRefusalUsage(id, usage));
      }
      return {
        text: result.text,
        toolCalls,
        finishReason: mapFinishReason(result.finishReason, toolCalls.length > 0),
        usage,
      };
    },

    async generateObject<T>(model: string, req: GenerateObjectRequest<T>) {
      const ai = await import("ai");
      const ctx = context(model, req.tier);
      const languageModelInstance = await resolveModel(model);
      const providerOptions = providerOptionsFor(id, model);

      // The provider gets the JSON Schema derived from the Zod schema, but VALIDATION is ours: normalize → Zod.
      // When it fails the SDK runs `experimental_repairText` (null stripping) and validates once more.
      const schema = ai.jsonSchema<T>(() => ai.zodSchema(req.schema).jsonSchema, {
        validate: (raw) => {
          const validated = validateObject<T>(raw, req);
          return validated.ok ? { success: true, value: validated.object } : { success: false, error: validated.error };
        },
      });

      const attempt = async (prompt: string): Promise<ObjectAttempt<T>> => {
        try {
          const result = await withTransientRetry(() =>
            ai.generateObject({
              model: languageModelInstance,
              system: req.system,
              prompt,
              schema,
              schemaName: providerSchemaName(req.schemaName),
              maxOutputTokens: effectiveMaxOutputTokens(req.maxOutputTokens),
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              ...(providerOptions ? { providerOptions } : {}),
              maxRetries: 0,
              experimental_repairText: repairJsonText,
              abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            }),
          );
          return { ok: true, object: result.object, usage: toUsage(result.usage) };
        } catch (e) {
          if (ai.NoObjectGeneratedError.isInstance(e)) {
            // Re-asking a refusal only buys a second refusal.
            if (e.finishReason === "content-filter") throw refusalError(ctx, billableRefusalUsage(id, toUsage(e.usage)));
            return { ok: false, issues: describeObjectFailure(e), text: e.text, usage: toUsage(e.usage) };
          }
          throw toProviderAppError(e, ctx);
        }
      };

      return generateObjectWithReask(req, attempt);
    },
  };
}
