import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { llm } from "@/server/models";
import { REASONING_HEADROOM_TOKENS, createAiSdkProvider } from "@/server/models/providers/ai-sdk";
import type { LiveProviderId } from "@/server/models/registry";
import type { ChatMessage, GenerateObjectRequest, GenerateTextRequest } from "@/server/models/types";
import { createTestOrg } from "../helpers/factory";
import { searchTool, withModelEnv } from "./helpers";

/**
 * The BYOK path on the wire, with no network: the real AI SDK provider clients get a fake `fetch`, so these tests
 * pin what actually leaves the process (endpoint, auth header, model id, tool / structured-output shape) and how
 * each provider's real error bodies come back to the workspace owner.
 */

const KEYS = {
  anthropic: { ANTHROPIC_API_KEY: "sk-ant-test-0000000000" },
  openai: { OPENAI_API_KEY: "sk-test-openai-0000000000" },
  google: { GOOGLE_GENERATIVE_AI_API_KEY: "AIzaTest000000000000" },
} as const;

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

/** A fetch that records every request and answers from the script, in order; running out fails loudly. */
function fakeFetch(...script: Reply[]) {
  const calls: Captured[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    const reply = script[Math.min(calls.length - 1, script.length - 1)];
    if (!reply) throw new Error("fake fetch: no scripted reply");
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const neverMock = () => {
  throw new Error("the mock producer must never run on the live path");
};

function textRequest(over: Partial<GenerateTextRequest> = {}): GenerateTextRequest {
  const messages: ChatMessage[] = [{ role: "user", content: "Find Series B rounds" }];
  return { tier: "standard", system: "You are Alex.", messages, mock: neverMock, ...over };
}

const Spec = z.object({ title: z.string(), note: z.string().optional(), questions: z.array(z.string()) });
function objectRequest(over: Partial<GenerateObjectRequest<z.infer<typeof Spec>>> = {}): GenerateObjectRequest<z.infer<typeof Spec>> {
  return { tier: "standard", prompt: "Scope this job", schema: Spec, schemaName: "scoping.spec", mock: neverMock, ...over };
}

async function live<T>(
  provider: LiveProviderId,
  script: Reply[],
  run: (p: ReturnType<typeof createAiSdkProvider>) => Promise<T>,
  env: Parameters<typeof withModelEnv>[0] = {},
) {
  const { fetch, calls } = fakeFetch(...script);
  const provider_ = createAiSdkProvider(provider, { fetch });
  const outcome = await withModelEnv({ ...KEYS[provider], ...env }, () =>
    run(provider_).then((value) => ({ value }), (error: unknown) => ({ error })),
  );
  return { ...outcome, calls } as { value?: T; error?: unknown; calls: Captured[] };
}

function expectModelError(error: unknown, message: RegExp) {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe("MODEL_ERROR");
  expect((error as AppError).message).toMatch(message);
  // Never the key, never the provider's own text.
  for (const key of Object.values(KEYS).flatMap((k) => Object.values(k))) expect((error as AppError).message).not.toContain(key);
}

// ── Anthropic ─────────────────────────────────────────────────────────────────────────────────────────────────────

const anthropicMessage = (content: unknown[], stop_reason = "end_turn", usage = { input_tokens: 120, output_tokens: 30 }) => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage,
});
const anthropicError = (status: number, type: string, message: string, headers?: Record<string, string>): Reply => ({
  status,
  headers,
  body: { type: "error", error: { type, message } },
});

