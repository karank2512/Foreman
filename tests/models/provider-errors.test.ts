import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import {
  classifyProviderFailure,
  isProviderSetupFailure,
  isQuotaExhausted,
  providerFailureMessage,
  toProviderAppError,
} from "@/server/models/provider-errors";
import { anthropicBaseURL, effectiveMaxOutputTokens, providerOptionsFor } from "@/server/models/providers/ai-sdk";
import { isTransientError } from "@/server/models/retry";
import { withModelEnv } from "./helpers";

/** Shape of the AI SDK's APICallError, built structurally (the classifier never imports the SDK). */
const apiError = (statusCode: number, message: string, responseBody = "") =>
  Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseBody });

describe("models: provider failure classification (pure)", () => {
  it("maps status codes and provider wording to an actionable kind", () => {
    expect(classifyProviderFailure(apiError(401, "invalid x-api-key"))).toBe("auth");
    expect(classifyProviderFailure(apiError(400, "API key not valid. Please pass a valid API key."))).toBe("auth");
    expect(classifyProviderFailure(apiError(403, "Your API key was reported as leaked. Please use another API key."))).toBe("auth");
    expect(classifyProviderFailure(apiError(403, "Your API key does not have permission to use the specified resource."))).toBe("permission");
    expect(classifyProviderFailure(apiError(404, "model: claude-opus-9"))).toBe("model_not_found");
    expect(classifyProviderFailure(apiError(400, "The requested model 'gpt-9' does not exist."))).toBe("model_not_found");
    expect(classifyProviderFailure(apiError(400, "temperature: not supported for this model"))).toBe("bad_request");
    expect(classifyProviderFailure(apiError(413, "Request too large"))).toBe("bad_request");
    expect(classifyProviderFailure(apiError(429, "Rate limit reached for requests"))).toBe("rate_limit");
    expect(classifyProviderFailure(apiError(429, "quota", '{"error":{"code":"insufficient_quota"}}'))).toBe("quota");
    expect(classifyProviderFailure(apiError(400, "Your credit balance is too low to access the Anthropic API."))).toBe("quota");
    expect(classifyProviderFailure(apiError(400, "You have reached your specified API usage limits."))).toBe("quota");
    expect(classifyProviderFailure(apiError(529, "Overloaded"))).toBe("overloaded");
    expect(classifyProviderFailure(apiError(503, "unavailable"))).toBe("overloaded");
    expect(classifyProviderFailure(apiError(200, "Invalid JSON response"))).toBe("bad_response");
    expect(classifyProviderFailure(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyProviderFailure(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toBe("network");
  });

  it("calls it a network failure only when the request really never reached the provider", () => {
    // What the AI SDK throws when fetch cannot connect: its wrapper, around fetch's TypeError, around the socket error.
    const unreachable = Object.assign(new Error("Cannot connect to API: fetch failed"), {
      name: "AI_APICallError",
      cause: new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), { code: "ENOTFOUND" }) }),
    });
    expect(classifyProviderFailure(unreachable)).toBe("network");
    expect(classifyProviderFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }))).toBe("network");
    expect(classifyProviderFailure(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }))).toBe("network");
    // No status and nothing network-like: an SDK validation error or a bug of ours. Not the user's firewall.
    expect(classifyProviderFailure(new Error("boom"))).toBe("unknown");
    expect(classifyProviderFailure(Object.assign(new Error("Invalid argument for parameter tools"), { name: "AI_InvalidArgumentError" }))).toBe("unknown");
    expect(classifyProviderFailure(new TypeError("Cannot read properties of undefined (reading 'text')"))).toBe("unknown");
  });

  it("marks setup failures — key, credits, access, model id — and nothing else", () => {
    const ctx = { provider: "anthropic", model: "claude-haiku-4-5", tier: "fast" } as const;
    expect(isProviderSetupFailure(toProviderAppError(apiError(401, "invalid x-api-key"), ctx))).toBe(true);
    expect(isProviderSetupFailure(toProviderAppError(apiError(400, "Your credit balance is too low"), ctx))).toBe(true);
    expect(isProviderSetupFailure(toProviderAppError(apiError(403, "not allowed"), ctx))).toBe(true);
    expect(isProviderSetupFailure(toProviderAppError(apiError(404, "model: claude-9"), ctx))).toBe(true);
    expect(isProviderSetupFailure(toProviderAppError(apiError(429, "Rate limit reached"), ctx))).toBe(false);
    expect(isProviderSetupFailure(toProviderAppError(apiError(529, "Overloaded"), ctx))).toBe(false);
    expect(isProviderSetupFailure(new AppError("INTERNAL", "x", { kind: "auth" }))).toBe(false);
    expect(isProviderSetupFailure(new Error("x"))).toBe(false);
  });

  it("quota exhaustion is never retried; ordinary rate limits still are", () => {
    const quota = apiError(429, "You exceeded your current quota", '{"error":{"type":"insufficient_quota"}}');
    expect(isQuotaExhausted(quota)).toBe(true);
    expect(isTransientError(quota)).toBe(false);
    expect(isTransientError(apiError(429, "Rate limit reached"))).toBe(true);
    // Gemini says "quota" for per-minute limits too — those stay retryable.
    expect(isTransientError(apiError(429, "You exceeded your current quota, please check your plan and billing details."))).toBe(true);
  });

  it("messages name the provider, the env var to fix, and never the provider's own text", () => {
    const ctx = { provider: "openai", model: "gpt-6.1-sol", tier: "standard" } as const;
    expect(providerFailureMessage("auth", ctx)).toBe("OpenAI rejected the API key — check OPENAI_API_KEY in your .env, then restart Foreman.");
    expect(providerFailureMessage("model_not_found", ctx)).toContain('MODEL_TIER_STANDARD="openai:<model-id>"');
    expect(providerFailureMessage("rate_limit", ctx, 429)).toContain("(HTTP 429)");
    expect(providerFailureMessage("unknown", ctx)).toBe("OpenAI could not complete the request (no response).");

    const error = toProviderAppError(apiError(401, "Incorrect API key provided: sk-proj-abcdefghijklmnop"), ctx);
    expect(error).toBeInstanceOf(AppError);
    expect(error.message).not.toContain("sk-proj");
    expect(error.details).toMatchObject({ provider: "openai", model: "gpt-6.1-sol", kind: "auth", statusCode: 401 });
    expect((error.details as { providerMessage: string }).providerMessage).toBe("Incorrect API key provided: [redacted]");
    // Our own AppErrors pass through untouched.
    const ours = new AppError("MODEL_ERROR", "already human");
    expect(toProviderAppError(ours, ctx)).toBe(ours);
  });
});

