import { createHash } from "node:crypto";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { AppError, errorMessage } from "@/server/errors";
import { recordSecurityEvent } from "./audit";
import { securityLog } from "./log";

/**
 * Postgres-backed fixed-window rate limiter (F-002, INF-05). Every hit is ONE atomic statement
 * (`INSERT … ON CONFLICT DO UPDATE`), so concurrent requests on any number of instances agree on the count,
 * and all DateTime comparisons use bound JS `Date`s (never the session time zone) per the DB rules.
 *
 * Failure policy: auth rules fail CLOSED (a database outage must not open the sign-in door), everything else
 * fails OPEN so a blip cannot lock the product. All of it is a no-op when `config.limits.rateLimitDisabled`.
 */

export interface RateRule {
  name: string;
  limit: number;
  windowSec: number;
}

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const RATE_RULES = {
  /** Per sha256(email). Callers `lock()` this one after a burst of failures (exponential backoff). */
  signInAccount: { name: "signin:account", limit: 5, windowSec: 15 * MIN },
  signInIp: { name: "signin:ip", limit: 30, windowSec: 15 * MIN },
  signUpIp: { name: "signup:ip", limit: 5, windowSec: HOUR },
  inviteAcceptIp: { name: "invite:accept:ip", limit: 20, windowSec: HOUR },
  /** Submitting a password-reset link. */
  passwordResetIp: { name: "password:reset:ip", limit: 20, windowSec: HOUR },
  invitesCreateOrg: { name: "invite:create:org", limit: 30, windowSec: DAY },
  passwordChangeUser: { name: "password:change:user", limit: 5, windowSec: HOUR },
  /** Every action that calls an LLM. */
  llmUser: { name: "llm:user", limit: 30, windowSec: 10 * MIN },
  llmOrg: { name: "llm:org", limit: 300, windowSec: DAY },
  /** Run now, retry, hire-with-first-run. */
  runOrg: { name: "run:org", limit: 60, windowSec: HOUR },
  credentialsOrg: { name: "credentials:org", limit: 20, windowSec: HOUR },
  /** GET /api/runs/[runId] — the run page polls every 1.5 s per open tab. */
  pollUser: { name: "poll:user", limit: 240, windowSec: MIN },
} as const satisfies Record<string, RateRule>;

export type RateRuleName = keyof typeof RATE_RULES;

/** Rules that guard authentication: on a database error they DENY rather than allow. */
const FAIL_CLOSED = new Set<string>([
  RATE_RULES.signInAccount.name,
  RATE_RULES.signInIp.name,
  RATE_RULES.signUpIp.name,
  RATE_RULES.inviteAcceptIp.name,
  RATE_RULES.passwordResetIp.name,
  RATE_RULES.passwordChangeUser.name,
]);

/** How a blocked rule attributes its SecurityEvent (the subject is an org id, a user id, or opaque). */
const SUBJECT_KIND: Record<string, "org" | "user" | undefined> = {
  [RATE_RULES.invitesCreateOrg.name]: "org",
  [RATE_RULES.llmOrg.name]: "org",
  [RATE_RULES.runOrg.name]: "org",
  [RATE_RULES.credentialsOrg.name]: "org",
  [RATE_RULES.llmUser.name]: "user",
  [RATE_RULES.pollUser.name]: "user",
  [RATE_RULES.passwordChangeUser.name]: "user",
};

/** Lockouts double each time: 1× the window, then 2×, 4× … capped at 24 h. */
const MAX_LOCK_MS = DAY * 1000;
const MAX_LOCK_DOUBLINGS = 20;
/** Buckets untouched for this long are swept away. */
const SWEEP_IDLE_MS = 2 * DAY * 1000;
const DB_ERROR_RETRY_SEC = 60;

export interface RateHit {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

interface BucketRow {
  count: number;
  windowStart: Date;
  lockedUntil: Date | null;
  lockCount: number;
}

/** Hashed so the table never holds an email address, and every key is a bounded, safe string. */
function bucketKey(rule: RateRule, subject: string): string {
  const digest = createHash("sha256").update(subject).digest("base64url").slice(0, 32);
  return `${rule.name}:${digest}`;
}

const secondsUntil = (when: Date, now: Date): number => Math.max(1, Math.ceil((when.getTime() - now.getTime()) / 1000));

function onDbError(rule: RateRule, e: unknown): RateHit {
  const failClosed = FAIL_CLOSED.has(rule.name);
  securityLog(failClosed ? "error" : "warn", "ratelimit.unavailable", {
    rule: rule.name,
    mode: failClosed ? "fail-closed" : "fail-open",
    error: errorMessage(e),
  });
  return failClosed
    ? { allowed: false, count: 0, retryAfterSec: Math.min(rule.windowSec, DB_ERROR_RETRY_SEC) }
    : { allowed: true, count: 0, retryAfterSec: 0 };
}

/**
 * Count one attempt against `rule` for `subject` and say whether it may proceed. A bucket whose window has
 * expired restarts at 1 inside the same statement, so there is no read-then-write race.
 */
export async function hit(rule: RateRule, subject: string): Promise<RateHit> {
  if (config.limits.rateLimitDisabled) return { allowed: true, count: 0, retryAfterSec: 0 };
  const key = bucketKey(rule, subject);
  const now = new Date();
  const windowFloor = new Date(now.getTime() - rule.windowSec * 1000);

  try {
    const rows = await db.$queryRaw<BucketRow[]>`
      INSERT INTO "RateLimitBucket" ("key", "count", "windowStart", "lockCount", "updatedAt")
      VALUES (${key}, 1, ${now}, 0, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimitBucket"."windowStart" < ${windowFloor} THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
        "windowStart" = CASE WHEN "RateLimitBucket"."windowStart" < ${windowFloor} THEN ${now} ELSE "RateLimitBucket"."windowStart" END,
        "updatedAt" = ${now}
      RETURNING "count", "windowStart", "lockedUntil", "lockCount"
    `;
    const row = rows[0];
    if (!row) return onDbError(rule, new Error("no row returned"));

    if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) {
      return { allowed: false, count: row.count, retryAfterSec: secondsUntil(row.lockedUntil, now) };
    }
    if (row.count <= rule.limit) return { allowed: true, count: row.count, retryAfterSec: 0 };
    const windowEnd = new Date(row.windowStart.getTime() + rule.windowSec * 1000);
    return { allowed: false, count: row.count, retryAfterSec: secondsUntil(windowEnd, now) };
  } catch (e) {
    return onDbError(rule, e);
  }
}

