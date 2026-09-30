import { z } from "zod";
import type { CallTracking, ToolSpec } from "@/server/models/types";

export const MODEL_ENV_KEYS = [
  "FORCE_SIMULATED",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MODEL_TIER_FAST",
  "MODEL_TIER_STANDARD",
  "MODEL_TIER_REASONING",
  // Often inherited from the shell (Anthropic tooling exports ANTHROPIC_BASE_URL); unset unless a test asks for it.
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
] as const;

type ModelEnv = Partial<Record<(typeof MODEL_ENV_KEYS)[number], string>>;

/**
 * Run `fn` with EXACTLY the given model-related env (every other model key is unset), then restore the previous
 * values — even when `fn` throws. Routing is computed lazily from process.env, so no module reload is needed.
 */
export async function withModelEnv<T>(env: ModelEnv, fn: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>(MODEL_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of MODEL_ENV_KEYS) {
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Tracking for pure unit tests: nothing is written to the database. */
export const DRY_RUN: CallTracking = { organizationId: "org_unit_test", purpose: "test.unit", persist: false };

export const searchTool: ToolSpec = {
  name: "web_search",
  description: "Search the web",
  inputSchema: z.object({ query: z.string() }),
};

export const fetchTool: ToolSpec = {
  name: "fetch_url",
  description: "Fetch a page",
  inputSchema: z.object({ url: z.string() }),
};
