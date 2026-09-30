import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llm } from "@/server/models";
import { resetRouteWarnings } from "@/server/models/registry";
import { withModelEnv } from "./helpers";

describe("models: provider availability + tier routing", () => {
  beforeEach(() => resetRouteWarnings());
  afterEach(() => vi.restoreAllMocks());

  it("routes every tier to the mock provider when no key is set", async () => {
    await withModelEnv({}, () => {
      expect(llm.isSimulated()).toBe(true);
      expect(llm.route("fast")).toEqual({ provider: "mock", model: "mock-fast" });
      expect(llm.route("standard")).toEqual({ provider: "mock", model: "mock-standard" });
      expect(llm.route("reasoning")).toEqual({ provider: "mock", model: "mock-reasoning" });
    });
  });

  it("treats empty / whitespace keys as unset", async () => {
    await withModelEnv({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "   " }, () => {
      expect(llm.isSimulated()).toBe(true);
      expect(llm.route("standard").provider).toBe("mock");
    });
  });

  it("uses Anthropic defaults when its key is present", async () => {
    await withModelEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test" }, () => {
      expect(llm.isSimulated()).toBe(false);
      expect(llm.route("fast")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
      expect(llm.route("standard")).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
      expect(llm.route("reasoning")).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    });
  });

  it("falls through the provider order: anthropic → openai → google", async () => {
    await withModelEnv({ OPENAI_API_KEY: "sk-test", GOOGLE_GENERATIVE_AI_API_KEY: "g-test" }, () => {
      expect(llm.route("fast")).toEqual({ provider: "openai", model: "gpt-6-luna" });
      expect(llm.route("standard")).toEqual({ provider: "openai", model: "gpt-6.1-sol" });
      expect(llm.route("reasoning")).toEqual({ provider: "openai", model: "gpt-6.1-sol" });
    });
    await withModelEnv({ GOOGLE_GENERATIVE_AI_API_KEY: "g-test" }, () => {
      expect(llm.route("fast")).toEqual({ provider: "google", model: "gemini-3.5-flash-lite" });
      expect(llm.route("standard")).toEqual({ provider: "google", model: "gemini-3.8-flash" });
      expect(llm.route("reasoning")).toEqual({ provider: "google", model: "gemini-3.8-flash" });
    });
  });

  it("FORCE_SIMULATED wins over configured keys and overrides", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withModelEnv(
      { FORCE_SIMULATED: "true", ANTHROPIC_API_KEY: "sk-ant-test", MODEL_TIER_FAST: "anthropic:claude-haiku-4-5" },
      () => {
        expect(llm.isSimulated()).toBe(true);
        expect(llm.route("fast")).toEqual({ provider: "mock", model: "mock-fast" });
        const status = llm.status();
        expect(status.mode).toBe("simulated");
        expect(status.providers.find((p) => p.id === "anthropic")?.available).toBe(false);
      },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("applies per-tier overrides and leaves the other tiers on the default route", async () => {
    await withModelEnv(
      { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test", MODEL_TIER_STANDARD: "openai:gpt-5-custom" },
      () => {
        expect(llm.route("standard")).toEqual({ provider: "openai", model: "gpt-5-custom" });
        expect(llm.route("fast")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
        expect(llm.status().tiers.standard).toEqual({ provider: "openai", model: "gpt-5-custom" });
      },
    );
  });

  it("ignores malformed overrides with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withModelEnv({ ANTHROPIC_API_KEY: "sk-ant-test", MODEL_TIER_FAST: "not-a-route" }, () => {
      expect(llm.route("fast")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
      // Routing runs on every call — the same problem is reported once, not on every call.
      llm.route("fast");
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("MODEL_TIER_FAST");

    await withModelEnv({ ANTHROPIC_API_KEY: "sk-ant-test", MODEL_TIER_REASONING: "mistral:large" }, () => {
      expect(llm.route("reasoning")).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    });
    await withModelEnv({ ANTHROPIC_API_KEY: "sk-ant-test", MODEL_TIER_REASONING: "openai:" }, () => {
      expect(llm.route("reasoning")).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("ignores an override whose provider has no key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withModelEnv({ ANTHROPIC_API_KEY: "sk-ant-test", MODEL_TIER_FAST: "google:gemini-2.5-flash" }, () => {
      expect(llm.route("fast")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("status() lists the three live providers plus the always-available mock", async () => {
    await withModelEnv({ OPENAI_API_KEY: "sk-test" }, () => {
      const status = llm.status();
      expect(status.mode).toBe("live");
      expect(status.providers.map((p) => [p.id, p.available, p.envVar])).toEqual([
        ["anthropic", false, "ANTHROPIC_API_KEY"],
        ["openai", true, "OPENAI_API_KEY"],
        ["google", false, "GOOGLE_GENERATIVE_AI_API_KEY"],
        ["mock", true, null],
      ]);
      expect(status.providers.every((p) => p.label.length > 0)).toBe(true);
      expect(status.tiers).toEqual({
        fast: { provider: "openai", model: "gpt-6-luna" },
        standard: { provider: "openai", model: "gpt-6.1-sol" },
        reasoning: { provider: "openai", model: "gpt-6.1-sol" },
      });
    });
  });

  it("the default test environment is simulated", () => {
    expect(llm.isSimulated()).toBe(true);
    expect(llm.status().mode).toBe("simulated");
  });
});
