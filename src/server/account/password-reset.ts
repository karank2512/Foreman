import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { normalizeEmail } from "@/server/auth/authorize";
import { hashPassword } from "@/server/auth/password";
import { assertCan } from "@/server/auth/permissions";
import type { SessionContext } from "@/server/auth/types";
import { RATE_RULES, enforce, hashEmail, recordSecurityEvent, requestContext, resetLimit } from "@/server/security";
import { ResetPasswordInputSchema, resetTokenSchema, type ResetPasswordInput } from "./inputs";
import { assertPasswordPolicy } from "./password-policy";

/**
 * Password reset without an email provider. An owner (or, for a locked-out sole owner, whoever runs the
 * server: `npm run user:reset-link`) makes a one-time link and passes it on by hand, exactly like an invite.
 *
 * The link is stateless — `<userId>.<expiresAt>.<hmac>` — so no schema change and no token table. The HMAC is
 * keyed from AUTH_SECRET and covers the user's current `sessionVersion`, which makes it:
 *  - single-use: setting the password bumps `sessionVersion`, so the same link no longer verifies;
 *  - superseded: issuing a link also bumps it (signing the person out), so only the newest link works;
 *  - revocable: "Sign out everywhere", a role change or removal all bump it too.
 * Rotating AUTH_SECRET invalidates every outstanding link, the same way it ends every session.
 */

export const PASSWORD_RESET_TTL_HOURS = 24;

const RESET_PATH = "/reset-password";
const TOKEN_CONTEXT = "foreman:password-reset:v1";
const INVALID_LINK = "That reset link is not valid or has expired.";

const baseUrl = () => config.publicUrl ?? "http://localhost:3000";

export function passwordResetUrlFor(token: string): string {
  return new URL(`${RESET_PATH}/${token}`, baseUrl()).toString();
}

function signingKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new AppError("INTERNAL", "AUTH_SECRET is not set, so reset links cannot be signed.");
  // Derived rather than used directly, so a reset signature can never be confused with an Auth.js cookie.
  return createHmac("sha256", secret).update(TOKEN_CONTEXT).digest();
}

function signature(userId: string, expiresAtSec: number, sessionVersion: number): Buffer {
  return createHmac("sha256", signingKey()).update(`${userId}:${expiresAtSec}:${sessionVersion}`).digest();
}

function mint(userId: string, sessionVersion: number, now: Date): { token: string; expiresAt: Date } {
  const expiresAtSec = Math.floor(now.getTime() / 1000) + PASSWORD_RESET_TTL_HOURS * 60 * 60;
  const sig = signature(userId, expiresAtSec, sessionVersion).toString("base64url");
  return { token: `${userId}.${expiresAtSec}.${sig}`, expiresAt: new Date(expiresAtSec * 1000) };
}

/** Parses and checks a token against the account as it is right now. Every failure looks the same: null. */
async function verify(token: string, now: Date) {
  const parsed = resetTokenSchema.safeParse(token);
  if (!parsed.success) return null;
  const [userId, expiresRaw, sigRaw] = parsed.data.split(".") as [string, string, string];
  const expiresAtSec = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAtSec) || expiresAtSec * 1000 <= now.getTime()) return null;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      sessionVersion: true,
      disabledAt: true,
      organizationId: true,
      organization: { select: { name: true, suspendedAt: true, isDemo: true } },
    },
  });
  if (!user || user.disabledAt || user.organization.suspendedAt) return null;
  // The demo workspace refuses sign-in unless DEMO_MODE is on, so a reset there would set a password nobody can use.
  if (user.organization.isDemo && !config.auth.demoMode) return null;

  const expected = signature(user.id, expiresAtSec, user.sessionVersion);
  const given = Buffer.from(sigRaw, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return user;
}

/**
 * Makes the link and signs the person out everywhere (which is also what retires any earlier link).
 * Shared by the settings action and the operator command; callers decide who may ask.
 */
async function issue(
  target: { id: string; organizationId: string; email: string },
  audit: { actorUserId?: string; via: "settings" | "operator" },
): Promise<{ resetUrl: string; expiresAt: string }> {
  const now = new Date();
  const updated = await db.user.update({
    where: { id: target.id },
    data: { sessionVersion: { increment: 1 } },
    select: { sessionVersion: true },
  });
  const { token, expiresAt } = mint(target.id, updated.sessionVersion, now);

  const ctx = audit.via === "settings" ? await requestContext() : { ip: undefined, userAgent: null };
  // Recorded against the person whose sessions ended, so it shows in their own trail too; who asked is metadata.
  await recordSecurityEvent({
    type: "SESSIONS_REVOKED",
    organizationId: target.organizationId,
    userId: target.id,
    email: target.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: {
      reason: "password_reset_link_issued",
      via: audit.via,
      ...(audit.actorUserId ? { issuedByUserId: audit.actorUserId } : {}),
    },
  });

  return { resetUrl: passwordResetUrlFor(token), expiresAt: expiresAt.toISOString() };
}

