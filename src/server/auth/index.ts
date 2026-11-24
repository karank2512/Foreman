import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { redirect } from "next/navigation";
import { cache } from "react";
import { config } from "@/server/config";
import { clientIpFromHeaders, requestContext } from "@/server/security";
import { SESSION_EXPIRED_SIGN_IN_PATH, SIGN_IN_PATH } from "./access";
import { authConfig } from "./auth.config";
import { SignInThrottledError, authorizeCredentials, type SignInContext } from "./authorize";
import { loadSessionContext } from "./session-context";
import type { SessionContext } from "./types";

/**
 * Auth.js v5 entry point — APP CODE ONLY (pages, layouts, server actions, route handlers).
 * Server modules take a `SessionContext` argument instead; tests and the seed import `./password`
 * and `./authorize` directly so they never load next-auth.
 */

/** Lockout answer. `signInAction` maps `code === "rate_limited"` to a "try again later" message. */
export class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

const USER_AGENT_MAX = 256;

/**
 * Where the attempt came from, taken from the REAL request headers. Auth.js runs `authorize` for both the
 * server action and a direct POST to /api/auth/callback/credentials, and builds `request` from the incoming
 * headers in both cases — so nothing the submitted form claims about its own IP is ever trusted.
 */
async function signInContext(request: Request | undefined): Promise<SignInContext> {
  const headers = request?.headers;
  if (headers) {
    const ip = clientIpFromHeaders(headers, config.auth.trustedProxyHops);
    if (ip !== "unknown") return { ip, userAgent: headers.get("user-agent")?.slice(0, USER_AGENT_MAX) ?? null };
  }
  return requestContext();
}

/**
 * The first entry signs new cookies; every entry is tried when decoding, which gives AUTH_SECRET rotation an
 * overlap window instead of logging everyone out. Left unset when neither variable is present so Auth.js
 * raises its own "missing secret" error rather than a confusing empty-array one.
 */
const authSecrets = [process.env.AUTH_SECRET, process.env.AUTH_SECRET_PREVIOUS].filter(
  (s): s is string => Boolean(s),
);

/**
 * Auth.js otherwise infers the `__Secure-` cookie prefix from the forwarded protocol, which is
 * attacker-controlled on a request that reaches the app without passing through the proxy. In production we
 * state it outright, from the configured public origin (F-016).
 */
const useSecureCookies = config.isProduction ? (config.publicUrl?.startsWith("https://") ?? true) : undefined;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  ...(authSecrets.length > 0 ? { secret: authSecrets } : {}),
  ...(useSecureCookies === undefined ? {} : { useSecureCookies }),
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      // Returning null makes Auth.js throw CredentialsSignin, which signInAction maps to a friendly message.
      async authorize(credentials, request) {
        const { email, password } = credentials ?? {};
        if (typeof email !== "string" || typeof password !== "string") return null;
        try {
          return await authorizeCredentials(email, password, await signInContext(request));
        } catch (e) {
          if (e instanceof SignInThrottledError) throw new RateLimitedSignin();
          throw e;
        }
      },
    }),
  ],
});

type SessionLookup =
  | { status: "ok"; session: SessionContext }
  | { status: "anonymous" }
  /** Valid cookie, but revoked, disabled, or its user is gone (e.g. the database was re-seeded). */
  | { status: "stale" };

/** Deduplicated per render pass: the layout and the page both call requireSession(). */
const lookupSession = cache(async (): Promise<SessionLookup> => {
  const session = await auth();
  const userId = session?.user?.id;
  const organizationId = session?.user?.organizationId;
  if (!userId || !organizationId) return { status: "anonymous" };

  const context = await loadSessionContext({
    userId,
    organizationId,
    sessionVersion: session?.user?.sessionVersion,
  });
  return context ? { status: "ok", session: context } : { status: "stale" };
});

/** The caller's org-scoped identity, re-verified against the database; `null` when signed out or stale. */
export async function getSession(): Promise<SessionContext | null> {
  const lookup = await lookupSession();
  return lookup.status === "ok" ? lookup.session : null;
}

/**
 * For pages, layouts and server actions. Route handlers under /api use getSession() and answer 401 instead.
 * A stale cookie is sent to the sign-in page with a flag so the middleware (which can only see the cookie)
 * does not bounce the visitor straight back into the app.
 */
export async function requireSession(): Promise<SessionContext> {
  const lookup = await lookupSession();
  if (lookup.status === "ok") return lookup.session;
  redirect(lookup.status === "stale" ? SESSION_EXPIRED_SIGN_IN_PATH : SIGN_IN_PATH);
}

export { hashPassword, verifyPassword } from "./password";
export {
  DEFAULT_SIGNED_IN_PATH,
  INVITE_PATH,
  RESET_PASSWORD_PATH,
  SESSION_EXPIRED_PARAM,
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  safeCallbackUrl,
} from "./access";
export type { SessionContext } from "./types";
