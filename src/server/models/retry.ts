import { isQuotaExhausted } from "./provider-errors";

/**
 * Our own retry policy for live provider calls (the SDK's is disabled with `maxRetries: 0` so attempts, backoff and
 * the final error are under our control). Error classification is structural — no SDK import needed.
 */

const TRANSIENT_STATUS = new Set([408, 409, 425, 429]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const MAX_RETRY_AFTER_MS = 30_000;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  statusCode?: unknown;
  isRetryable?: unknown;
  responseHeaders?: unknown;
  cause?: unknown;
}

function asErrorLike(e: unknown): ErrorLike | null {
  return e !== null && typeof e === "object" ? (e as ErrorLike) : null;
}

/** 429 / 5xx / timeouts / network failures. Looks through `cause` because fetch wraps the socket error. */
export function isTransientError(e: unknown, depth = 0): boolean {
  const err = asErrorLike(e);
  if (!err || depth > 3) return false;

  // An empty balance answers 429 on OpenAI, but no amount of waiting refills it.
  if (isQuotaExhausted(err)) return false;
  if (typeof err.statusCode === "number") return err.statusCode >= 500 || TRANSIENT_STATUS.has(err.statusCode);
  if (err.isRetryable === true) return true;
  if (err.name === "TimeoutError") return true;
  if (typeof err.code === "string" && TRANSIENT_NETWORK_CODES.has(err.code)) return true;
  if (err.name === "TypeError" && typeof err.message === "string" && /fetch failed|network/i.test(err.message)) return true;
  return isTransientError(err.cause, depth + 1);
}

function retryAfterMs(e: unknown): number | null {
  const headers = asErrorLike(e)?.responseHeaders;
  if (headers === null || typeof headers !== "object") return null;
  const raw = (headers as Record<string, unknown>)["retry-after"];
  const seconds = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

export interface RetryOptions {
  /** Retries AFTER the first attempt. Default 2 (three attempts in total). */
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withTransientRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 2, baseDelayMs = 750, sleep = defaultSleep } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isTransientError(e)) throw e;
      await sleep(retryAfterMs(e) ?? baseDelayMs * 2 ** attempt);
    }
  }
}