/**
 * An owner makes a reset link for an admin or member of their workspace. Your own password is changed from
 * Settings → Security, which asks for the current one; another owner's needs the server operator.
 */
export async function createPasswordResetLink(
  s: SessionContext,
  userId: string,
): Promise<{ resetUrl: string; expiresAt: string }> {
  assertCan(s, "members.manage");
  if (userId === s.userId) {
    throw new AppError("CONFLICT", "To change your own password, use Settings → Security.");
  }
  const target = await db.user.findFirst({
    where: { id: userId, organizationId: s.organizationId },
    select: { id: true, organizationId: true, email: true, role: true, disabledAt: true },
  });
  if (!target) throw new AppError("NOT_FOUND", "That member is not part of this workspace.");
  if (target.disabledAt) throw new AppError("CONFLICT", "That member has been removed from the workspace.");
  // A link lets whoever holds it act as that person. Owners may demote or remove each other, which is visible;
  // quietly becoming another owner is not something one owner should be able to do alone.
  if (target.role === "OWNER") {
    throw new AppError(
      "CONFLICT",
      "Owners can't make reset links for other owners. Whoever runs the server can, with npm run user:reset-link.",
    );
  }

  return issue(target, { actorUserId: s.userId, via: "settings" });
}

/**
 * For whoever runs the server, when nobody who can sign in is able to help (typically a sole owner who
 * forgot their password). Only reachable from the command line, never from a request.
 */
export async function createPasswordResetLinkForOperator(
  email: string,
): Promise<{ resetUrl: string; expiresAt: string; organizationName: string }> {
  const user = await db.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: { id: true, organizationId: true, email: true, disabledAt: true, organization: { select: { name: true } } },
  });
  if (!user) throw new AppError("NOT_FOUND", "No account uses that email address.");
  if (user.disabledAt) throw new AppError("CONFLICT", "That account was removed from its workspace.");

  const link = await issue(user, { via: "operator" });
  return { ...link, organizationName: user.organization.name };
}

/** What the reset page shows before anyone types. Unknown, expired, used and superseded links all give null. */
export async function getPasswordResetByToken(
  token: string,
): Promise<{ email: string; name: string; organizationName: string; expiresAt: string } | null> {
  const now = new Date();
  const user = await verify(token, now);
  if (!user) return null;
  const expiresAtSec = Number(token.trim().split(".")[1]);
  return {
    email: user.email,
    name: user.name,
    organizationName: user.organization.name,
    expiresAt: new Date(expiresAtSec * 1000).toISOString(),
  };
}

export interface ResetPasswordContext {
  ip: string;
  userAgent: string | null;
}

/** Sets the new password, spends the link, signs every old session out and clears any sign-in lockout. */
export async function resetPasswordWithToken(
  token: string,
  input: ResetPasswordInput,
  ctx: ResetPasswordContext,
): Promise<{ email: string }> {
  await enforce(RATE_RULES.passwordResetIp, ctx.ip);
  const parsed = ResetPasswordInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Choose a new password.");
  }
  const { password } = parsed.data;

  const user = await verify(token, new Date());
  if (!user) throw new AppError("NOT_FOUND", INVALID_LINK);

  assertPasswordPolicy(password, { email: user.email, name: user.name, organizationName: user.organization.name });
  const passwordHash = await hashPassword(password);

  // Compare-and-set on the version the link was checked against: of two concurrent submissions, one wins.
  const claimed = await db.user.updateMany({
    where: { id: user.id, sessionVersion: user.sessionVersion, disabledAt: null },
    data: { passwordHash, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
  });
  if (claimed.count === 0) throw new AppError("NOT_FOUND", INVALID_LINK);

  // Someone who was locked out by failed guesses should be able to sign in with the new password straight away.
  await resetLimit(RATE_RULES.signInAccount, hashEmail(user.email));

  await recordSecurityEvent({
    type: "PASSWORD_CHANGED",
    organizationId: user.organizationId,
    userId: user.id,
    email: user.email,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { method: "reset_link" },
  });

  return { email: user.email };
}
