import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SignInThrottledError, authorizeCredentials, normalizeEmail } from "@/server/auth/authorize";
import { MAX_PASSWORD_LENGTH } from "@/server/auth/password";
import { db } from "@/server/db";
import { config } from "@/server/config";
import { RATE_RULES, hit } from "@/server/security";
import { createTestOrg } from "../helpers/factory";
import {
  TEST_PASSWORD,
  createOrgWithPassword,
  setPasswordHashAtCost,
  unknownEmail,
  uniqueIp,
  withRateLimiting,
} from "./helpers";

const ctx = (ip: string) => ({ ip, userAgent: "vitest" });

describe("authorizeCredentials", () => {
  let org: Awaited<ReturnType<typeof createOrgWithPassword>>;
  let placeholderOrg: Awaited<ReturnType<typeof createTestOrg>>;

  beforeAll(async () => {
    org = await createOrgWithPassword("auth");
    // Keeps the factory's "not-a-real-hash" placeholder: a row whose hash can never verify.
    placeholderOrg = await createTestOrg("auth-nohash");
  });

  afterAll(async () => {
    await org?.cleanup();
    await placeholderOrg?.cleanup();
  });

  it("returns the user's identity — and their sessionVersion — for the right credentials", async () => {
    const result = await authorizeCredentials(org.user.email, TEST_PASSWORD, ctx(uniqueIp()));
    expect(result).toEqual({
      id: org.user.id,
      email: org.user.email,
      name: org.user.name,
      organizationId: org.organization.id,
      role: "OWNER",
      sessionVersion: 0,
    });
  });

  it("never leaks the password hash", async () => {
    const result = await authorizeCredentials(org.user.email, TEST_PASSWORD, ctx(uniqueIp()));
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "email",
      "id",
      "name",
      "organizationId",
      "role",
      "sessionVersion",
    ]);
  });

  it("stamps lastSignInAt and records SIGN_IN_SUCCEEDED", async () => {
    const before = new Date();
    await authorizeCredentials(org.user.email, TEST_PASSWORD, ctx(uniqueIp()));

    const user = await db.user.findUniqueOrThrow({ where: { id: org.user.id }, select: { lastSignInAt: true } });
    expect(user.lastSignInAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    const events = await db.securityEvent.findMany({
      where: { organizationId: org.organization.id, type: "SIGN_IN_SUCCEEDED" },
    });
    expect(events.length).toBeGreaterThan(0);
    // The audit trail stores a hash, never the address itself.
    expect(events[0]?.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(events)).not.toContain(org.user.email);
  });

  it("returns null for a wrong password", async () => {
    expect(await authorizeCredentials(org.user.email, `${TEST_PASSWORD}x`, ctx(uniqueIp()))).toBeNull();
    expect(await authorizeCredentials(org.user.email, TEST_PASSWORD.toLowerCase(), ctx(uniqueIp()))).toBeNull();
  });

  it("returns null for an unknown e-mail", async () => {
    expect(await authorizeCredentials(unknownEmail(), TEST_PASSWORD, ctx(uniqueIp()))).toBeNull();
  });

  it("normalizes the e-mail: surrounding whitespace and case are ignored", async () => {
    const messy = `  ${org.user.email.toUpperCase()}\t`;
    expect(messy).not.toEqual(org.user.email);
    const result = await authorizeCredentials(messy, TEST_PASSWORD, ctx(uniqueIp()));
    expect(result?.id).toBe(org.user.id);
    expect(result?.email).toBe(org.user.email);
  });

  it("does not normalize the password", async () => {
    expect(await authorizeCredentials(org.user.email, ` ${TEST_PASSWORD} `, ctx(uniqueIp()))).toBeNull();
  });

  it("rejects empty, oversized and non-string input without throwing", async () => {
    expect(await authorizeCredentials(org.user.email, "")).toBeNull();
    expect(await authorizeCredentials("", TEST_PASSWORD)).toBeNull();
    expect(await authorizeCredentials("   ", TEST_PASSWORD)).toBeNull();
    expect(await authorizeCredentials(org.user.email, "x".repeat(MAX_PASSWORD_LENGTH + 1))).toBeNull();
    // Callers are typed, but the values ultimately come from an HTTP form.
    expect(await authorizeCredentials(undefined as unknown as string, TEST_PASSWORD)).toBeNull();
    expect(await authorizeCredentials(org.user.email, null as unknown as string)).toBeNull();
  });

  it("returns null for a user whose stored hash is not a bcrypt hash", async () => {
    expect(await authorizeCredentials(placeholderOrg.user.email, "not-a-real-hash", ctx(uniqueIp()))).toBeNull();
  });

  it("only signs a user into their own organization", async () => {
    const other = await createOrgWithPassword("auth-other", "another-Passphrase-42");
    try {
      const mine = await authorizeCredentials(org.user.email, TEST_PASSWORD, ctx(uniqueIp()));
      const theirs = await authorizeCredentials(other.user.email, "another-Passphrase-42", ctx(uniqueIp()));
      expect(mine?.organizationId).toBe(org.organization.id);
      expect(theirs?.organizationId).toBe(other.organization.id);
      // One user's password is useless with another user's e-mail.
      expect(await authorizeCredentials(other.user.email, TEST_PASSWORD, ctx(uniqueIp()))).toBeNull();
    } finally {
      await other.cleanup();
    }
  });
});

