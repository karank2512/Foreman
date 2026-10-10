import { trace } from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { config } from "@/server/config";
import { logger } from "@/server/log";
import { state } from "./state";

/**
 * Provider lifecycle. `initTelemetry()` is called once by the worker (src/worker.ts) and by the telemetry tests;
 * everything else in the module is a no-op until it has run with `enabled: true`.
 *
 * The SDK (`@opentelemetry/sdk-trace-base`), the resource helpers and the OTLP exporter are imported dynamically
 * inside this function so that a worker with OTEL_ENABLED=false never evaluates them: no background timers, no
 * sockets, no network calls — the opt-out costs nothing.
 */

const log = logger.child({ component: "telemetry" });

/** Instrumentation scope reported on every span (`InstrumentationScope.name`). */
export const INSTRUMENTATION_SCOPE = "foreman.runtime";

export interface TelemetryOptions {
  /** Defaults to `config.telemetry.enabled` (OTEL_ENABLED). */
  enabled?: boolean;
  /** Defaults to `config.telemetry.serviceName` (OTEL_SERVICE_NAME, else "foreman-worker"). */
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
  const resource = resources.defaultResource().merge(
    resources.resourceFromAttributes({
      "service.name": opts.serviceName ?? config.telemetry.serviceName,
      "service.version": config.appVersion,
    }),
  );
  const provider = new sdk.BasicTracerProvider({ resource, spanProcessors: [processor] });
  // A previous provider (a test that forgot to shut down, a reload) would silently win; replace it instead.
  if (!trace.setGlobalTracerProvider(provider)) {
    trace.disable();
    trace.setGlobalTracerProvider(provider);
  }
  state.provider = provider;
  state.tracer = trace.getTracer(INSTRUMENTATION_SCOPE, config.appVersion);
  state.enabled = true;
  log.info("telemetry.enabled", { exporter: opts.exporter ? "custom" : "otlp-http", processor: mode });
  return { enabled: true };
}

/**
 * OTLP over HTTP/protobuf. The endpoint and headers come from the standard variables the exporter reads itself
 * (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS), defaulting to
 * http://localhost:4318/v1/traces — a collector on the same machine, nothing leaves it unless you point it elsewhere.
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
