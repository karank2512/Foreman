import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPasswordResetLink,
  createPasswordResetLinkForOperator,
  getPasswordResetByToken,
  resetPasswordWithToken,
} from "@/server/account";
import { verifyPassword } from "@/server/auth/password";
import type { SessionContext } from "@/server/auth/types";
import { db } from "@/server/db";
import { createTestOrg } from "../helpers/factory";
import { strongPassword, uniqueEmail, uniqueIp } from "./helpers";

/**
 * Owner-issued and operator-issued password reset links (no email provider). The links are stateless HMACs
 * over the user's sessionVersion, so these tests are mostly about what retires a link.
 */

const ctx = () => ({ ip: uniqueIp(), userAgent: "vitest" });
const tokenOf = (resetUrl: string) => new URL(resetUrl).pathname.split("/").pop() ?? "";

let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET ??= "test-only-auth-secret-0123456789abcdef";
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousSecret;
});

async function addUser(organizationId: string, role: "OWNER" | "ADMIN" | "MEMBER", name = "Ada Teammate") {
  return db.user.create({
    data: { organizationId, email: uniqueEmail(role.toLowerCase()), name, passwordHash: "x", role },
  });
}

const sessionAs = (
  org: { id: string; name: string },
  user: { id: string; email: string; name: string },
  role: SessionContext["role"],
): SessionContext => ({
  userId: user.id,
  organizationId: org.id,
  organizationName: org.name,
  role,
  name: user.name,
  email: user.email,
});

