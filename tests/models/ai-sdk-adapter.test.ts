import { zodSchema } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BlueprintDraftSchema,
  JobSpecLlmSchema,
  JudgeOutputSchema,
  MessageClassificationSchema,
  ReplacementPlanSchema,
  ReviewNarrativeSchema,
  ScopingQuestionsSchema,
} from "@/server/domain";
import { AppError } from "@/server/errors";
import { TOOL_INPUT_SCHEMAS } from "@/server/tools/schemas";
import { createAiSdkProvider, mapFinishReason, REASONING_HEADROOM_TOKENS, toUsage } from "@/server/models/providers/ai-sdk";
import type { ChatMessage } from "@/server/models/types";
import { fetchTool, searchTool } from "./helpers";

/**
 * The live adapter, exercised OFFLINE against the real AI SDK with its MockLanguageModelV2 (no network, no keys).
 * This pins our use of the v5 API: execute-less tools, single step, usage / finish-reason mapping, and the
 * structured-output repair + re-ask flow.
 */

type DoGenerateResult = Awaited<ReturnType<MockLanguageModelV2["doGenerate"]>>;

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });

function textResult(text: string, inputTokens = 100, outputTokens = 20): DoGenerateResult {
  return { content: [{ type: "text", text }], finishReason: "stop", usage: usage(inputTokens, outputTokens), warnings: [] };
}

const neverMock = () => {
  throw new Error("the mock producer must never run on the live path");
};

