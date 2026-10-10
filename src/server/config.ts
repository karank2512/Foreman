/**
 * Central, typed access to runtime configuration. Read lazily so tests can mutate process.env.
 * Boot-time validation of these same variables lives in `env.ts` (assertValidEnv).
 */
const bool = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
const num = (v: string | undefined, fallback: number) => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const isProduction = () => process.env.NODE_ENV === "production";

export type SignupMode = "open" | "invite" | "closed";

export const config = {
  get isProduction() {
    return isProduction();
  },
  get forceSimulated() {
    return bool(process.env.FORCE_SIMULATED);
  },
  /** Deployed build identifier (git sha), reported by /api/health. */
  get appVersion() {
    return process.env.APP_VERSION ?? "dev";
  },
  /** Public origin of the app (https://app.example.com). Undefined in local dev without AUTH_URL. */
  get publicUrl(): string | undefined {
    return process.env.AUTH_URL || process.env.NEXTAUTH_URL || undefined;
  },

  executor: {
    /**
     * "inline" = the web process runs the executor via instrumentation.ts (local dev default).
     * "off" = the web process never executes runs; a separate `npm run worker` process does (production default).
     */
    get mode(): "inline" | "off" {
      const explicit = process.env.EXECUTOR_MODE;
      if (explicit === "inline" || explicit === "off") return explicit;
      if (bool(process.env.EXECUTOR_DISABLED)) return "off";
      return isProduction() ? "off" : "inline";
    },
    /** @deprecated use `mode`; kept for existing callers. true when the web process must not run the executor. */
    get disabled() {
      return this.mode === "off";
    },
    get pollMs() {
      return num(process.env.EXECUTOR_POLL_MS, 1000);
    },
    get concurrency() {
      return num(process.env.EXECUTOR_CONCURRENCY, 2);
    },
    /** A RUNNING run whose heartbeat is older than this is considered crashed and is recovered. */
    get staleLockMs() {
      return num(process.env.EXECUTOR_STALE_LOCK_MS, 120_000);
    },
    get schedulerTickMs() {
      return num(process.env.SCHEDULER_TICK_MS, 30_000);
    },
    /** How long a stopping worker waits for in-flight runs before handing their leases back. */
    get shutdownGraceMs() {
      return num(process.env.SHUTDOWN_GRACE_MS, 20_000);
    },
  },

  usage: {
    /** billableUsd = costUsd × marginMultiplier */
    get marginMultiplier() {
      return num(process.env.USAGE_MARGIN_MULTIPLIER, 1.4);
    },
  },

  auth: {
    /** Self-serve sign-up: open to anyone, gated by SIGNUP_INVITE_CODE, or closed (invites only). */
    get signupMode(): SignupMode {
      const v = process.env.SIGNUP_MODE;
      if (v === "open" || v === "invite" || v === "closed") return v;
      return isProduction() ? "closed" : "open";
    },
    get signupInviteCode(): string | undefined {
      return process.env.SIGNUP_INVITE_CODE || undefined;
    },
    /** Demo workspace (pre-filled credentials, seeded org sign-in). Never on in production unless explicitly set. */
    get demoMode() {
      return bool(process.env.DEMO_MODE);
    },
    get allowDemoSeed() {
      return bool(process.env.ALLOW_DEMO_SEED) || !isProduction();
    },
    /** Sliding session lifetime (seconds). */
    sessionMaxAgeSec: 12 * 60 * 60,
    /** How often an active session's cookie is refreshed (seconds). */
    sessionUpdateAgeSec: 15 * 60,
    /** Absolute session lifetime regardless of activity (seconds). */
    sessionAbsoluteMaxSec: 7 * 24 * 60 * 60,
    /** Number of reverse proxies in front of the app whose X-Forwarded-For entries are trusted. */
    get trustedProxyHops() {
      return num(process.env.TRUSTED_PROXY_HOPS, isProduction() ? 1 : 0);
    },
    passwordMinLength: 12,
    passwordMaxLength: 128,
    bcryptRounds: 12,
    invitationTtlDays: 7,
  },

  limits: {
    get rateLimitDisabled() {
      return bool(process.env.RATE_LIMIT_DISABLED) && !isProduction();
    },
    /** Default monthly cap on REAL provider spend per org when Organization.monthlyBudgetUsd is null. */
    get defaultMonthlyBudgetUsd() {
      return num(process.env.PLATFORM_DEFAULT_MONTHLY_BUDGET_USD, 25);
    },
    /** Platform ceilings — a blueprint's own limits are clamped to these. */
    get maxCostPerRunUsd() {
      return num(process.env.PLATFORM_MAX_COST_PER_RUN_USD, 5);
    },
    get maxToolCallsPerRun() {
      return num(process.env.PLATFORM_MAX_TOOL_CALLS_PER_RUN, 60);
    },
    get maxRunDurationSec() {
      return num(process.env.PLATFORM_MAX_RUN_DURATION_SEC, 1800);
    },
    /** Per-worker cap on QUEUED + RUNNING + WAITING_FOR_APPROVAL runs. */
    maxInFlightRunsPerWorker: 3,
  },

  retention: {
    /** ModelCall request/response payloads and RunStep input/output are cleared after this many days. */
    get traceDays() {
      return num(process.env.RETENTION_TRACE_DAYS, 30);
    },
    /** ActivityEvent + SecurityEvent rows are deleted after this many days. */
    get eventsDays() {
      return num(process.env.RETENTION_EVENTS_DAYS, 365);
    },
  },

  telemetry: {
    /** Opt-in OpenTelemetry trace export from the worker (docs/OTEL.md). Off: nothing is loaded, nothing is sent. */
    get enabled() {
      return bool(process.env.OTEL_ENABLED);
    },
    /** `service.name` on the exported resource. */
    get serviceName() {
      return process.env.OTEL_SERVICE_NAME || "foreman-worker";
    },
  },

  log: {
    get level(): "debug" | "info" | "warn" | "error" {
      const v = process.env.LOG_LEVEL;
      return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
    },
    get format(): "json" | "pretty" {
      if (isProduction()) return "json";
      return process.env.LOG_FORMAT === "json" ? "json" : "pretty";
    },
  },
} as const;
