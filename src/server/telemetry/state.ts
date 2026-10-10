import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { ALLOWED_ATTRIBUTE_KEYS, MAX_ATTRIBUTE_LENGTH } from "./types";

/**
 * Process-wide telemetry state. Only `@opentelemetry/api` is imported here (a dependency-free no-op shim); the SDK
 * and the exporter are loaded by `provider.ts` and only when OTEL_ENABLED is true, so a disabled worker never
 * loads them and never opens a connection.
 *
 * The run registry replaces OpenTelemetry context propagation: every runtime hook knows its runId and executorId,
 * so the slice span is looked up explicitly instead of through an async-hooks context manager (one less
 * dependency, and no ambiguity when two slices of one run overlap in a single process during tests).
 */

export interface TracerProviderLike {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RunSpanEntry {
  runId: string;
  executorId: string;
  span: Span;
}

export const state: {
  enabled: boolean;
  tracer: Tracer | null;
  provider: TracerProviderLike | null;
  /** Keyed by `${runId}:${executorId}`. */
  runs: Map<string, RunSpanEntry>;
} = { enabled: false, tracer: null, provider: null, runs: new Map() };

export const runKey = (runId: string, executorId: string): string => `${runId}:${executorId}`;

/** The slice currently executing `runId` under `executorId`, or any slice of the run when no executor is given. */
export function findRunSpan(runId: string, executorId?: string): RunSpanEntry | undefined {
  if (executorId) return state.runs.get(runKey(runId, executorId));
  for (const entry of state.runs.values()) if (entry.runId === runId) return entry;
  return undefined;
}

/**
 * The last line of defence for rule "no prompts, inputs, outputs, secrets or identities in attributes": unknown
 * keys are dropped, strings are clipped, and only primitives survive. Tested in tests/telemetry.
 */
export function sanitizeAttributes(attrs: Record<string, unknown>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key) || value === undefined || value === null) continue;
    if (typeof value === "string") out[key] = value.length > MAX_ATTRIBUTE_LENGTH ? value.slice(0, MAX_ATTRIBUTE_LENGTH) : value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}