describe("live providers on the wire: Anthropic", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the Messages API request with x-api-key, the model id, tools and headroom — and maps tool calls + usage", async () => {
    const { value, calls } = await live(
      "anthropic",
      [{ body: anthropicMessage([{ type: "text", text: "Searching." }, { type: "tool_use", id: "toolu_01", name: "web_search", input: { query: "acme" } }], "tool_use") }],
      (p) => p.generateText("claude-sonnet-5", textRequest({ tools: [searchTool], maxOutputTokens: 600, temperature: 0.2 })),
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.method).toBe("POST");
    expect(call.headers["x-api-key"]).toBe(KEYS.anthropic.ANTHROPIC_API_KEY);
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 600 + REASONING_HEADROOM_TOKENS,
      system: [{ type: "text", text: "You are Alex." }],
      tool_choice: { type: "auto" },
      tools: [{ name: "web_search", description: "Search the web", input_schema: { type: "object" } }],
    });
    // Claude 5 models reject sampling parameters with a 400; the SDK strips them, and no server fallback on Sonnet.
    expect(call.body.temperature).toBeUndefined();
    expect(call.body.fallbacks).toBeUndefined();

    expect(value).toEqual({
      text: "Searching.",
      toolCalls: [{ id: "toolu_01", name: "web_search", input: { query: "acme" } }],
      finishReason: "tool_calls",
      usage: { inputTokens: 120, outputTokens: 30 },
    });
  });

  it("accepts ANTHROPIC_BASE_URL with or without /v1 (Anthropic tooling exports it without)", async () => {
    const cases: Array<[string, string]> = [
      ["https://api.anthropic.com", "https://api.anthropic.com/v1/messages"],
      ["https://gateway.example.com/anthropic/v1/", "https://gateway.example.com/anthropic/v1/messages"],
    ];
    for (const [baseUrl, expected] of cases) {
      const { calls } = await live(
        "anthropic",
        [{ body: anthropicMessage([{ type: "text", text: "ok" }]) }],
        (p) => p.generateText("claude-haiku-4-5", textRequest({ tier: "fast" })),
        { ANTHROPIC_BASE_URL: baseUrl },
      );
      expect(calls[0].url).toBe(expected);
    }
  });

  it("opts Claude Opus 5 into server-side refusal fallbacks", async () => {
    const { calls } = await live("anthropic", [{ body: anthropicMessage([{ type: "text", text: "Done." }]) }], (p) =>
      p.generateText("claude-opus-5", textRequest({ tier: "reasoning" })),
    );
    expect(calls[0].body).toMatchObject({ model: "claude-opus-5", fallbacks: "default", max_tokens: 16_000 });
    expect(calls[0].headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
  });

  it("structured output goes through a forced JSON tool and is validated by our schema", async () => {
    const { value, calls } = await live(
      "anthropic",
      [{ body: anthropicMessage([{ type: "tool_use", id: "toolu_09", name: "json", input: { title: "Spec", note: null, questions: ["q1"] } }], "tool_use") }],
      (p) => p.generateObject("claude-sonnet-5", objectRequest()),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      model: "claude-sonnet-5",
      tool_choice: { type: "tool", name: "json" },
      tools: [{ name: "json", input_schema: { type: "object", properties: { title: { type: "string" } } } }],
    });
    // null-valued optional repaired; usage mapped.
    expect(value).toEqual({ object: { title: "Spec", questions: ["q1"] }, usage: { inputTokens: 120, outputTokens: 30 } });
  });

  it("malformed structured output gets exactly one correction with the Zod issues", async () => {
    const { value, calls } = await live(
      "anthropic",
      [
        { body: anthropicMessage([{ type: "tool_use", id: "toolu_1", name: "json", input: { title: 7 } }], "tool_use") },
        { body: anthropicMessage([{ type: "tool_use", id: "toolu_2", name: "json", input: { title: "Fixed", questions: [] } }], "tool_use") },
      ],
      (p) => p.generateObject("claude-sonnet-5", objectRequest()),
    );
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].body.messages)).toContain("- title:");
    expect(value).toEqual({ object: { title: "Fixed", questions: [] }, usage: { inputTokens: 240, outputTokens: 60 } });
  });

  it("401: a clear 'rejected the API key' message, no retry, provider text kept for operators only", async () => {
    const { error, calls } = await live(
      "anthropic",
      [anthropicError(401, "authentication_error", `invalid x-api-key ${KEYS.anthropic.ANTHROPIC_API_KEY}`)],
      (p) => p.generateText("claude-haiku-4-5", textRequest({ tier: "fast" })),
    );
    expect(calls).toHaveLength(1);
    expectModelError(error, /^Anthropic rejected the API key — check ANTHROPIC_API_KEY/);
    const details = (error as AppError).details as Record<string, unknown>;
    expect(details).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5", kind: "auth", statusCode: 401 });
    expect(details.providerMessage).toContain("invalid x-api-key");
    expect(details.providerMessage).not.toContain(KEYS.anthropic.ANTHROPIC_API_KEY);
  });

  it("429: retried twice (honouring retry-after), then a rate-limit message", async () => {
    const { error, calls } = await live(
      "anthropic",
      [anthropicError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", { "retry-after": "0.01" })],
      (p) => p.generateText("claude-sonnet-5", textRequest()),
    );
    expect(calls).toHaveLength(3);
    expectModelError(error, /^Anthropic is rate-limiting this API key \(HTTP 429\)/);
  });

  it("an empty credit balance is a quota message, not a generic 400", async () => {
    const { error, calls } = await live(
      "anthropic",
      [anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")],
      (p) => p.generateText("claude-sonnet-5", textRequest()),
    );
    expect(calls).toHaveLength(1);
    expectModelError(error, /^Anthropic says this API key is out of credits/);
  });

  it("an unknown model id names the MODEL_TIER_* variable to fix", async () => {
    const { error } = await live("anthropic", [anthropicError(404, "not_found_error", "model: claude-opus-9")], (p) =>
      p.generateText("claude-opus-9", textRequest({ tier: "reasoning" })),
    );
    expectModelError(error, /does not recognise the model "claude-opus-9" — set MODEL_TIER_REASONING="anthropic:<model-id>"/);
  });

  it("529 overloaded is retried, then reported as a temporary outage", async () => {
    const { error, calls } = await live(
      "anthropic",
      [anthropicError(529, "overloaded_error", "Overloaded", { "retry-after": "0.01" })],
      (p) => p.generateText("claude-sonnet-5", textRequest()),
    );
    expect(calls).toHaveLength(3);
    expectModelError(error, /^Anthropic is overloaded or temporarily unavailable \(HTTP 529\)/);
  });

  it("a safety refusal is an explicit failure, not an empty answer — and a pre-output decline costs nothing", async () => {
    const { error } = await live(
      "anthropic",
      [{ body: anthropicMessage([], "refusal", { input_tokens: 80, output_tokens: 0 }) }],
      (p) => p.generateText("claude-opus-5", textRequest({ tier: "reasoning" })),
    );
    expectModelError(error, /^Anthropic declined this step/);
    expect((error as AppError).details).toMatchObject({ kind: "refused", usage: { inputTokens: 0, outputTokens: 0 } });
  });
});

