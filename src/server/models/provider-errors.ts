import { AppError, errorMessage } from "@/server/errors";
import { redactAndClip } from "@/server/security/redact";
import { providerEnvVar, providerLabel, tierEnvVar, type LiveProviderId } from "./registry";
import type { ModelTier, ModelUsage } from "./types";

/**
 * Turns a failed live provider call into one sentence a workspace owner can act on ("Anthropic rejected the API
 * key — check ANTHROPIC_API_KEY …"). Self-hosters bring their own keys, so the first live run is usually where a
 * typo'd key, an empty balance or a retired model id shows up — it must read like a note from a contractor, not a
 * stack trace. The message never contains provider text (which can echo the key); that goes to `providerMessage`
 * in the details, scrubbed, for the ModelCall trace. Classification is structural — no SDK import needed.
 */

export type ProviderFailureKind =
  | "auth"
  | "permission"
  | "quota"
  | "rate_limit"
  | "model_not_found"
  | "bad_request"
  | "overloaded"
  | "timeout"
  | "network"
  | "bad_response"
  | "refused"
  | "unknown";

export interface ProviderFailureContext {
  provider: LiveProviderId;
  model: string;
  tier: ModelTier;
}

/** Operator detail kept on AppError.details (and in ModelCall.error) — never in the tenant-visible message. */
export interface ProviderFailureDetails {
  provider: LiveProviderId;
  model: string;
  kind: ProviderFailureKind;
  statusCode?: number;
  providerMessage?: string;
  /** Tokens already consumed (a refusal, or a failed structured-output correction). */
  usage?: ModelUsage;
}

const MAX_PROVIDER_DETAIL_CHARS = 500;
const BAD_KEY_TEXT = /API[ _]KEY[ _](?:not valid|invalid|expired)|reported as leaked|unregistered callers/i;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  statusCode?: unknown;
  responseBody?: unknown;
  cause?: unknown;
}

function asErrorLike(e: unknown): ErrorLike | null {
  return e !== null && typeof e === "object" ? (e as ErrorLike) : null;
}

