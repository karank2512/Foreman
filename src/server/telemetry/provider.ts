import { trace } from "@opentelemetry/api";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { config } from "@/server/config";
import { logger } from "@/server/log";
import { state } from "./state";

/**
 * Provider lifecycle. `initTelemetry()` is called once by the worker (src/worker.ts), once by the web process
 * (src/instrumentation.ts, where reviewers decide) and by the telemetry tests; everything else in the module is a
 * no-op until it has run with `enabled: true`.
 *
 * The SDK (`@opentelemetry/sdk-trace-base`), the resource helpers and the OTLP exporter are imported dynamically
 * inside this function so that a process with OTEL_ENABLED=false never evaluates them: no background timers, no
 * sockets, no network calls — the opt-out costs nothing.
 */

const log = logger.child({ component: "telemetry" });

/** Instrumentation scope reported on every span (`InstrumentationScope.name`). */
export const INSTRUMENTATION_SCOPE = "foreman.runtime";

export interface TelemetryOptions {
  /** Defaults to `config.telemetry.enabled` (OTEL_ENABLED). */
  enabled?: boolean;
  /** Defaults to `config.telemetry.serviceName` (OTEL_SERVICE_NAME, else "foreman-worker"; the web passes "foreman-web"). */
  serviceName?: string;
  /** Test seam: receive the spans here instead of sending them over OTLP. */
  exporter?: SpanExporter;
  /** "simple" exports every span as it ends (tests); "batch" is the production default. Default follows `exporter`. */
  processor?: "simple" | "batch";
}

export async function initTelemetry(opts: TelemetryOptions = {}): Promise<{ enabled: boolean }> {
  const enabled = opts.enabled ?? config.telemetry.enabled;
  if (!enabled) return { enabled: false };
  if (state.provider) await shutdownTelemetry();

  const [sdk, resources] = await Promise.all([import("@opentelemetry/sdk-trace-base"), import("@opentelemetry/resources")]);
  const exporter = opts.exporter ?? (await createOtlpExporter());
  const mode = opts.processor ?? (opts.exporter ? "simple" : "batch");
  const processor = mode === "simple" ? new sdk.SimpleSpanProcessor(exporter) : new sdk.BatchSpanProcessor(exporter);
  const serviceName = opts.serviceName ?? config.telemetry.serviceName;
  const resource = resources.defaultResource().merge(
    resources.resourceFromAttributes({
      "service.name": serviceName,
      "service.version": config.appVersion,
    }),
  );
  const provider = new sdk.BasicTracerProvider({ resource, spanProcessors: [onlyForemanSpans(processor)] });
  // A previous provider (a test that forgot to shut down, a reload) would silently win; replace it instead.
  if (!trace.setGlobalTracerProvider(provider)) {
    trace.disable();
    trace.setGlobalTracerProvider(provider);
  }
  state.provider = provider;
  state.tracer = trace.getTracer(INSTRUMENTATION_SCOPE, config.appVersion);
  state.enabled = true;
  log.info("telemetry.enabled", { serviceName, exporter: opts.exporter ? "custom" : "otlp-http", processor: mode });
  return { enabled: true };
}

/**
 * Only spans from Foreman's own instrumentation scope reach the exporter. The global provider is also what any
 * other `@opentelemetry/api` user in the process reports to — in the web process that is Next.js's built-in
 * tracer (scope `next.js`: request, render and route-handler spans carrying URLs and status codes). Those are
 * outside the attribute allowlist in docs/OTEL.md and are dropped here, so "every exported attribute key is in
 * ALLOWED_ATTRIBUTE_KEYS" holds for the process, not just for the spans the runtime creates.
 */
function onlyForemanSpans(inner: SpanProcessor): SpanProcessor {
  return {
    onStart: (span, parentContext) => inner.onStart(span, parentContext),
    onEnd: (span) => {
      if (span.instrumentationScope.name === INSTRUMENTATION_SCOPE) inner.onEnd(span);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
}

/**
 * OTLP over HTTP with the JSON encoding (`Content-Type: application/json`, hex trace and span ids), which is what
 * `@opentelemetry/exporter-trace-otlp-http` speaks; the protobuf flavour is a different package. The endpoint and
 * headers come from the standard variables the exporter reads itself (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
 * OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS), defaulting to http://localhost:4318/v1/traces — a
 * collector on the same machine, nothing leaves it unless you point it elsewhere.
 */
async function createOtlpExporter(): Promise<SpanExporter> {
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  return new OTLPTraceExporter();
}

/** Flush and release the provider. Spans of slices still in flight are ended so they are not lost on shutdown. */
export async function shutdownTelemetry(): Promise<void> {
  const provider = state.provider;
  state.enabled = false;
  state.tracer = null;
  state.provider = null;
  for (const entry of state.runs.values()) entry.span.end();
  state.runs.clear();
  if (provider) {
    try {
      await provider.forceFlush();
    } catch (e) {
      log.warn("telemetry.flush_failed", { err: e });
    }
    await provider.shutdown();
  }
  // Unregisters the global provider so a later init (tests, a restarted worker in-process) can register again.
  trace.disable();
}

export function isTelemetryEnabled(): boolean {
  return state.enabled;
}