// ── OpenAI ────────────────────────────────────────────────────────────────────────────────────────────────────────

const openaiResponse = (output: unknown[], usage = { input_tokens: 90, output_tokens: 40 }) => ({
  id: "resp_01",
  object: "response",
  created_at: 1_790_000_000,
  model: "gpt-6.1-sol",
  status: "completed",
  output,
  incomplete_details: null,
  usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens, output_tokens_details: { reasoning_tokens: 25 } },
});
const openaiText = (text: string) => ({ type: "message", role: "assistant", id: "msg_01", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const openaiError = (status: number, code: string, message: string): Reply => ({
  status,
  body: { error: { message, type: code, param: null, code } },
});

describe("live providers on the wire: OpenAI", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the Responses API with a Bearer key; function tools come back as tool calls", async () => {
    const { value, calls } = await live(
      "openai",
      [
        {
          body: openaiResponse([
            { type: "reasoning", id: "rs_01", summary: [] },
            { type: "function_call", id: "fc_01", call_id: "call_01", name: "web_search", arguments: '{"query":"acme"}', status: "completed" },
          ]),
        },
      ],
      (p) => p.generateText("gpt-6.1-sol", textRequest({ tools: [searchTool], maxOutputTokens: 600, temperature: 0.2 })),
    );
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.headers.authorization).toBe(`Bearer ${KEYS.openai.OPENAI_API_KEY}`);
    expect(call.body).toMatchObject({
      model: "gpt-6.1-sol",
      max_output_tokens: 600 + REASONING_HEADROOM_TOKENS,
      tool_choice: "auto",
      tools: [{ type: "function", name: "web_search", parameters: { type: "object" }, strict: false }],
    });
    // GPT-6 is a reasoning model: no sampling parameters, system prompt sent as a developer message.
    expect(call.body.temperature).toBeUndefined();
    expect(JSON.stringify(call.body.input)).toContain('"role":"developer"');

    expect(value).toMatchObject({
      text: "",
      toolCalls: [{ id: "call_01", name: "web_search", input: { query: "acme" } }],
      finishReason: "tool_calls",
      usage: { inputTokens: 90, outputTokens: 40 },
    });
  });

  it("structured output is a non-strict json_schema text format with an OpenAI-safe name", async () => {
    const { value, calls } = await live(
      "openai",
      [{ body: openaiResponse([openaiText('{"title":"Spec","questions":["a"]}')]) }],
      (p) => p.generateObject("gpt-6.1-sol", objectRequest()),
    );
    expect(calls[0].body).toMatchObject({
      model: "gpt-6.1-sol",
      text: { format: { type: "json_schema", name: "scoping_spec", strict: false, schema: { type: "object" } } },
    });
    expect(value?.object).toEqual({ title: "Spec", questions: ["a"] });
  });

  it("401: a clear key message that never echoes the key OpenAI quotes back", async () => {
    const { error, calls } = await live(
      "openai",
      [openaiError(401, "invalid_api_key", `Incorrect API key provided: ${KEYS.openai.OPENAI_API_KEY}.`)],
      (p) => p.generateText("gpt-6-luna", textRequest({ tier: "fast" })),
    );
    expect(calls).toHaveLength(1);
    expectModelError(error, /^OpenAI rejected the API key — check OPENAI_API_KEY/);
    expect(JSON.stringify((error as AppError).details)).not.toContain(KEYS.openai.OPENAI_API_KEY);
  });

  it("429 insufficient_quota is NOT retried and says the key is out of credits", async () => {
    const { error, calls } = await live(
      "openai",
      [openaiError(429, "insufficient_quota", "You exceeded your current quota, please check your plan and billing details.")],
      (p) => p.generateText("gpt-6.1-sol", textRequest()),
    );
    expect(calls).toHaveLength(1);
    expectModelError(error, /^OpenAI says this API key is out of credits or over its spending limit/);
  });

  it("an unreadable 200 body is reported as a bad response, not a crash", async () => {
    const { error, calls } = await live("openai", [{ body: "<html>gateway</html>" }], (p) => p.generateText("gpt-6.1-sol", textRequest()));
    expect(calls).toHaveLength(1);
    expectModelError(error, /^OpenAI sent a response Foreman could not read \(HTTP 200\)/);
  });
});