describe("models: AI SDK adapter (offline)", () => {
  it("returns tool calls without executing them and stops after one step", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [
          { type: "text", text: "Let me look that up." },
          { type: "tool-call", toolCallId: "toolu_01", toolName: "web_search", input: JSON.stringify({ query: "ai infra funding" }) },
          { type: "tool-call", toolCallId: "toolu_02", toolName: "fetch_url", input: JSON.stringify({ url: "https://a.example" }) },
        ],
        finishReason: "tool-calls",
        usage: usage(321, 45),
        warnings: [],
      }),
    });
    const provider = createAiSdkProvider("anthropic", { resolveModel: () => model });

    const messages: ChatMessage[] = [
      { role: "user", content: "Find funded startups" },
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_00", name: "web_search", input: { query: "first" } }] },
      { role: "tool", toolCallId: "toolu_00", toolName: "web_search", output: { error: "rate limited" }, isError: true },
    ];
    const result = await provider.generateText("claude-sonnet-5", {
      tier: "standard",
      system: "You are Alex.",
      messages,
      tools: [searchTool, fetchTool],
      maxOutputTokens: 2_000,
      mock: neverMock,
    });

    expect(result).toEqual({
      text: "Let me look that up.",
      toolCalls: [
        { id: "toolu_01", name: "web_search", input: { query: "ai infra funding" } },
        { id: "toolu_02", name: "fetch_url", input: { url: "https://a.example" } },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 321, outputTokens: 45 },
    });

    // Exactly one provider round trip: the runtime owns the loop.
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0];
    // The caller's cap is for the visible answer; reasoning models get headroom on top.
    expect(call.maxOutputTokens).toBe(2_000 + REASONING_HEADROOM_TOKENS);
    expect(call.toolChoice).toEqual({ type: "auto" });
    expect(call.tools?.map((t) => t.name)).toEqual(["web_search", "fetch_url"]);
    expect(call.tools?.[0]).toMatchObject({ type: "function", description: "Search the web" });
    expect(call.prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(call.prompt[3]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "toolu_00", output: { type: "error-json", value: { error: "rate limited" } } }],
    });
  });

  it("sends no tools at all when none are offered", async () => {
    const model = new MockLanguageModelV2({ doGenerate: async () => textResult("Final answer.") });
    const provider = createAiSdkProvider("openai", { resolveModel: () => model });
    const result = await provider.generateText("gpt-6.1-sol", {
      tier: "standard",
      messages: [{ role: "user", content: "Summarize" }],
      mock: neverMock,
    });
    expect(result).toMatchObject({ text: "Final answer.", toolCalls: [], finishReason: "stop" });
    expect(model.doGenerateCalls[0].tools).toBeUndefined();
    expect(model.doGenerateCalls[0].maxOutputTokens).toBe(16_000);
  });

  it("maps finish reasons and bills hidden reasoning tokens", () => {
    expect(mapFinishReason("stop", false)).toBe("stop");
    expect(mapFinishReason("stop", true)).toBe("tool_calls");
    expect(mapFinishReason("tool-calls", false)).toBe("tool_calls");
    expect(mapFinishReason("length", false)).toBe("length");
    expect(mapFinishReason("content-filter", false)).toBe("other");
    expect(mapFinishReason("unknown", false)).toBe("other");

    expect(toUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })).toEqual({ inputTokens: 10, outputTokens: 5 });
    // Gemini: thoughts are billed as output but reported outside outputTokens.
    expect(toUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 420, reasoningTokens: 300 })).toEqual({ inputTokens: 100, outputTokens: 320 });
    expect(toUsage({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined })).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(toUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  const SpecSchema = z.object({
    title: z.string(),
    note: z.string().optional(),
    questions: z.array(z.string()).max(3),
  });

  it("generateObject: normalize runs before validation on the live path", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => textResult(JSON.stringify({ title: "Spec", questions: ["a", "b", "c", "d", "e"] })),
    });
    const provider = createAiSdkProvider("anthropic", { resolveModel: () => model });
    const result = await provider.generateObject("claude-sonnet-5", {
      tier: "standard",
      prompt: "Scope this job",
      schema: SpecSchema,
      schemaName: "scoping.spec",
      normalize: (raw) => {
        const value = raw as { questions: string[] };
        return { ...value, questions: value.questions.slice(0, 3) };
      },
      mock: neverMock,
    });
    expect(result.object).toEqual({ title: "Spec", questions: ["a", "b", "c"] });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0].responseFormat).toMatchObject({ type: "json", name: "scoping_spec" });
  });

  it("generateObject: null-valued optionals are repaired without a second provider call", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => textResult('```json\n{"title":"Spec","note":null,"questions":[]}\n```'),
    });
    const provider = createAiSdkProvider("google", { resolveModel: () => model });
    const result = await provider.generateObject("gemini-3.8-flash", {
      tier: "standard",
      prompt: "Scope this job",
      schema: SpecSchema,
      schemaName: "Spec",
      mock: neverMock,
    });
    expect(result.object).toEqual({ title: "Spec", questions: [] });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("generateObject: one re-ask with the Zod issues appended, usage summed", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: [
        textResult(JSON.stringify({ title: 42, questions: [] }), 100, 10),
        textResult(JSON.stringify({ title: "Fixed", questions: ["q"] }), 180, 15),
      ],
    });
    const provider = createAiSdkProvider("anthropic", { resolveModel: () => model });
    const result = await provider.generateObject("claude-sonnet-5", {
      tier: "standard",
      prompt: "Scope this job",
      schema: SpecSchema,
      schemaName: "Spec",
      mock: neverMock,
    });
    expect(result.object).toEqual({ title: "Fixed", questions: ["q"] });
    expect(result.usage).toEqual({ inputTokens: 280, outputTokens: 25 });

    expect(model.doGenerateCalls).toHaveLength(2);
    const reaskPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(reaskPrompt).toContain("Scope this job");
    expect(reaskPrompt).toContain("- title:");
  });

  it("generateObject: MODEL_ERROR after the correction fails too (usage preserved for accounting)", async () => {
    const model = new MockLanguageModelV2({ doGenerate: async () => textResult(JSON.stringify({ title: 42, questions: [] }), 50, 5) });
    const provider = createAiSdkProvider("anthropic", { resolveModel: () => model });
    const error = await provider
      .generateObject("claude-sonnet-5", { tier: "standard", prompt: "p", schema: SpecSchema, schemaName: "Spec", mock: neverMock })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("MODEL_ERROR");
    expect((error as AppError).details).toMatchObject({ usage: { inputTokens: 100, outputTokens: 10 } });
  });

  it("without an API key the live provider refuses with MODEL_ERROR (never falls back to the mock)", async () => {
    const provider = createAiSdkProvider("anthropic");
    expect(provider.isAvailable()).toBe(false);
    await expect(
      provider.generateText("claude-haiku-4-5", { tier: "fast", messages: [{ role: "user", content: "hi" }], mock: neverMock }),
    ).rejects.toMatchObject({ code: "MODEL_ERROR" });
  });

  it("every LLM-facing domain schema and tool input schema converts to an object JSON Schema", () => {
    const llmSchemas = {
      ScopingQuestionsSchema,
      JobSpecLlmSchema,
      BlueprintDraftSchema,
      JudgeOutputSchema,
      ReviewNarrativeSchema,
      ReplacementPlanSchema,
      MessageClassificationSchema,
      ...TOOL_INPUT_SCHEMAS,
    };
    for (const [name, schema] of Object.entries(llmSchemas)) {
      // Providers require an object at the root (Anthropic JSON tool / OpenAI json_schema / tool parameters).
      const json = zodSchema(schema as z.ZodType).jsonSchema;
      expect(json.type, name).toBe("object");
      expect(JSON.stringify(json), name).not.toContain('"$ref"');
    }
  });
});
