import { z } from "zod";

/**
 * Boot-time environment validation. `assertValidEnv()` runs once when the web server (instrumentation.ts)
 * and the worker (src/worker.ts) start, so a misconfigured deploy fails immediately with a readable list of
 * problems instead of on the first request that happens to need the missing value.
 *
 * Runtime code keeps reading settings through `config` (lazy getters, so tests can mutate process.env);
 * this module only decides whether the process is allowed to start.
 */

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.url().optional());

const base64Key32 = z.string().refine((v) => {
  try {
    return Buffer.from(v, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be base64 that decodes to exactly 32 bytes (openssl rand -base64 32)");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "is required").refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL"),

  AUTH_SECRET: z.string().min(1, "is required"),
  AUTH_SECRET_PREVIOUS: z.string().optional(),
  AUTH_URL: optionalUrl,
  NEXTAUTH_URL: optionalUrl,
  AUTH_TRUST_HOST: bool,

  CREDENTIAL_ENCRYPTION_KEY: base64Key32,
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: base64Key32.optional(),

  EXECUTOR_MODE: z.enum(["inline", "off"]).optional(),
  EXECUTOR_DISABLED: bool,
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).optional(),

  SIGNUP_MODE: z.enum(["open", "invite", "closed"]).optional(),
  SIGNUP_INVITE_CODE: z.string().optional(),
  DEMO_MODE: bool,
  ALLOW_DEMO_SEED: bool,
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).optional(),

  PLATFORM_DEFAULT_MONTHLY_BUDGET_USD: z.coerce.number().min(0).optional(),
  PLATFORM_MAX_COST_PER_RUN_USD: z.coerce.number().positive().optional(),
  PLATFORM_MAX_TOOL_CALLS_PER_RUN: z.coerce.number().int().positive().optional(),
  PLATFORM_MAX_RUN_DURATION_SEC: z.coerce.number().int().positive().optional(),
  RATE_LIMIT_DISABLED: bool,

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  LOG_FORMAT: z.enum(["json", "pretty"]).optional(),
  APP_VERSION: z.string().optional(),

  RETENTION_TRACE_DAYS: z.coerce.number().int().min(1).optional(),
  RETENTION_EVENTS_DAYS: z.coerce.number().int().min(1).optional(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

/** Extra rules that only apply to production deployments. */
function productionProblems(env: AppEnv): string[] {
  const problems: string[] = [];
  if (env.AUTH_SECRET.length < 32) problems.push("AUTH_SECRET must be at least 32 characters in production (openssl rand -base64 32)");
  const publicUrl = env.AUTH_URL ?? env.NEXTAUTH_URL;
  if (!publicUrl) problems.push("AUTH_URL is required in production (the public https:// origin, e.g. https://app.example.com)");
  // Plain http is only for the self-hosted stack on your own machine (docker-compose.yml). The pattern is anchored
  // so a public host that merely starts with "localhost" (http://localhost.example.com) does not qualify.
  else if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(publicUrl)) {
    problems.push("AUTH_URL must be an https:// URL in production (plain http is only allowed for localhost)");
  }
  if (env.SIGNUP_MODE === "invite" && !env.SIGNUP_INVITE_CODE) {
    problems.push("SIGNUP_INVITE_CODE is required when SIGNUP_MODE=invite");
  }
  if (env.SIGNUP_INVITE_CODE && env.SIGNUP_INVITE_CODE.length < 12) problems.push("SIGNUP_INVITE_CODE must be at least 12 characters");
  if (env.RATE_LIMIT_DISABLED) problems.push("RATE_LIMIT_DISABLED must not be set in production");
  if (env.DATABASE_URL.includes("sslmode=disable")) problems.push("DATABASE_URL must not disable TLS in production (remove sslmode=disable)");
  return problems;
}

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  • ${p}`).join("\n")}`);
    this.name = "EnvError";
  }
}

/** Parse + validate process.env. Throws EnvError listing every problem at once. */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"} ${i.message}`));
  }
  if (parsed.data.NODE_ENV === "production") {
    const problems = productionProblems(parsed.data);
    if (problems.length > 0) throw new EnvError(problems);
  }
  return parsed.data;
}

let validated = false;

/** Call once at process start (web + worker). Idempotent. */
export function assertValidEnv(): void {
  if (validated) return;
  validateEnv();
  validated = true;
}