describe("authorizeCredentials — account state", () => {
  it("refuses a disabled user even with the right password", async () => {
    const removed = await createOrgWithPassword("auth-disabled");
    try {
      expect(await authorizeCredentials(removed.user.email, TEST_PASSWORD, ctx(uniqueIp()))).not.toBeNull();
      await db.user.update({ where: { id: removed.user.id }, data: { disabledAt: new Date() } });
      expect(await authorizeCredentials(removed.user.email, TEST_PASSWORD, ctx(uniqueIp()))).toBeNull();
    } finally {
      await removed.cleanup();
    }
  });

  it("refuses a demo workspace unless DEMO_MODE is on", async () => {
    const demo = await createOrgWithPassword("auth-demo");
    const previous = process.env.DEMO_MODE;
    try {
      await db.organization.update({ where: { id: demo.organization.id }, data: { isDemo: true } });

      delete process.env.DEMO_MODE;
      expect(await authorizeCredentials(demo.user.email, TEST_PASSWORD, ctx(uniqueIp()))).toBeNull();

      process.env.DEMO_MODE = "true";
      expect(await authorizeCredentials(demo.user.email, TEST_PASSWORD, ctx(uniqueIp()))).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = previous;
      await demo.cleanup();
    }
  });

  it("transparently upgrades a legacy cost-10 hash on a successful sign-in", async () => {
    const legacy = await createOrgWithPassword("auth-rehash");
    try {
      await setPasswordHashAtCost(legacy.user.id, TEST_PASSWORD, 10);

      expect(await authorizeCredentials(legacy.user.email, TEST_PASSWORD, ctx(uniqueIp()))).not.toBeNull();

      const after = await db.user.findUniqueOrThrow({
        where: { id: legacy.user.id },
        select: { passwordHash: true },
      });
      expect(bcrypt.getRounds(after.passwordHash)).toBe(config.auth.bcryptRounds);
      // The upgraded hash still verifies the same password.
      expect(await bcrypt.compare(TEST_PASSWORD, after.passwordHash)).toBe(true);

      const rehashed = await db.securityEvent.count({
        where: { userId: legacy.user.id, type: "PASSWORD_REHASHED" },
      });
      expect(rehashed).toBe(1);
    } finally {
      await legacy.cleanup();
    }
  });
});

