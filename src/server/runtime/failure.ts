import { errorMessage, isAppError, type AppErrorCode } from "@/server/errors";
import { isProviderSetupFailure } from "@/server/models";
import { redactSecrets } from "@/server/security";
import { oneLine } from "./compact";

/**
 * Executor control flow.
 *
 * `LockLost` is thrown by every fenced Run write whose guard matched nothing (the run was cancelled, recovered
 * by another executor, or finished elsewhere). It is a signal, not an error: the slice stops immediately and
 * writes nothing further. `RunFailure` is what a component raises when the run genuinely failed; its
 * `retryable` flag decides between a backoff re-queue and a terminal FAILED.
 */

export class LockLost extends Error {
  constructor(message = "Run lock lost") {
    super(message);
    this.name = "LockLost";
  }
}

export class RunFailure extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;
  /**
   * The model provider refused the setup (bad key, no credits, no access, unknown model id). Says nothing about the
   * worker, so the run is recorded as failed but kept out of its score and health (see evaluation/score.ts).
   */
  readonly providerSetup: boolean;

  constructor(code: AppErrorCode, message: string, retryable: boolean, opts: { providerSetup?: boolean } = {}) {
    super(message);
    this.name = "RunFailure";
    this.code = code;
    this.retryable = retryable;
    this.providerSetup = opts.providerSetup ?? false;
  }
}

/**
 * The run can no longer go anywhere useful and must end as CANCELLED (today: its worker was retired while it was
 * in flight — claimNextRun never picks up a retired worker's run, so parking it in QUEUED/WAITING would strand it).
 */
export class RunCancelled extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RunCancelled";
  }
}

export const WORKER_RETIRED_REASON = "Cancelled because the worker was retired";

/** Run.error and the ERROR step are shown to every member of the org. */
export const RUN_ERROR_MAX_CHARS = 500;

/**
 * The only text of a failure that reaches the UI (audit F-009): one line, ≤ 500 characters, with anything that
 * looks like a provider key, bearer token or long opaque secret replaced by `[redacted]`. The untruncated
 * message still goes to the server log, where only the operator can read it.
 */
export function publicRunError(message: string): string {
  return oneLine(redactSecrets(message), RUN_ERROR_MAX_CHARS);
}

/** Errors whose cause is the run's own definition or a hard rule: retrying would only repeat them. */
const NON_RETRYABLE: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  "LIMIT_EXCEEDED",
  "VALIDATION",
  "PERMISSION_DENIED",
  "FORBIDDEN",
  "NOT_FOUND",
  "IMMUTABLE_VERSION",
  "INVALID_TRANSITION",
  "CONFLICT",
]);

/**
 * MODEL_ERROR and anything unexpected is retried while attempts remain; rule violations are not, and neither is a
 * provider refusing the setup — a rejected key or an empty balance fails the same way on every attempt, so the fix
 * message should land at once instead of after a backoff.
 */
export function toRunFailure(e: unknown): RunFailure {
  if (e instanceof RunFailure) return e;
  if (isProviderSetupFailure(e)) return new RunFailure("MODEL_ERROR", errorMessage(e), false, { providerSetup: true });
  if (isAppError(e)) return new RunFailure(e.code, e.message, !NON_RETRYABLE.has(e.code));
  return new RunFailure("INTERNAL", errorMessage(e), true);
}
