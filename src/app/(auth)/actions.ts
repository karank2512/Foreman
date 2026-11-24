"use server";

import { unstable_rethrow } from "next/navigation";
import { acceptInvitation, resetPasswordWithToken, signUp } from "@/server/account";
import { DEFAULT_SIGNED_IN_PATH, SIGN_IN_PATH, getSession, safeCallbackUrl, signIn, signOut } from "@/server/auth";
import { isAppError } from "@/server/errors";
import { recordSecurityEvent, requestContext } from "@/server/security";
import {
  ACCEPT_INVITE_MESSAGES,
  RESET_PASSWORD_MESSAGES,
  SIGN_IN_MESSAGES,
  SIGN_UP_MESSAGES,
  signInErrorMessage,
  type AcceptInviteState,
  type ResetPasswordState,
  type SignInState,
  type SignUpState,
} from "./schema";

function signInFailureMessage(e: unknown): string {
  const message = signInErrorMessage(e);
  if (message) return message;
  // Anything else (database down, misconfigured AUTH_SECRET …) is ours to debug, not the visitor's.
  console.error("[auth] sign-in failed", e);
  return SIGN_IN_MESSAGES.unexpected;
}

const field = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/** `useActionState` action for the sign-in form. On success `signIn` redirects (throws) — it never returns. */
export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = field(formData, "email");
  const password = field(formData, "password");
  if (!email.trim() || !password) return { error: SIGN_IN_MESSAGES.missingFields };

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: safeCallbackUrl(formData.get("callbackUrl")),
    });
  } catch (e) {
    // The success path is a thrown NEXT_REDIRECT: let Next.js control-flow errors through untouched.
    unstable_rethrow(e);
    return { error: signInFailureMessage(e) };
  }

  return { error: null };
}

/**
 * Create a workspace and its first owner, then sign them straight in. Throttling, the SIGNUP_MODE gate and
 * the password policy all live in `@/server/account`, so a direct POST cannot skip them.
 */
export async function signUpAction(_prev: SignUpState, formData: FormData): Promise<SignUpState> {
  const name = field(formData, "name");
  const email = field(formData, "email");
  const password = field(formData, "password");
  const organizationName = field(formData, "organizationName");
  const inviteCode = field(formData, "inviteCode").trim();

  if (!name.trim() || !email.trim() || !password || !organizationName.trim()) {
    return { error: SIGN_UP_MESSAGES.missingFields };
  }

  try {
    const ctx = await requestContext();
    await signUp(
      { name, email, password, organizationName, inviteCode: inviteCode || undefined },
      { ip: ctx.ip, userAgent: ctx.userAgent },
    );
  } catch (e) {
    unstable_rethrow(e);
    if (isAppError(e)) return { error: e.message };
    console.error("[auth] sign-up failed", e);
    return { error: SIGN_UP_MESSAGES.unexpected };
  }

  // Outside the catch above: signIn's success path is a thrown redirect, not a return value.
  try {
    await signIn("credentials", { email, password, redirectTo: DEFAULT_SIGNED_IN_PATH });
  } catch (e) {
    unstable_rethrow(e);
    console.error("[auth] sign-in after sign-up failed", e);
    return { error: SIGN_IN_MESSAGES.unexpected };
  }

  return { error: null };
}

/** Join an existing workspace from an invite link, then sign in. The token comes from the page's form. */
export async function acceptInviteAction(_prev: AcceptInviteState, formData: FormData): Promise<AcceptInviteState> {
  const token = field(formData, "token");
  const name = field(formData, "name");
  const password = field(formData, "password");
  if (!token) return { error: ACCEPT_INVITE_MESSAGES.invalidLink };
  if (!name.trim() || !password) return { error: ACCEPT_INVITE_MESSAGES.missingFields };

  let email: string;
  try {
    const ctx = await requestContext();
    ({ email } = await acceptInvitation(token, { name, password }, { ip: ctx.ip, userAgent: ctx.userAgent }));
  } catch (e) {
    unstable_rethrow(e);
    if (isAppError(e)) return { error: e.message };
    console.error("[auth] invite acceptance failed", e);
    return { error: ACCEPT_INVITE_MESSAGES.unexpected };
  }

  try {
    await signIn("credentials", { email, password, redirectTo: DEFAULT_SIGNED_IN_PATH });
  } catch (e) {
    unstable_rethrow(e);
    console.error("[auth] sign-in after invite acceptance failed", e);
    return { error: SIGN_IN_MESSAGES.unexpected };
  }

  return { error: null };
}

/**
 * Set a new password from a one-time reset link, then sign in with it. The link names the account, so the
 * form only carries the token and the new password.
 */
export async function resetPasswordAction(_prev: ResetPasswordState, formData: FormData): Promise<ResetPasswordState> {
  const token = field(formData, "token");
  const password = field(formData, "password");
  if (!token) return { error: RESET_PASSWORD_MESSAGES.invalidLink };
  if (!password) return { error: RESET_PASSWORD_MESSAGES.missingFields };

  let email: string;
  try {
    const ctx = await requestContext();
    ({ email } = await resetPasswordWithToken(token, { password }, { ip: ctx.ip, userAgent: ctx.userAgent }));
  } catch (e) {
    unstable_rethrow(e);
    if (isAppError(e)) return { error: e.message };
    console.error("[auth] password reset failed", e);
    return { error: RESET_PASSWORD_MESSAGES.unexpected };
  }

  try {
    await signIn("credentials", { email, password, redirectTo: DEFAULT_SIGNED_IN_PATH });
  } catch (e) {
    unstable_rethrow(e);
    console.error("[auth] sign-in after password reset failed", e);
    return { error: SIGN_IN_MESSAGES.unexpected };
  }

  return { error: null };
}

/** Used by the AppShell user menu. Clears the session cookie, then redirects (throws) to the sign-in page. */
export async function signOutAction(): Promise<void> {
  // Read the session before the cookie is cleared, so the audit row is attributable.
  const session = await getSession();
  if (session) {
    const ctx = await requestContext();
    await recordSecurityEvent({
      type: "SIGN_OUT",
      organizationId: session.organizationId,
      userId: session.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
  await signOut({ redirectTo: SIGN_IN_PATH });
}