// ── Google Gemini ─────────────────────────────────────────────────────────────────────────────────────────────────

const geminiResponse = (parts: unknown[], finishReason = "STOP") => ({
  candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
  usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 40, totalTokenCount: 100 },
  modelVersion: "gemini-3.8-flash",
});
const geminiError = (status: number, grpc: string, message: string, reason?: string): Reply => ({
  status,
  body: { error: { code: status, message, status: grpc, ...(reason ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] } : {}) } },
});

describe("live providers on the wire: Google Gemini", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls generateContent with x-goog-api-key and bills thinking tokens as output", async () => {
    const { value, calls } = await live(
      "google",
      [{ body: geminiResponse([{ functionCall: { name: "web_search", args: { query: "acme" } }, thoughtSignature: "c2lnbmF0dXJl" }]) }],
      (p) => p.generateText("gemini-3.8-flash", textRequest({ tools: [searchTool], maxOutputTokens: 600 })),
    );
    const [call] = calls;
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(call.headers["x-goog-api-key"]).toBe(KEYS.google.GOOGLE_GENERATIVE_AI_API_KEY);
    expect(call.url).not.toContain("key=");
    expect(call.body).toMatchObject({
      generationConfig: { maxOutputTokens: 600 + REASONING_HEADROOM_TOKENS },
      systemInstruction: { parts: [{ text: "You are Alex." }] },
      tools: [{ functionDeclarations: [{ name: "web_search", description: "Search the web" }] }],
    });
    expect(value?.toolCalls).toEqual([{ id: expect.any(String), name: "web_search", input: { query: "acme" } }]);
    expect(value?.usage).toEqual({ inputTokens: 50, outputTokens: 50 });
  });

  it("drops string formats Gemini rejects from function declarations (fetch_url's url is format: uri)", async () => {
    const fetchUrlTool = { name: "fetch_url", description: "Fetch a page", inputSchema: z.object({ url: z.string().url(), when: z.iso.datetime().optional() }) };
    const { calls } = await live("google", [{ body: geminiResponse([{ text: "ok" }]) }], (p) =>
      p.generateText("gemini-3.8-flash", textRequest({ tools: [fetchUrlTool] })),
    );
    const declaration = (calls[0].body.tools as Array<{ functionDeclarations: Array<{ parameters: { properties: Record<string, Record<string, unknown>> } }> }>)[0]
      .functionDeclarations[0];
    expect(declaration.parameters.properties.url).toEqual({ type: "string" });
    expect(declaration.parameters.properties.when.format).toBe("date-time");
  });

  it("replays our tool history to Gemini 3 without tripping thought-signature validation", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Find Series B rounds" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "web_search", input: { query: "acme" } }] },
      { role: "tool", toolCallId: "call_1", toolName: "web_search", output: { results: [] } },
    ];
    const { calls } = await live("google", [{ body: geminiResponse([{ text: "Nothing found." }]) }], (p) =>
      p.generateText("gemini-3.8-flash", textRequest({ messages: history, tools: [searchTool] })),
    );
    const contents = calls[0].body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const modelTurn = contents.find((c) => c.role === "model");
    expect(modelTurn?.parts[0]).toMatchObject({ functionCall: { name: "web_search" }, thoughtSignature: expect.any(String) });
  });

  it("structured output uses responseMimeType + responseSchema", async () => {
    const { value, calls } = await live("google", [{ body: geminiResponse([{ text: '{"title":"Spec","questions":[]}' }]) }], (p) =>
      p.generateObject("gemini-3.8-flash", objectRequest()),
    );
    expect(calls[0].body).toMatchObject({ generationConfig: { responseMimeType: "application/json", responseSchema: { type: "object" } } });
    expect(value?.object).toEqual({ title: "Spec", questions: [] });
  });

  it("prose instead of JSON: one correction, then a MODEL_ERROR that keeps both attempts' usage", async () => {
    const { error, calls } = await live("google", [{ body: geminiResponse([{ text: "Sure! Here is the spec you asked for." }]) }], (p) =>
      p.generateObject("gemini-3.8-flash", objectRequest()),
    );
    expect(calls).toHaveLength(2);
    expectModelError(error, /could not produce a valid scoping\.spec after one correction/);
    expect((error as AppError).details).toMatchObject({ usage: { inputTokens: 100, outputTokens: 100 } });
  });

  it("Gemini's 400 API_KEY_INVALID is recognised as a bad key", async () => {
    const { error, calls } = await live(
      "google",
      [geminiError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", "API_KEY_INVALID")],
      (p) => p.generateText("gemini-3.5-flash-lite", textRequest({ tier: "fast" })),
    );
    expect(calls).toHaveLength(1);
    expectModelError(error, /^Google Gemini rejected the API key — check GOOGLE_GENERATIVE_AI_API_KEY/);
  });

  it("429 RESOURCE_EXHAUSTED is retried, then reported as a rate limit", async () => {
    const { error, calls } = await live(
      "google",
      [{ ...geminiError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details."), headers: { "retry-after": "0.01" } }],
      (p) => p.generateText("gemini-3.8-flash", textRequest()),
    );
    expect(calls).toHaveLength(3);
    expectModelError(error, /^Google Gemini is rate-limiting this API key \(HTTP 429\)/);
  });

  it("a SAFETY block with no content is a refusal, not an empty answer (the tokens Google reports stay billed)", async () => {
    const { error } = await live("google", [{ body: geminiResponse([], "SAFETY") }], (p) => p.generateText("gemini-3.8-flash", textRequest()));
    expectModelError(error, /^Google Gemini declined this step/);
    expect((error as AppError).details).toMatchObject({ kind: "refused", usage: { inputTokens: 50, outputTokens: 50 } });
  });
});

describe("live providers: network failures", () => {
  it("a connection failure is retried, then says the provider could not be reached", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), { code: "ENOTFOUND" }) });
    });
    const provider = createAiSdkProvider("anthropic", { fetch: fetch as unknown as typeof globalThis.fetch });
    const error = await withModelEnv({ ...KEYS.anthropic }, () => provider.generateText("claude-sonnet-5", textRequest()).catch((e: unknown) => e));
    expect(fetch).toHaveBeenCalledTimes(3);
    expectModelError(error, /^Couldn't reach Anthropic/);
  }, 15_000);
});

