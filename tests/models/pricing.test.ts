import { describe, expect, it } from "vitest";
import { llm } from "@/server/models";
import { MODEL_PRICES, TIER_REFERENCE_MODELS, computeCostUsd, priceFor, tierReferencePrice } from "@/server/models/pricing";
import { DEFAULT_TIER_MODELS, LIVE_PROVIDER_ORDER, MODEL_TIERS } from "@/server/models/registry";
import { withModelEnv } from "./helpers";

describe("models: pricing", () => {
  it("has a price for every default tier model and every reference model", () => {
    for (const provider of LIVE_PROVIDER_ORDER) {
      for (const tier of MODEL_TIERS) {
        expect(MODEL_PRICES[`${provider}:${DEFAULT_TIER_MODELS[provider][tier]}`]).toBeDefined();
      }
    }
    for (const tier of MODEL_TIERS) expect(MODEL_PRICES[TIER_REFERENCE_MODELS[tier]]).toBeDefined();
  });

  it("computes cost per million tokens", () => {
    const price = { inputPerMTok: 2, outputPerMTok: 10 };
    expect(computeCostUsd(price, 1_000_000, 0)).toBe(2);
    expect(computeCostUsd(price, 0, 1_000_000)).toBe(10);
    expect(computeCostUsd(price, 12_000, 3_000)).toBeCloseTo(0.054, 10);
    expect(computeCostUsd(price, 0, 0)).toBe(0);
  });

  it("never returns negative, NaN or sub-micro-dollar noise", () => {
    const price = { inputPerMTok: 1, outputPerMTok: 5 };
    expect(computeCostUsd(price, -50, Number.NaN)).toBe(0);
    expect(computeCostUsd({ inputPerMTok: 0.3, outputPerMTok: 2.5 }, 100_000, 100_000)).toBe(0.28);
  });

  it("looks up known models, dated snapshots, and falls back to the tier reference price", () => {
    expect(priceFor("anthropic", "claude-opus-5", "fast")).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(priceFor("anthropic", "claude-haiku-4-5-20251001", "reasoning")).toEqual(MODEL_PRICES["anthropic:claude-haiku-4-5"]);
    expect(priceFor("openai", "gpt-5-2025-08-07", "fast")).toEqual(MODEL_PRICES["openai:gpt-5"]);
    // Unknown model → the reference price of the tier it is serving.
    expect(priceFor("openai", "gpt-99-ultra", "standard")).toEqual(tierReferencePrice("standard"));
    expect(priceFor("mock", "mock-fast", "fast")).toEqual(tierReferencePrice("fast"));
    expect(llm.priceFor("mock", "mock-reasoning", "reasoning")).toEqual(MODEL_PRICES["anthropic:claude-opus-5"]);
  });

  it("estimateCostUsd uses the reference price in Simulated mode", async () => {
    await withModelEnv({}, () => {
      expect(llm.estimateCostUsd("fast", 1_000_000, 1_000_000)).toBe(6);
      expect(llm.estimateCostUsd("standard", 1_000_000, 1_000_000)).toBe(12);
      expect(llm.estimateCostUsd("reasoning", 1_000_000, 1_000_000)).toBe(30);
    });
  });

  it("estimateCostUsd follows the tier's CURRENT route", async () => {
    await withModelEnv({ OPENAI_API_KEY: "sk-test" }, () => {
      expect(llm.estimateCostUsd("fast", 1_000_000, 1_000_000)).toBe(0.6); // gpt-6-luna
      expect(llm.estimateCostUsd("standard", 1_000_000, 1_000_000)).toBe(12); // gpt-6.1-sol
    });
    await withModelEnv({ OPENAI_API_KEY: "sk-test", MODEL_TIER_FAST: "openai:some-future-model" }, () => {
      // Unknown override model → priced at the fast tier's reference model.
      expect(llm.estimateCostUsd("fast", 1_000_000, 1_000_000)).toBe(6);
    });
  });
});
