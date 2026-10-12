/**
 * Next.js instrumentation hooks for the web process.
 *
 * `register()` runs once per server process (the Edge runtime calls it too, so every server module is imported
 * lazily behind the nodejs check). It validates the environment so a misconfigured production deploy fails at
 * boot instead of on the first request that needs the missing value, and turns on the opt-in OpenTelemetry
 * export (docs/OTEL.md) so a reviewer's decision made here is traced like the run it belongs to.
 *
 * It deliberately does NOT start the run executor: runs are executed by `src/worker.ts` in every environment
 * (`npm run dev` starts web + worker together), so scaling the web tier never changes run concurrency.
 */

interface RequestErrorInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

interface RequestErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` loads this module too. A build machine has no production secrets and runs no traffic, so it
  // must neither fail on them nor start claiming runs.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const [{ config }, { assertValidEnv, EnvError }, { logger }] = await Promise.all([
    import("@/server/config"),
    import("@/server/env"),
    import("@/server/log"),
  ]);
  const log = logger.child({ component: "boot" });

  try {
    assertValidEnv();
  } catch (e) {
    const problems = e instanceof EnvError ? e.problems : [e instanceof Error ? e.message : String(e)];
    log.error("boot.invalid_environment", { problems });
    // A broken production deploy must not come up and serve half-working pages; locally it is only a warning so
    // the dev server still starts while you fix .env.
    if (config.isProduction) throw e;
  }

  // Opt-in OpenTelemetry (OTEL_ENABLED=true, docs/OTEL.md). What the web process emits is what happens here: a
  // reviewer's `allow` / `deny` on its own `tool_call_decision` span, correlated with the worker's traces by the
  // run and tool-call ids. Imported only when the flag is on, so the opt-out loads nothing (and the Edge compiler
  // resolves this specifier to an empty module, see next.config.ts).
  if (config.telemetry.enabled) {
    try {
      const { initTelemetry } = await import("@/server/telemetry");
      // Every span is exported as it ends. Next.js has no shutdown hook to flush a batch from (its own signal
      // handlers exit the process at once), and a decision span is the only thing this process produces.
      await initTelemetry({ serviceName: config.telemetry.webServiceName, processor: "simple" });
      log.info("boot.telemetry_enabled", { serviceName: config.telemetry.webServiceName });
    } catch (e) {
      // A tracing problem is logged and the web server comes up without it rather than not at all.
      log.error("boot.telemetry_failed", { err: e });
    }
  }

  // Runs are always executed by the separate worker process (`npm run worker`; `npm run dev` starts both).
  // The web server must never import @/server/runtime: Next compiles instrumentation.ts for the Edge runtime
  // too, where the tools layer's Node built-ins (node:net, node:dns, node:http) cannot be bundled.
  log.info("boot.executor_external", {
    mode: config.executor.mode,
    hint: config.executor.mode === "inline" ? "run `npm run worker` (or `npm run dev`) to execute queued runs" : undefined,
  });
}

/**
 * Next 15 error hook. `error.tsx` only ever shows the user a digest, so this is what ties that digest to the
 * actual error, route and request in the logs.
 */
export async function onRequestError(error: unknown, request: RequestErrorInfo, context: RequestErrorContext): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("@/server/log");
  const digest = typeof (error as { digest?: unknown })?.digest === "string" ? (error as { digest: string }).digest : undefined;
  logger.child({ component: "request" }).error("request.failed", {
    digest,
    path: request.path,
    method: request.method,
    routeType: context.routeType,
    routePath: context.routePath,
    err: error,
  });
}