/** Humanized wait — "20 s", "4 min", "2 h" — because this lands in a toast the user reads. */
export function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 90 * MIN) return `${Math.round(seconds / MIN)} min`;
  return `${Math.round(seconds / HOUR)} h`;
}

/** `hit` + throw. Records a RATE_LIMITED security event when it blocks. */
export async function enforce(rule: RateRule, subject: string): Promise<void> {
  const result = await hit(rule, subject);
  if (result.allowed) return;

  // Only the FIRST block in a window is audited: otherwise someone hammering a blocked endpoint would turn
  // one refused request into one database write each.
  if (result.count === rule.limit + 1) {
    const kind = SUBJECT_KIND[rule.name];
    await recordSecurityEvent({
      type: "RATE_LIMITED",
      organizationId: kind === "org" ? subject : undefined,
      userId: kind === "user" ? subject : undefined,
      metadata: { rule: rule.name, count: result.count, retryAfterSec: result.retryAfterSec },
    });
  }

  throw new AppError("LIMIT_EXCEEDED", `You're doing that too often. Try again in ${formatWait(result.retryAfterSec)}.`);
}

/** Is this subject currently locked out? Checked BEFORE the password compare on the sign-in path. */
export async function isLocked(rule: RateRule, subject: string): Promise<{ locked: boolean; retryAfterSec: number }> {
  if (config.limits.rateLimitDisabled) return { locked: false, retryAfterSec: 0 };
  const now = new Date();
  try {
    const row = await db.rateLimitBucket.findUnique({
      where: { key: bucketKey(rule, subject) },
      select: { lockedUntil: true },
    });
    if (!row?.lockedUntil || row.lockedUntil.getTime() <= now.getTime()) return { locked: false, retryAfterSec: 0 };
    return { locked: true, retryAfterSec: secondsUntil(row.lockedUntil, now) };
  } catch (e) {
    const fallback = onDbError(rule, e);
    return { locked: !fallback.allowed, retryAfterSec: fallback.retryAfterSec };
  }
}

/**
 * Lock this subject out. The lockout is `windowSec × 2^lockCount` (capped at 24 h) and `lockCount` is
 * incremented in the same statement, so repeated abuse backs off exponentially. `resetLimit` clears it.
 */
export async function lock(rule: RateRule, subject: string): Promise<{ lockedUntil: Date }> {
  const now = new Date();
  if (config.limits.rateLimitDisabled) return { lockedUntil: now };
  const key = bucketKey(rule, subject);
  const baseMs = rule.windowSec * 1000;

  try {
    const rows = await db.$queryRaw<Array<{ lockedUntil: Date | null }>>`
      INSERT INTO "RateLimitBucket" ("key", "count", "windowStart", "lockCount", "lockedUntil", "updatedAt")
      VALUES (
        ${key},
        0,
        ${now},
        1,
        ${now}::timestamptz + (LEAST(${baseMs}::double precision, ${MAX_LOCK_MS}::double precision) * interval '1 millisecond'),
        ${now}
      )
      ON CONFLICT ("key") DO UPDATE SET
        "lockCount" = "RateLimitBucket"."lockCount" + 1,
        "lockedUntil" = ${now}::timestamptz + (
          LEAST(
            ${baseMs}::double precision * power(2, LEAST("RateLimitBucket"."lockCount", ${MAX_LOCK_DOUBLINGS})),
            ${MAX_LOCK_MS}::double precision
          ) * interval '1 millisecond'
        ),
        "count" = 0,
        "windowStart" = ${now},
        "updatedAt" = ${now}
      RETURNING "lockedUntil"
    `;
    return { lockedUntil: rows[0]?.lockedUntil ?? new Date(now.getTime() + baseMs) };
  } catch (e) {
    securityLog("error", "ratelimit.lock_failed", { rule: rule.name, error: errorMessage(e) });
    // Fail closed for the caller's decision: report a lock even though we could not persist it.
    return { lockedUntil: new Date(now.getTime() + baseMs) };
  }
}

/** Clear the counter AND the lockout — called after a successful sign-in / password change. */
export async function resetLimit(rule: RateRule, subject: string): Promise<void> {
  if (config.limits.rateLimitDisabled) return;
  try {
    await db.rateLimitBucket.deleteMany({ where: { key: bucketKey(rule, subject) } });
  } catch (e) {
    securityLog("warn", "ratelimit.reset_failed", { rule: rule.name, error: errorMessage(e) });
  }
}

/** Housekeeping for the maintenance tick: drop buckets idle for over two days that are not still locked. */
export async function sweepRateLimits(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SWEEP_IDLE_MS);
  const { count } = await db.rateLimitBucket.deleteMany({
    where: {
      updatedAt: { lt: cutoff },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
  });
  return count;
}
