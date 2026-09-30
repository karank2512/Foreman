import { randomBytes } from "node:crypto";
import type { AppErrorCode } from "@/server/errors";
import { errorMessage, isAppError } from "@/server/errors";
import { securityLog } from "./log";
import { redactAndClip } from "./redact";

/**
 * Client-safe error text (F-009, INF-13). Internal failures never reach a tenant: they become one generic
 * sentence plus a short reference, and the real cause is logged under that reference so support can find it.
 */

export const GENERIC_PUBLIC_ERROR = "Something went wrong. Please try again.";

/** AppError codes whose message is written FOR the user and is safe to show verbatim. */
export const CLIENT_SAFE_ERROR_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHENTICATED",
  "VALIDATION",
  "CONFLICT",
  "IMMUTABLE_VERSION",
  "INVALID_TRANSITION",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "LIMIT_EXCEEDED",
]);

const PUBLIC_TEXT: Partial<Record<AppErrorCode, string>> = {
  MODEL_ERROR: "The AI model is unavailable right now. Please try again shortly.",
  TOOL_ERROR: "A tool this worker relies on did not respond. Please try again shortly.",
};

/**
 * Provider failures whose MODEL_ERROR message names the fix ("Anthropic rejected the API key — check
 * ANTHROPIC_API_KEY …"). Those messages are written by providerFailureMessage in src/server/models/provider-errors.ts
 * and never carry provider text (that stays in `details.providerMessage`), so they are shown as they are: on a
 * self-hosted install the person reading them is the one who can fix the key. "Try again shortly" would send them
 * off to wait for something that will never recover on its own. Read structurally, because models depends on
 * security and not the other way round.
 */
const ACTIONABLE_MODEL_FAILURES: ReadonlySet<string> = new Set([
  "auth",
  "permission",
  "quota",
  "model_not_found",
  "rate_limit",
  "refused",
]);

function actionableModelMessage(e: unknown): string | undefined {
  if (!isAppError(e) || e.code !== "MODEL_ERROR") return undefined;
  const kind = (e.details as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && ACTIONABLE_MODEL_FAILURES.has(kind) ? e.message : undefined;
}

const MAX_LOGGED_MESSAGE_CHARS = 500;

/** Short, non-guessable correlation id shown to the user and logged with the real error. */
export function errorRef(): string {
  return randomBytes(3).toString("hex");
}

/**
 * Turn any thrown value into a message that is safe to send to a client. Internals (message, code, provider
 * text, stack) are logged with the returned `ref` and never returned; the one exception is a provider failure
 * whose message is our own instruction for fixing the setup (see ACTIONABLE_MODEL_FAILURES).
 */
export function publicErrorMessage(e: unknown): { message: string; ref: string } {
  const ref = errorRef();
  const code: AppErrorCode | "UNKNOWN" = isAppError(e) ? e.code : "UNKNOWN";
  const base = actionableModelMessage(e) ?? (isAppError(e) ? PUBLIC_TEXT[e.code] : undefined) ?? GENERIC_PUBLIC_ERROR;

  securityLog("error", "internal_error", {
    ref,
    code,
    error: redactAndClip(errorMessage(e), MAX_LOGGED_MESSAGE_CHARS),
    name: e instanceof Error ? e.name : typeof e,
  });

  return { message: `${base} (ref ${ref})`, ref };
}
