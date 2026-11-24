/**
 * Shared, framework-free pieces of the signed-out pages: the copy their actions return and the live
 * password checklist the forms render while someone types.
 *
 * Pure by design — client components may import it. The authoritative password rules live in
 * `@/server/account` (server-only, and the only thing that can consult the breached-password list); the
 * checklist here is a hint, never a gate.
 */

export interface SignInState {
  error: string | null;
}

export const SIGN_IN_MESSAGES = {
  missingFields: "Enter your email and password.",
  invalidCredentials: "Invalid email or password",
  rateLimited: "Too many sign-in attempts. Try again in a few minutes.",
  unexpected: "We couldn't sign you in right now. Please try again.",
} as const;

/**
 * Which sentence a failed `signIn()` deserves. Auth.js error classes get duplicated across bundles, so
 * `instanceof` is unreliable — every AuthError carries a string `type`, and our lockout adds a `code`.
 * Duck-typed on purpose: this module is imported by client components and must not pull in next-auth.
 *
 * Returns null for anything that is not a credentials failure: that is a bug on our side, and the caller
 * logs it and shows `SIGN_IN_MESSAGES.unexpected`.
 */
export function signInErrorMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { type, code } = error as { type?: unknown; code?: unknown };
  if (type !== "CredentialsSignin") return null;
  return code === "rate_limited" ? SIGN_IN_MESSAGES.rateLimited : SIGN_IN_MESSAGES.invalidCredentials;
}

export interface SignUpState {
  error: string | null;
}

export const SIGN_UP_MESSAGES = {
  missingFields: "Fill in every field to create your workspace.",
  closed: "Sign-up is closed; ask your workspace admin for an invite",
  unexpected: "We couldn't create your workspace right now. Please try again.",
} as const;

export interface AcceptInviteState {
  error: string | null;
}

export const ACCEPT_INVITE_MESSAGES = {
  missingFields: "Enter your name and choose a password.",
  invalidLink: "That invite link is not valid or has expired.",
  unexpected: "We couldn't set up your account right now. Please try again.",
} as const;

export interface ResetPasswordState {
  error: string | null;
}

export const RESET_PASSWORD_MESSAGES = {
  missingFields: "Choose a new password.",
  invalidLink: "That reset link is not valid or has expired.",
  unexpected: "We couldn't reset your password right now. Please try again.",
} as const;

/** Presentation-only input bounds; the server re-validates everything (see `@/server/account/inputs.ts`). */
export const FIELD_LIMITS = {
  name: 80,
  email: 254,
  organizationName: 80,
  inviteCode: 200,
  password: 256,
} as const;

/** bcrypt only mixes the first 72 bytes of a password, so the policy refuses anything longer. */
export const PASSWORD_MAX_BYTES = 72;

export interface PasswordCheck {
  id: string;
  label: string;
  ok: boolean;
}

export interface PasswordCheckContext {
  email?: string;
  name?: string;
  organizationName?: string;
}

const MIN_ECHO_LENGTH = 4;

function echoes(password: string, ctx: PasswordCheckContext): boolean {
  const haystack = password.toLowerCase();
  if (haystack === "") return false;
  const fragments = [
    ctx.email?.split("@")[0],
    ctx.email,
    ctx.name,
    ...(ctx.name?.split(/\s+/) ?? []),
    ctx.organizationName,
    ...(ctx.organizationName?.split(/\s+/) ?? []),
  ];
  return fragments.some((fragment) => {
    const value = fragment?.trim().toLowerCase() ?? "";
    return value.length >= MIN_ECHO_LENGTH && haystack.includes(value);
  });
}

/** UTF-8 byte length, the same measure bcrypt applies (an emoji costs four). */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The live checklist under the password field. It mirrors the rules a person can see for themselves;
 * the server additionally rejects breached passwords, keyboard runs and counting sequences.
 */
export function passwordChecklist(password: string, minLength: number, ctx: PasswordCheckContext = {}): PasswordCheck[] {
  return [
    {
      id: "length",
      label: `At least ${minLength} characters`,
      ok: [...password].length >= minLength,
    },
    {
      id: "bytes",
      label: `At most ${PASSWORD_MAX_BYTES} bytes (shorter if you use emoji or accents)`,
      ok: password.length > 0 && byteLength(password) <= PASSWORD_MAX_BYTES,
    },
    {
      id: "variety",
      label: "A mix of at least five different characters",
      ok: new Set(password).size >= 5,
    },
    {
      id: "echo",
      label: "Not built from your name, email or workspace name",
      ok: password.length > 0 && !echoes(password, ctx),
    },
  ];
}