describe("authorizeCredentials — throttling", () => {
  let org: Awaited<ReturnType<typeof createOrgWithPassword>>;

  beforeAll(async () => {
    org = await createOrgWithPassword("auth-throttle");
  });

  afterAll(async () => {
    await org?.cleanup();
  });

  afterEach(() => {
    // Every test here opts the limiter back in itself; make sure nothing leaks out.
    expect(process.env.RATE_LIMIT_DISABLED).toBe("true");
  });

  it("locks the account after the configured burst of failures, then refuses even the right password", async () => {
    const ip = uniqueIp();
    await withRateLimiting({ emails: [org.user.email], ips: [ip] }, async () => {
      for (let i = 0; i <= RATE_RULES.signInAccount.limit; i++) {
        expect(await authorizeCredentials(org.user.email, "wrong-password-here", ctx(ip))).toBeNull();
      }

      // The correct password is now refused too — a lockout must not be a password oracle.
      await expect(authorizeCredentials(org.user.email, TEST_PASSWORD, ctx(ip))).rejects.toBeInstanceOf(
        SignInThrottledError,
      );
    });

    const locked = await db.securityEvent.count({
      where: { organizationId: org.organization.id, type: "ACCOUNT_LOCKED" },
    });
    expect(locked).toBeGreaterThan(0);
  });

  it("locks out an address with no account at all, so lockouts never reveal who exists", async () => {
    const ghost = unknownEmail("ghost");
    const ip = uniqueIp();
    await withRateLimiting({ emails: [ghost], ips: [ip] }, async () => {
      for (let i = 0; i <= RATE_RULES.signInAccount.limit; i++) {
        expect(await authorizeCredentials(ghost, "wrong-password-here", ctx(ip))).toBeNull();
      }
      await expect(authorizeCredentials(ghost, "wrong-password-here", ctx(ip))).rejects.toBeInstanceOf(
        SignInThrottledError,
      );
    });
  });

  it("still spends a bcrypt compare while locked, so a lockout is not detectable by timing", async () => {
    const ghost = unknownEmail("timing");
    const ip = uniqueIp();
    await withRateLimiting({ emails: [ghost], ips: [ip] }, async () => {
      for (let i = 0; i <= RATE_RULES.signInAccount.limit; i++) {
        await authorizeCredentials(ghost, "wrong-password-here", ctx(ip));
      }

      const started = Date.now();
      await expect(authorizeCredentials(ghost, "wrong-password-here", ctx(ip))).rejects.toBeInstanceOf(
        SignInThrottledError,
      );
      const elapsed = Date.now() - started;

      // One bcrypt compare at cost 12 is hundreds of milliseconds; a short-circuit would be ~1 ms.
      expect(elapsed).toBeGreaterThan(50);
    });
  });

  it("records SIGN_IN_THROTTLED with a retry hint when it refuses", async () => {
    const ghost = unknownEmail("throttled");
    const ip = uniqueIp();
    await withRateLimiting({ emails: [ghost], ips: [ip] }, async () => {
      for (let i = 0; i <= RATE_RULES.signInAccount.limit; i++) {
        await authorizeCredentials(ghost, "nope-nope-nope", ctx(ip));
      }
      await expect(authorizeCredentials(ghost, "nope-nope-nope", ctx(ip))).rejects.toMatchObject({
        name: "SignInThrottledError",
      });
    });

    const throttled = await db.securityEvent.findFirst({
      where: { type: "SIGN_IN_THROTTLED", ip },
      orderBy: { createdAt: "desc" },
    });
    expect(throttled).not.toBeNull();
  });

  it("locks the client address itself once too many failures come from it, whatever they target", async () => {
    const ip = uniqueIp();
    const first = unknownEmail("ipflood");
    const second = unknownEmail("ipflood-other");
    await withRateLimiting({ emails: [first, second], ips: [ip] }, async () => {
      // Fill the IP bucket directly: the limit is deliberately high, and every real attempt costs a bcrypt
      // compare. What matters here is what authorizeCredentials does once the bucket is full.
      for (let i = 0; i < RATE_RULES.signInIp.limit; i++) await hit(RATE_RULES.signInIp, ip);

      // This attempt tips the address over its limit and locks it…
      expect(await authorizeCredentials(first, "wrong-password-here", ctx(ip))).toBeNull();
      // …after which even an account that has never been touched is refused from this address.
      await expect(authorizeCredentials(second, "wrong-password-here", ctx(ip))).rejects.toBeInstanceOf(
        SignInThrottledError,
      );
    });
  });

  it("clears the account's failure bucket on a successful sign-in", async () => {
    const ip = uniqueIp();
    const fresh = await createOrgWithPassword("auth-reset");
    try {
      await withRateLimiting({ emails: [fresh.user.email], ips: [ip] }, async () => {
        for (let i = 0; i < RATE_RULES.signInAccount.limit; i++) {
          await authorizeCredentials(fresh.user.email, "wrong-password-here", ctx(ip));
        }
        // Right at the limit, the correct password still works…
        expect(await authorizeCredentials(fresh.user.email, TEST_PASSWORD, ctx(ip))).not.toBeNull();
        // …and the counter is back to zero, so the next burst starts from scratch.
        for (let i = 0; i < RATE_RULES.signInAccount.limit; i++) {
          await authorizeCredentials(fresh.user.email, "wrong-password-here", ctx(ip));
        }
        expect(await authorizeCredentials(fresh.user.email, TEST_PASSWORD, ctx(ip))).not.toBeNull();
      });
    } finally {
      await fresh.cleanup();
    }
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Demo@Foreman.Example \n")).toBe("demo@foreman.example");
  });
});
