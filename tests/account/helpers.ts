import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { RATE_RULES, resetLimit } from "@/server/security";

/** A password that satisfies the policy and is unique per test, so nothing can be reused by accident. */
export function strongPassword(label = "pass"): string {
  return `${label}-brisk-lantern-${randomUUID().slice(0, 6)}`;
}

export const uniqueEmail = (label = "member") => `${label}-${randomUUID().slice(0, 8)}@example.test`;

/** Rate-limit subjects are opaque strings; a fresh one per test guarantees a fresh bucket. */
export const uniqueIp = () => `test-ip-${randomUUID()}`;

/** Delete organizations created by a test (all tenant tables cascade from Organization). */
export async function dropOrgs(...organizationIds: Array<string | undefined>): Promise<void> {
  for (const id of organizationIds) {
    if (id) await db.organization.deleteMany({ where: { id } });
  }
}

/** Temporarily set environment variables for one test, restoring exactly what was there before. */
export async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Run `fn` with the limiter live (the global test setup turns it off), then clear the buckets it touched.
 * Rate-limit assertions must do this explicitly so no other test inherits a half-full bucket.
 */
export async function withRateLimiting(
  subjects: { ips?: string[]; orgIds?: string[]; userIds?: string[] },
  fn: () => Promise<void>,
): Promise<void> {
  await withEnv({ RATE_LIMIT_DISABLED: undefined }, async () => {
    try {
      await fn();
    } finally {
      for (const ip of subjects.ips ?? []) {
        await resetLimit(RATE_RULES.signUpIp, ip);
        await resetLimit(RATE_RULES.inviteAcceptIp, ip);
        await resetLimit(RATE_RULES.passwordResetIp, ip);
      }
      for (const orgId of subjects.orgIds ?? []) await resetLimit(RATE_RULES.invitesCreateOrg, orgId);
      for (const userId of subjects.userIds ?? []) await resetLimit(RATE_RULES.passwordChangeUser, userId);
    }
  });
}