describe("models: live request settings (pure)", () => {
  it("an explicit output cap gets reasoning headroom; no cap means the non-streaming default", () => {
    expect(effectiveMaxOutputTokens(undefined)).toBe(16_000);
    expect(effectiveMaxOutputTokens(600)).toBeGreaterThan(600 + 4_000);
  });

  it("server-side refusal fallbacks only for the Claude models that document them", () => {
    expect(providerOptionsFor("anthropic", "claude-opus-5")).toEqual({ anthropic: { fallbacks: "default" } });
    expect(providerOptionsFor("anthropic", "claude-fable-5-1")).toEqual({ anthropic: { fallbacks: "default" } });
    expect(providerOptionsFor("anthropic", "claude-opus-5-5")).toBeUndefined();
    expect(providerOptionsFor("anthropic", "claude-sonnet-5")).toBeUndefined();
    expect(providerOptionsFor("anthropic", "claude-haiku-4-5")).toBeUndefined();
    expect(providerOptionsFor("openai", "gpt-6.1-sol")).toBeUndefined();
  });

  it("ANTHROPIC_BASE_URL is accepted with or without /v1", async () => {
    await withModelEnv({}, () => expect(anthropicBaseURL()).toBeUndefined());
    await withModelEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, () => expect(anthropicBaseURL()).toBe("https://api.anthropic.com/v1"));
    await withModelEnv({ ANTHROPIC_BASE_URL: "https://proxy.test/v1/" }, () => expect(anthropicBaseURL()).toBe("https://proxy.test/v1"));
  });
});
