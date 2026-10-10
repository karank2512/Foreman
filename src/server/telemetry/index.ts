import { beginRunSlice, endRunSlice, recordCheckpointed, recordPaused, recordToolCallDecision, recordToolInvocation } from "./events";

/**
 * Telemetry public surface (docs/OTEL.md).
 *
 * Opt-in OpenTelemetry export of the approval lifecycle: `initTelemetry()` in the worker turns it on when
 * OTEL_ENABLED=true; the `telemetry` hooks are called by the runtime and are no-ops otherwise. A leaf module:
 * it depends only on `db`, `config` and `log`, and no other module may depend on its internals.
 */

export { initTelemetry, isTelemetryEnabled, shutdownTelemetry, INSTRUMENTATION_SCOPE, type TelemetryOptions } from "./provider";
export { checkpointId } from "./events";
export * from "./types";

/** Recording hooks for the runtime. Every one is a no-op while telemetry is disabled and never throws. */
export const telemetry = {
  beginRunSlice,
  endRunSlice,
  recordCheckpointed,
  recordPaused,
  recordToolCallDecision,
  recordToolInvocation,
} as const;
