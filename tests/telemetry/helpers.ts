import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ATTR, EVENT_NAMES, SPAN_NAMES } from "@/server/telemetry";

/** Spans and events in a plain, serializable shape (also the format of the evidence files in docs/OTEL.md). */
export interface EvidenceEvent {
  name: string;
  attributes: Record<string, unknown>;
}

export interface EvidenceSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  status: "UNSET" | "OK" | "ERROR";
  attributes: Record<string, unknown>;
  events: EvidenceEvent[];
}

const STATUS = ["UNSET", "OK", "ERROR"] as const;

/** SDK 2.x exposes `parentSpanContext`; 1.x exposed `parentSpanId`. Read whichever is present. */
export function parentSpanId(span: ReadableSpan): string | null {
  const loose = span as unknown as { parentSpanContext?: { spanId: string }; parentSpanId?: string };
  return loose.parentSpanContext?.spanId ?? loose.parentSpanId ?? null;
}

export function toEvidence(spans: ReadableSpan[]): EvidenceSpan[] {
  return spans.map((span) => ({
    name: span.name,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: parentSpanId(span),
    status: STATUS[span.status.code] ?? "UNSET",
    attributes: { ...span.attributes },
    events: span.events.map((e) => ({ name: e.name, attributes: { ...(e.attributes ?? {}) } })),
  }));
}

export function spansNamed(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

export function sliceSpans(spans: ReadableSpan[]): ReadableSpan[] {
  return spansNamed(spans, SPAN_NAMES.INVOKE_AGENT);
}

/** `execute_tool <tool>` spans, optionally for one tool. */
export function executeToolSpans(spans: ReadableSpan[], toolName?: string): ReadableSpan[] {
  return spans.filter((s) => s.name.startsWith(`${SPAN_NAMES.EXECUTE_TOOL} `) && (toolName === undefined || s.attributes[ATTR.TOOL_NAME] === toolName));
}

export interface FoundEvent {
  span: ReadableSpan;
  attributes: Attributes;
}

/** Every event with this name across the given spans, in span order then event order. */
export function eventsNamed(spans: ReadableSpan[], name: string): FoundEvent[] {
  const found: FoundEvent[] = [];
  for (const span of spans) for (const event of span.events) if (event.name === name) found.push({ span, attributes: event.attributes ?? {} });
  return found;
}

export function decisions(spans: ReadableSpan[], outcome?: string): FoundEvent[] {
  return eventsNamed(spans, EVENT_NAMES.TOOL_CALL_DECISION).filter((e) => outcome === undefined || e.attributes[ATTR.TOOL_CALL_DECISION_OUTCOME] === outcome);
}

/** Every attribute value (span and event level) as a string, for "nothing sensitive leaked" assertions. */
export function allAttributeEntries(spans: ReadableSpan[]): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const span of spans) {
    entries.push(...Object.entries(span.attributes));
    for (const event of span.events) entries.push(...Object.entries(event.attributes ?? {}));
  }
  return entries;
}

/**
 * Evidence capture for docs/OTEL.md: with OTEL_EVIDENCE_DIR set, the approve/deny suites write the spans they
 * asserted on as JSON. Every run in the suite is Simulated (tests clear the provider keys), and the file says so.
 */
export function writeEvidence(fileName: string, spans: ReadableSpan[]): void {
  const dir = process.env.OTEL_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const body = { mode: "Simulated", capturedAt: new Date().toISOString(), spans: toEvidence(spans) };
  writeFileSync(path.join(dir, fileName), `${JSON.stringify(body, null, 2)}\n`);
}