describe("password reset links", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await cleanup?.();
    cleanup = undefined;
  });

  it("lets an owner make a one-time link that sets a new password and signs the member in fresh", async () => {
    const org = await createTestOrg("reset");
    cleanup = org.cleanup;
    const member = await addUser(org.organization.id, "MEMBER");

    const link = await createPasswordResetLink(org.session, member.id);
    expect(link.resetUrl).toMatch(/\/reset-password\/[a-z0-9]+\.\d+\.[A-Za-z0-9_-]{43}$/);
    const hoursValid = (new Date(link.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hoursValid).toBeGreaterThan(23.9);
    expect(hoursValid).toBeLessThanOrEqual(24);

    // Making the link signs the member out everywhere.
    const issued = await db.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(issued.sessionVersion).toBe(member.sessionVersion + 1);

    const token = tokenOf(link.resetUrl);
    expect(await getPasswordResetByToken(token)).toMatchObject({
      email: member.email,
      name: member.name,
      organizationName: org.organization.name,
    });

    const password = strongPassword("reset");
    expect(await resetPasswordWithToken(token, { password }, ctx())).toEqual({ email: member.email });

    const after = await db.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(await verifyPassword(password, after.passwordHash)).toBe(true);
    expect(after.sessionVersion).toBe(issued.sessionVersion + 1);
    expect(after.passwordChangedAt).not.toBeNull();

    // Spent: the same link no longer opens or works.
    expect(await getPasswordResetByToken(token)).toBeNull();
    await expect(resetPasswordWithToken(token, { password: strongPassword("again") }, ctx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const events = await db.securityEvent.findMany({
      where: { organizationId: org.organization.id },
      orderBy: { createdAt: "asc" },
      select: { type: true, userId: true, metadata: true },
    });
    expect(events).toEqual([
      {
        type: "SESSIONS_REVOKED",
        userId: org.user.id,
        metadata: { reason: "password_reset_link_issued", via: "settings", targetUserId: member.id },
      },
      { type: "PASSWORD_CHANGED", userId: member.id, metadata: { method: "reset_link" } },
    ]);
  });

  it("retires the older link when a newer one is made, and when the member is signed out or removed", async () => {
    const org = await createTestOrg("reset-retire");
    cleanup = org.cleanup;
    const member = await addUser(org.organization.id, "MEMBER");

    const first = tokenOf((await createPasswordResetLink(org.session, member.id)).resetUrl);
    const second = tokenOf((await createPasswordResetLink(org.session, member.id)).resetUrl);
    expect(await getPasswordResetByToken(first)).toBeNull();
    expect(await getPasswordResetByToken(second)).not.toBeNull();

    // Any sessionVersion bump (sign out everywhere, a role change) retires it too.
    await db.user.update({ where: { id: member.id }, data: { sessionVersion: { increment: 1 } } });
    expect(await getPasswordResetByToken(second)).toBeNull();

    const third = tokenOf((await createPasswordResetLink(org.session, member.id)).resetUrl);
    await db.user.update({ where: { id: member.id }, data: { disabledAt: new Date() } });
    expect(await getPasswordResetByToken(third)).toBeNull();
    await expect(resetPasswordWithToken(third, { password: strongPassword() }, ctx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("stops working after 24 hours, in a suspended workspace, or once AUTH_SECRET is rotated", async () => {
    const org = await createTestOrg("reset-expiry");
    cleanup = org.cleanup;
    const member = await addUser(org.organization.id, "MEMBER");
    const token = tokenOf((await createPasswordResetLink(org.session, member.id)).resetUrl);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 3_600_000 + 1_000);
    expect(await getPasswordResetByToken(token)).toBeNull();
    vi.useRealTimers();
    expect(await getPasswordResetByToken(token)).not.toBeNull();

    const secret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "a-different-secret-after-rotation-0123456789";
    try {
      expect(await getPasswordResetByToken(token)).toBeNull();
    } finally {
      process.env.AUTH_SECRET = secret;
    }

    await db.organization.update({ where: { id: org.organization.id }, data: { suspendedAt: new Date() } });
    expect(await getPasswordResetByToken(token)).toBeNull();
  });

  it("treats tampered, foreign and malformed links all the same: not valid", async () => {
    const org = await createTestOrg("reset-tamper");
    cleanup = org.cleanup;
    const member = await addUser(org.organization.id, "MEMBER");
    const other = await addUser(org.organization.id, "MEMBER", "Bo Other");
    const token = tokenOf((await createPasswordResetLink(org.session, member.id)).resetUrl);
    const [userId, expires, sig] = token.split(".");

    const forged = [
      `${other.id}.${expires}.${sig}`, // someone else's account, same signature
      `${userId}.${Number(expires) + 3600}.${sig}`, // a longer life
      `${userId}.${expires}.${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`, // a different signature
      `${userId}.${expires}`,
      "not-a-token",
      "",
      `${token}.extra`,
    ];
    for (const bad of forged) {
      expect(await getPasswordResetByToken(bad), bad).toBeNull();
      await expect(resetPasswordWithToken(bad, { password: strongPassword() }, ctx())).rejects.toMatchObject({
        code: expect.stringMatching(/NOT_FOUND|VALIDATION/),
      });
    }
    // None of that spent the real link.
    expect(await getPasswordResetByToken(token)).not.toBeNull();
  });

  it("applies the password policy and keeps the link usable after a refusal", async () => {
    const org = await createTestOrg("reset-policy");
    cleanup = org.cleanup;
    const member = await addUser(org.organization.id, "MEMBER");
    const token = tokenOf((await createPasswordResetLink(org.session, member.id)).resetUrl);

    await expect(resetPasswordWithToken(token, { password: "password123" }, ctx())).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(resetPasswordWithToken(token, { password: strongPassword() }, ctx())).resolves.toEqual({
      email: member.email,
    });
  });

  it("lets exactly one of two simultaneous submissions win", async () => {
    const org = await createTestOrg("reset-race");
    cleanup = org.cleanup;
    const member = await addUser(org.organization.id, "MEMBER");
    const token = tokenOf((await createPasswordResetLink(org.session, member.id)).resetUrl);

    const results = await Promise.allSettled([
      resetPasswordWithToken(token, { password: strongPassword("one") }, ctx()),
      resetPasswordWithToken(token, { password: strongPassword("two") }, ctx()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("is owner-only, scoped to the workspace, and not for your own account", async () => {
    const org = await createTestOrg("reset-perm");
    const elsewhere = await createTestOrg("reset-perm-other");
    cleanup = async () => {
      await org.cleanup();
      await elsewhere.cleanup();
    };
    const admin = await addUser(org.organization.id, "ADMIN");
    const member = await addUser(org.organization.id, "MEMBER");
    const removed = await addUser(org.organization.id, "MEMBER");
    await db.user.update({ where: { id: removed.id }, data: { disabledAt: new Date() } });

    await expect(createPasswordResetLink(sessionAs(org.organization, admin, "ADMIN"), member.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(createPasswordResetLink(sessionAs(org.organization, member, "MEMBER"), admin.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(createPasswordResetLink(org.session, org.user.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createPasswordResetLink(org.session, elsewhere.user.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createPasswordResetLink(org.session, removed.id)).rejects.toMatchObject({ code: "CONFLICT" });

    // Refusals change nothing.
    const untouched = await db.user.findUniqueOrThrow({ where: { id: elsewhere.user.id } });
    expect(untouched.sessionVersion).toBe(elsewhere.user.sessionVersion);
  });

  it("lets the server operator make a link by email for a locked-out sole owner", async () => {
    const org = await createTestOrg("reset-operator");
    cleanup = org.cleanup;

    const link = await createPasswordResetLinkForOperator(`  ${org.user.email.toUpperCase()} `);
    expect(link.organizationName).toBe(org.organization.name);

    const password = strongPassword("owner");
    await resetPasswordWithToken(tokenOf(link.resetUrl), { password }, ctx());
    const owner = await db.user.findUniqueOrThrow({ where: { id: org.user.id } });
    expect(await verifyPassword(password, owner.passwordHash)).toBe(true);

    const issued = await db.securityEvent.findFirstOrThrow({
      where: { organizationId: org.organization.id, type: "SESSIONS_REVOKED" },
      select: { userId: true, metadata: true },
    });
    expect(issued).toEqual({
      userId: org.user.id,
      metadata: { reason: "password_reset_link_issued", via: "operator", targetUserId: org.user.id },
    });

    await expect(createPasswordResetLinkForOperator(uniqueEmail("nobody"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
