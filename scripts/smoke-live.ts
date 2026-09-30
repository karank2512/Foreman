import { z } from "zod";
import { errorMessage, isAppError } from "@/server/errors";
import { createAiSdkProvider } from "@/server/models/providers/ai-sdk";
import {
  LIVE_PROVIDER_ORDER,
  MODEL_TIERS,
  providerApiKey,
  providerLabel,
  providerTierModels,
  type LiveProviderId,
} from "@/server/models/registry";
import type { ChatMessage, ModelTier, ToolSpec } from "@/server/models/types";
import { redactAndClip } from "@/server/security/redact";
import { TAVILY_SECRET, tavilySearch } from "@/server/tools/impl/web-search";

/**
 * `npm run smoke:live` — checks the keys in your environment (.env is loaded) before you trust a real run to them.
 * On Docker, the image carries it bundled: `docker compose run --rm --no-deps --entrypoint node web dist/smoke-live.cjs`.
 *
 * For every provider with a key it makes ONE tiny call per model that provider would serve (the defaults, or your
 * MODEL_TIER_* pins; up to three) through Foreman's own model layer — same SDK wiring, retries and error messages as
 * a run — plus one 1-result Tavily search when TAVILY_API_KEY is set. Cost: a fraction of a cent, billed to your
 * keys. Needs no database. Never prints key values. Exits 1 if anything failed.
 *
 * `--deep` also runs, per provider, what a real run does beyond one reply: a one-tool round trip (the model calls a
 * tool, gets the result back, and answers) and a small structured-output call, both on the standard tier. A cent or
 * two more; worth it once before you trust a new provider or model with a schedule.
 */

const CHECK_TIMEOUT_MS = 90_000;
const PROVIDER_DETAIL_CHARS = 300;

interface Outcome {
  ok: boolean;
  ms: number;
  note?: string;
  hint?: string;
  detail?: string;
  /** provider-errors.ts kind, when the failure came from the model layer. */
  kind?: string;
}

/** Failures that are about the key itself: every other model on that key would fail the same way. */
const KEY_LEVEL_FAILURES = new Set(["auth", "quota", "network"]);

/**
 * Provider text is scrubbed like everything else Foreman stores, plus the half-masked keys some providers echo
 * back ("sk-proj-****…wxyz") — even a masked fragment is more of the key than this script should print.
 */
function scrub(text: string): string {
  return redactAndClip(text, PROVIDER_DETAIL_CHARS).replace(/\S*\*{4,}\S*/g, "[redacted]");
}