describe("live providers: through llm (the path every run takes)", () => {
  let t: Awaited<ReturnType<typeof createTestOrg>>;
  beforeAll(async () => {
    t = await createTestOrg("models-live");
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t.cleanup();
  });

  it("the run sees the human message; ModelCall.error keeps status + scrubbed provider text; reported spend is recorded", async () => {
    const tracking = { organizationId: t.organization.id, purpose: "test.live", persist: true };
    const spy = vi.spyOn(globalThis, "fetch");

    spy.mockResolvedValueOnce(
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEYS.anthropic.ANTHROPIC_API_KEY}` } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const auth = await withModelEnv({ ...KEYS.anthropic }, () => llm.generateText(textRequest({ tier: "fast" }), tracking).catch((e: unknown) => e));
    expectModelError(auth, /^Anthropic rejected the API key — check ANTHROPIC_API_KEY/);

    // A refusal part-way through the answer: the partial output was generated, so it is billed.
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify(anthropicMessage([], "refusal", { input_tokens: 1_000_000, output_tokens: 200_000 })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const refused = await withModelEnv({ ...KEYS.anthropic }, () => llm.generateText(textRequest({ tier: "fast" }), tracking).catch((e: unknown) => e));
    expectModelError(refused, /^Anthropic declined this step/);

    const calls = await db.modelCall.findMany({ where: { organizationId: t.organization.id }, orderBy: { createdAt: "asc" } });
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe("claude-haiku-4-5");
    expect(calls[0].error).toContain("Anthropic rejected the API key");
    expect(calls[0].error).toContain("HTTP 401: invalid x-api-key [redacted]");
    // claude-haiku-4-5 at $1 / $5 per MTok: 1M in + 200k out = $2, recorded even though the call failed.
    expect(Number(calls[0].costUsd)).toBe(0);
    expect(Number(calls[1].costUsd)).toBe(2);
    expect(calls[1].error).toContain("declined this step");
  });
});
