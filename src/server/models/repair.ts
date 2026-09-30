import type { z } from "zod";
import { AppError } from "@/server/errors";
import type { GenerateObjectRequest, ModelUsage } from "./types";

/**
 * Structured-output hardening for the LIVE path: JSON repair (null stripping), normalize → validate,
 * and the single re-ask. Pure — no SDK imports — so every piece is unit-testable.
 */

const MAX_ISSUES_IN_PROMPT = 20;
const MAX_ECHOED_OUTPUT_CHARS = 4_000;

/**
 * Recursively delete null-valued PROPERTIES. Models routinely emit `"field": null` for optionals, which Zod's
 * `.optional()` rejects. Array elements are left alone (removing them would shift positions).
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === null) continue;
      out[key] = stripNulls(child);
    }
    return out;
  }
  return value;
}

/** Pull the JSON document out of a chatty response: ```json fences, or prose around the outermost {...} / [...]. */
export function extractJsonText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();

  const starts = [candidate.indexOf("{"), candidate.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  return end > start ? candidate.slice(start, end + 1) : null;
}

/**
 * `experimental_repairText` for generateObject. The SDK calls it when the raw output fails JSON parsing OR schema
 * validation; whatever we return is parsed and validated once more. Returns null when there is nothing to repair.
 */
export async function repairJsonText(options: { text: string; error?: unknown }): Promise<string | null> {
  const jsonText = extractJsonText(options.text);
  if (jsonText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const repaired = JSON.stringify(stripNulls(parsed));
  // Identical content would just fail the same way again — let the original error surface.
  return repaired === JSON.stringify(parsed) && jsonText === options.text.trim() ? null : repaired;
}

export function formatIssues(error: z.ZodError): string {
  const lines = error.issues.slice(0, MAX_ISSUES_IN_PROMPT).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `- ${path}: ${issue.message}`;
  });
  const hidden = error.issues.length - lines.length;
  if (hidden > 0) lines.push(`- …and ${hidden} more issue${hidden === 1 ? "" : "s"}`);
  return lines.join("\n");
}

export type ValidatedObject<T> = { ok: true; object: T } | { ok: false; error: Error; issues: string };

/** normalize → schema validation. The one validation path shared by the live adapter and the mock provider. */
export function validateObject<T>(
  raw: unknown,
  req: Pick<GenerateObjectRequest<T>, "schema" | "normalize">,
): ValidatedObject<T> {
  let value = raw;
  if (req.normalize) {
    try {
      value = req.normalize(raw);
    } catch (e) {
      // A normalizer tripping over an unexpected shape means the shape is wrong — report it as a validation issue.
      const error = e instanceof Error ? e : new Error(String(e));
      return { ok: false, error, issues: `- (root): unexpected structure (${error.message})` };
    }
  }
  const parsed = req.schema.safeParse(value);
  if (parsed.success) return { ok: true, object: parsed.data };
  return { ok: false, error: parsed.error, issues: formatIssues(parsed.error) };
}

export type ObjectAttempt<T> =
  | { ok: true; object: T; usage: ModelUsage }
  | { ok: false; issues: string; text?: string; usage: ModelUsage };

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export function buildReaskPrompt(prompt: string, failure: { issues: string; text?: string }): string {
  const echoed = failure.text?.trim();
  const previous = echoed
    ? `\n\nYour previous response was:\n${
        echoed.length > MAX_ECHOED_OUTPUT_CHARS ? `${echoed.slice(0, MAX_ECHOED_OUTPUT_CHARS)}…` : echoed
      }`
    : "";
  return (
    `${prompt}\n\n---\n` +
    `Your previous response was rejected because it did not match the required schema:\n${failure.issues}` +
    `${previous}\n\n` +
    "Respond again with the COMPLETE corrected object. Fix every issue listed above, keep everything that was already valid, " +
    "and omit optional fields you have no value for instead of setting them to null."
  );
}

/**
 * One attempt, and on a validation failure exactly ONE re-ask with the issues appended. Usage is summed over both
 * attempts; when both fail the consumed usage rides along in `details` so the caller can still account for it.
 */
export async function generateObjectWithReask<T>(
  req: Pick<GenerateObjectRequest<T>, "prompt" | "schemaName">,
  attempt: (prompt: string) => Promise<ObjectAttempt<T>>,
): Promise<{ object: T; usage: ModelUsage }> {
  const first = await attempt(req.prompt);
  if (first.ok) return { object: first.object, usage: first.usage };

  let second: ObjectAttempt<T>;
  try {
    second = await attempt(buildReaskPrompt(req.prompt, first));
  } catch (e) {
    // Already a human-facing failure (bad key, rate limit, refusal …): keep its message, add the first attempt's tokens.
    if (e instanceof AppError) {
      const details = e.details !== null && typeof e.details === "object" ? (e.details as { usage?: ModelUsage }) : {};
      const usage = details.usage ? addUsage(first.usage, details.usage) : first.usage;
      throw new AppError(e.code, e.message, { ...details, usage, issues: first.issues });
    }
    const message = e instanceof Error ? e.message : String(e);
    throw new AppError("MODEL_ERROR", `The model call failed while correcting its ${req.schemaName} output: ${message}`, {
      usage: first.usage,
      issues: first.issues,
    });
  }

  const usage = addUsage(first.usage, second.usage);
  if (second.ok) return { object: second.object, usage };
  throw new AppError("MODEL_ERROR", `The model could not produce a valid ${req.schemaName} after one correction`, {
    usage,
    issues: second.issues,
    text: second.text,
  });
}