async function timed(fn: () => Promise<string | undefined>): Promise<Outcome> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS);
  });
  try {
    const note = await Promise.race([fn(), timeout]);
    return { ok: true, ms: Date.now() - started, note };
  } catch (e) {
    const details = isAppError(e) ? (e.details as { providerMessage?: unknown; kind?: unknown } | undefined) : undefined;
    const providerMessage = typeof details?.providerMessage === "string" ? details.providerMessage : undefined;
    return {
      ok: false,
      ms: Date.now() - started,
      // AppError messages are ours and name the fix; anything else is scrubbed before it is printed.
      hint: isAppError(e) ? e.message : scrub(errorMessage(e)),
      detail: providerMessage ? scrub(providerMessage) : undefined,
      kind: typeof details?.kind === "string" ? details.kind : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

function report(provider: string, model: string, outcome: Outcome, suffix = ""): void {
  const status = outcome.ok ? "ok" : "FAILED";
  const extra = [outcome.note, suffix].filter(Boolean).join(" · ");
  console.log(`  ${provider} · ${model} · ${status} · ${outcome.ms} ms${extra ? ` · ${extra}` : ""}`);
  if (outcome.hint) console.log(`      ${outcome.hint}`);
  if (outcome.detail) console.log(`      provider said: ${outcome.detail}`);
}

/** Tiers grouped by the model that would serve them, so each distinct model id is called once. */
function modelsToCheck(provider: LiveProviderId): Map<string, ModelTier[]> {
  const byModel = new Map<string, ModelTier[]>();
  const models = providerTierModels(provider);
  for (const tier of MODEL_TIERS) byModel.set(models[tier], [...(byModel.get(models[tier]) ?? []), tier]);
  return byModel;
}

const ADD_TOOL: ToolSpec = {
  name: "add_numbers",
  description: "Adds two integers and returns their sum.",
  inputSchema: z.object({ a: z.number().int(), b: z.number().int() }),
};

/** The agent loop in miniature: tool call → tool result → answer, through the same adapter and message replay. */
async function checkToolRoundTrip(provider: LiveProviderId, model: string): Promise<string | undefined> {
  const adapter = createAiSdkProvider(provider);
  const system = "You are a careful assistant. Use the add_numbers tool for arithmetic, then answer with just the number.";
  const messages: ChatMessage[] = [{ role: "user", content: "What is 17 + 25?" }];
  const request = { tier: "standard" as const, system, tools: [ADD_TOOL], maxOutputTokens: 256, mock: () => ({ text: "42" }) };

  const first = await adapter.generateText(model, { ...request, messages });
  const call = first.toolCalls.find((c) => c.name === ADD_TOOL.name);
  if (!call) throw new Error(`the model answered without calling the tool (finish reason: ${first.finishReason})`);
  const input = ADD_TOOL.inputSchema.safeParse(call.input);
  if (!input.success) throw new Error("the model called the tool with arguments that don't match its schema");
  const { a, b } = input.data as { a: number; b: number };

  messages.push({ role: "assistant", content: first.text, toolCalls: first.toolCalls });
  for (const c of first.toolCalls) {
    messages.push({ role: "tool", toolCallId: c.id, toolName: c.name, output: c.id === call.id ? { sum: a + b } : { error: "not called" } });
  }
  const second = await adapter.generateText(model, { ...request, messages });
  if (!second.text.includes(String(a + b))) throw new Error("the model did not use the tool result in its answer");
  const tokens = first.usage.inputTokens + first.usage.outputTokens + second.usage.inputTokens + second.usage.outputTokens;
  return `${tokens} tokens over 2 calls`;
}

/** Structured output, the way scoping, staffing and evaluation ask for it. */
async function checkStructuredOutput(provider: LiveProviderId, model: string): Promise<string | undefined> {
  const schema = z.object({ city: z.string().min(1), country: z.string().min(1) });
  const result = await createAiSdkProvider(provider).generateObject(model, {
    tier: "standard",
    prompt: "Name the capital of France and its country.",
    schema,
    schemaName: "capital",
    maxOutputTokens: 256,
    mock: () => ({ city: "Paris", country: "France" }),
  });
  return `${result.usage.inputTokens + result.usage.outputTokens} tokens`;
}

async function checkModel(provider: LiveProviderId, model: string, tier: ModelTier): Promise<string | undefined> {
  const result = await createAiSdkProvider(provider).generateText(model, {
    tier,
    messages: [{ role: "user", content: "Reply with just the word OK." }],
    maxOutputTokens: 16,
    mock: () => ({ text: "OK" }),
  });
  const tokens = `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`;
  return result.text.trim() ? tokens : `${tokens} (empty reply)`;
}

/** Base-URL overrides the provider SDKs honour; worth a line when a key fails against the wrong host. */
const BASE_URL_VARS: Partial<Record<LiveProviderId, string>> = { anthropic: "ANTHROPIC_BASE_URL", openai: "OPENAI_BASE_URL" };

function baseUrlNote(provider: LiveProviderId): string | undefined {
  const envVar = BASE_URL_VARS[provider];
  const raw = envVar ? process.env[envVar]?.trim() : undefined;
  if (!raw) return undefined;
  try {
    return `${envVar} points at ${new URL(raw).host}`;
  } catch {
    return `${envVar} is set but is not a valid URL`;
  }
}

/**
 * .env, loaded the way the app loads it (existing variables win). dotenv is a dev dependency, so it is absent from
 * the Docker image — where compose has already put .env into the environment and there is no file to read.
 */
async function loadDotenv(): Promise<void> {
  try {
    (await import("dotenv")).config({ quiet: true });
  } catch {
    // Not installed: the runtime image.
  }
}

async function main(): Promise<number> {
  await loadDotenv();
  const deep = process.argv.includes("--deep");
  const configured = LIVE_PROVIDER_ORDER.filter((id) => providerApiKey(id) !== undefined);
  const tavilyKey = process.env[TAVILY_SECRET]?.trim();
  let failures = 0;

  if (configured.length === 0) {
    console.log("No provider keys set — Foreman will run in Simulated mode.");
  } else {
    console.log(
      deep
        ? "Checking your model keys: one tiny call per model, plus a tool round trip and a structured-output call per provider (a cent or two, billed to your key)."
        : "Checking your model keys: one tiny call per model (a fraction of a cent, billed to your key).",
    );
    const forced = process.env.FORCE_SIMULATED?.trim().toLowerCase();
    if (forced === "1" || forced === "true") {
      console.log("  Note: FORCE_SIMULATED is set, so the app ignores these keys until you unset it.");
    }
    for (const provider of configured) {
      const note = baseUrlNote(provider);
      if (note) console.log(`  Note: ${note}.`);
      let keyProblem = false;
      for (const [model, tiers] of modelsToCheck(provider)) {
        const tierNote = `${tiers.join(" + ")} tier${tiers.length > 1 ? "s" : ""}`;
        if (keyProblem) {
          console.log(`  ${provider} · ${model} · skipped · ${tierNote} (fix the key first)`);
          continue;
        }
        const outcome = await timed(() => checkModel(provider, model, tiers[0]));
        if (!outcome.ok) failures++;
        keyProblem = outcome.kind !== undefined && KEY_LEVEL_FAILURES.has(outcome.kind);
        report(provider, model, outcome, tierNote);
      }
      if (deep && !keyProblem) {
        const standard = providerTierModels(provider).standard;
        for (const [label, check] of [
          ["tool round trip", checkToolRoundTrip],
          ["structured output", checkStructuredOutput],
        ] as const) {
          const outcome = await timed(() => check(provider, standard));
          if (!outcome.ok) failures++;
          report(provider, `${standard} ${label}`, outcome, "standard tier");
        }
      }
    }
    const serving = configured[0];
    console.log(
      `Runs use ${providerLabel(serving)} for every tier (first key in the order ${LIVE_PROVIDER_ORDER.join(" → ")}), except tiers pinned with MODEL_TIER_*.`,
    );
  }

  if (tavilyKey) {
    console.log("Checking TAVILY_API_KEY: one 1-result web search.");
    const outcome = await timed(async () => {
      const results = await tavilySearch(tavilyKey, "Foreman open-source AI workers", 1);
      return `${results.length} result${results.length === 1 ? "" : "s"}`;
    });
    if (!outcome.ok) failures++;
    report("tavily", "web search", outcome);
    if (configured.length === 0) console.log("  Web search stays simulated until a model provider key is set too.");
  } else if (configured.length > 0) {
    console.log("TAVILY_API_KEY is not set — web search stays simulated unless a workspace adds a key in Settings → Tool credentials.");
  }

  if (failures > 0) {
    console.log(`\n${failures} check${failures === 1 ? "" : "s"} failed. Fix the key or model id above, then run this check again.`);
    return 1;
  }
  if (configured.length > 0 || tavilyKey) console.log("\nAll checks passed.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`Smoke test crashed: ${redactAndClip(errorMessage(e), PROVIDER_DETAIL_CHARS)}`);
    process.exit(1);
  },
);