function statusOf(e: unknown): number | undefined {
  const status = asErrorLike(e)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/** Message + raw body: providers put the machine-readable reason ("insufficient_quota", "API_KEY_INVALID") in the body. */
function providerText(e: unknown): string {
  const err = asErrorLike(e);
  const body = typeof err?.responseBody === "string" ? err.responseBody : "";
  return `${errorMessage(e)} ${body}`;
}

function isTimeout(e: unknown, depth = 0): boolean {
  const err = asErrorLike(e);
  if (!err || depth > 3) return false;
  if (err.name === "TimeoutError") return true;
  return isTimeout(err.cause, depth + 1);
}

/** Socket, DNS and TLS failures (a proxy re-signing traffic shows up as a certificate error). */
const NETWORK_ERROR_CODE =
  /^(?:ECONN[A-Z]+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/;

/**
 * The request never reached the provider. Only errors that look like it: fetch wraps the socket error in a
 * `TypeError("fetch failed")`, and the AI SDK wraps that again ("Cannot connect to API"). An SDK validation error or
 * a bug of ours has no status either, and must not send the user off to check their firewall.
 */
function isNetworkFailure(e: unknown, depth = 0): boolean {
  const err = asErrorLike(e);
  if (!err || depth > 3) return false;
  if (typeof err.code === "string" && NETWORK_ERROR_CODE.test(err.code)) return true;
  const message = typeof err.message === "string" ? err.message : "";
  if (err.name === "TypeError" && /fetch failed|network/i.test(message)) return true;
  if (/cannot connect to api/i.test(message)) return true;
  return isNetworkFailure(err.cause, depth + 1);
}

/**
 * Out of credits / over a spending cap — as opposed to a per-minute rate limit. Retrying cannot help, so the retry
 * policy skips these. OpenAI: 429 `insufficient_quota`. Anthropic: 400 "credit balance is too low" or "reached your
 * specified API usage limits". (Gemini uses the word "quota" for ordinary per-minute limits too, so its 429s stay
 * rate limits.)
 */
export function isQuotaExhausted(e: unknown): boolean {
  const status = statusOf(e);
  if (status === undefined) return false;
  const text = providerText(e);
  if (status === 402) return true;
  if (status === 429) return /insufficient_quota/i.test(text);
  if (status === 400 || status === 403) return /credit balance|usage limits?\b|insufficient_quota|billing (?:hard )?limit/i.test(text);
  return false;
}

export function classifyProviderFailure(e: unknown): ProviderFailureKind {
  const status = statusOf(e);
  if (status === undefined) {
    if (isTimeout(e)) return "timeout";
    return isNetworkFailure(e) ? "network" : "unknown";
  }

  const text = providerText(e);
  if (isQuotaExhausted(e)) return "quota";
  if (status === 401) return "auth";
  // Gemini answers a bad key with 400 INVALID_ARGUMENT / API_KEY_INVALID, and a revoked or leaked one with 403.
  if ((status === 400 || status === 403) && BAD_KEY_TEXT.test(text)) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "model_not_found";
  if (status === 400 && /model/i.test(text) && /does not exist|not found|unknown model|invalid model/i.test(text)) return "model_not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  if (status === 408) return "timeout";
  if (status >= 200 && status < 300) return "bad_response";
  if (status >= 400 && status < 500) return "bad_request";
  return "unknown";
}

/** The one sentence shown on the run (and in the smoke test). No provider text, no key material. */
export function providerFailureMessage(kind: ProviderFailureKind, ctx: ProviderFailureContext, statusCode?: number): string {
  const label = providerLabel(ctx.provider);
  const keyVar = providerEnvVar(ctx.provider);
  const tierVar = tierEnvVar(ctx.tier);
  const http = statusCode !== undefined ? `HTTP ${statusCode}` : "no response";
  switch (kind) {
    case "auth":
      return `${label} rejected the API key — check ${keyVar} in your .env, then restart Foreman.`;
    case "permission":
      return `${label} refused access to "${ctx.model}" (${http}) — make sure the key in ${keyVar} can use that model, or pick another one with ${tierVar}="${ctx.provider}:<model-id>".`;
    case "quota":
      return `${label} says this API key is out of credits or over its spending limit — add credits or raise the limit in your ${label} account, then try again.`;
    case "rate_limit":
      return `${label} is rate-limiting this API key (${http}) — wait a minute and try again; if it keeps happening, check the key's rate limits and billing.`;
    case "model_not_found":
      return `${label} does not recognise the model "${ctx.model}" — set ${tierVar}="${ctx.provider}:<model-id>" in your .env to a model your key can use.`;
    case "bad_request":
      return `${label} rejected the request (${http}) — "${ctx.model}" may not support something Foreman sent. The provider's reason is saved with this model call.`;
    case "overloaded":
      return `${label} is overloaded or temporarily unavailable (${http}) — try again in a few minutes.`;
    case "timeout":
      return `${label} did not answer in time — try again; if it keeps happening, "${ctx.model}" may be overloaded.`;
    case "network":
      return `Couldn't reach ${label} — check that this server can reach the internet (proxy, firewall or DNS).`;
    case "bad_response":
      return `${label} sent a response Foreman could not read (${http}) — try again; if it keeps happening, check that "${ctx.model}" is a ${label} chat model.`;
    case "refused":
      return `${label} declined this step (its safety filter flagged the request) — rephrase the job, or route the ${ctx.tier} tier to another model with ${tierVar}.`;
    case "unknown":
      return `${label} could not complete the request (${http}).`;
  }
}

/** A provider failure as the MODEL_ERROR the rest of the app handles. AppErrors (ours) pass through untouched. */
export function toProviderAppError(e: unknown, ctx: ProviderFailureContext): AppError {
  if (e instanceof AppError) return e;
  const kind = classifyProviderFailure(e);
  const statusCode = statusOf(e);
  const details: ProviderFailureDetails = {
    provider: ctx.provider,
    model: ctx.model,
    kind,
    ...(statusCode !== undefined ? { statusCode } : {}),
    providerMessage: redactAndClip(errorMessage(e), MAX_PROVIDER_DETAIL_CHARS),
  };
  return new AppError("MODEL_ERROR", providerFailureMessage(kind, ctx, statusCode), details);
}

/**
 * Failures that are about how Foreman is set up (the key, its credits, its access, a model id), not about the job:
 * retrying cannot fix them, and they say nothing about the worker's quality.
 */
export const PROVIDER_SETUP_FAILURES: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  "auth",
  "permission",
  "quota",
  "model_not_found",
]);

export function isProviderSetupFailure(e: unknown): boolean {
  if (!(e instanceof AppError) || e.code !== "MODEL_ERROR") return false;
  const kind = (e.details as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && PROVIDER_SETUP_FAILURES.has(kind as ProviderFailureKind);
}

/** The model answered, but only with a safety refusal (Anthropic `refusal`, OpenAI/Gemini content filters). */
export function refusalError(ctx: ProviderFailureContext, usage: ModelUsage): AppError {
  const details: ProviderFailureDetails = { provider: ctx.provider, model: ctx.model, kind: "refused", usage };
  return new AppError("MODEL_ERROR", providerFailureMessage("refused", ctx), details);
}
