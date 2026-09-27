/**
 * Pure routing rules for the auth middleware. Edge-safe (no Prisma, bcrypt, next-auth or Next.js imports)
 * and unit-tested directly; `auth.config.ts` only translates the decision into a Response.
 */

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";
export const INVITE_PATH = "/invite";
export const DEFAULT_SIGNED_IN_PATH = "/workforce";

/**
 * Set by `requireSession()` when the cookie is cryptographically valid but its user no longer exists
 * (e.g. after a re-seed), was disabled, or carries a revoked `sessionVersion`. The middleware can only see
 * the cookie, so without this flag it would bounce the "signed-in" visitor from /sign-in back into the app
 * forever.
 */
export const SESSION_EXPIRED_PARAM = "expired";
export const SESSION_EXPIRED_SIGN_IN_PATH = `${SIGN_IN_PATH}?${SESSION_EXPIRED_PARAM}=1`;

/**
 * The share image and icons Next.js generates from the files beside `src/app/layout.tsx` (`opengraph-image`,
 * and `twitter-image` / `icon` / `apple-icon` should they be added). Link-preview crawlers (Slack, X,
 * LinkedIn, iMessage) never carry a cookie, so a gated share image is one nobody ever sees. Root-level only:
 * a per-route image such as `/workers/[id]/opengraph-image` could carry workspace data and stays gated.
 */
const METADATA_IMAGE_PATHS = ["/opengraph-image", "/twitter-image", "/icon", "/apple-icon"] as const;

/**
 * Reachable without a session. `/` is the landing page, the two account-creation flows have to work for
 * people who have no account yet, the ops probes must answer a load balancer that never carries a cookie,
 * and the metadata images must answer link-preview crawlers.
 *
 * `/api/auth/*` is handled separately below: Auth.js' own endpoints are always allowed, signed in or not.
 */
export const PUBLIC_PATHS = [
  "/",
  SIGN_UP_PATH,
  INVITE_PATH,
  "/api/health",
  "/api/ready",
  ...METADATA_IMAGE_PATHS,
] as const;

/**
 * The application proper: a signed-out visitor is sent to /sign-in and brought back here afterwards. A URL
 * that is neither public nor under one of these has nothing behind it for anyone, so it falls through to
 * the 404 page instead of a sign-in prompt for a page that would 404 anyway.
 *
 * Kept exhaustive by tests/auth/access.test.ts, which reads the route segments under `src/app`. And every
 * (app) page sits behind the layout's `requireSession()` regardless, so an omission here would cost the
 * post-sign-in `callbackUrl`, never the gate.
 */
export const PROTECTED_PATHS = [
  "/workforce",
  "/workers",
  "/hire",
  "/runs",
  "/deliverables",
  "/jobs",
  "/approvals",
  "/activity",
  "/settings",
  "/usage",
  "/styleguide",
] as const;

/** Pages a signed-in visitor has no business seeing — they get sent into the app instead. */
const SIGNED_OUT_ONLY_PATHS = [SIGN_IN_PATH, SIGN_UP_PATH] as const;

export type AccessDecision =
  | { kind: "allow" }
  /** `to` is always a same-origin relative URL. */
  | { kind: "redirect"; to: string }
  | { kind: "unauthorized" };

export interface AccessRequest {
  pathname: string;
  /** Query string including the leading "?" (or ""). */
  search: string;
  method: string;
  isAuthenticated: boolean;
}

const isUnder = (pathname: string, base: string) =>
  base === "/" ? pathname === "/" : pathname === base || pathname.startsWith(`${base}/`);

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Only same-origin, path-relative targets are accepted as a post-sign-in destination; anything else
 * (absolute URLs, protocol-relative `//host`, backslash tricks, the signed-out pages themselves) falls back
 * to the default landing page. Prevents open redirects through `?callbackUrl=`.
 */
export function safeCallbackUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return DEFAULT_SIGNED_IN_PATH;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return DEFAULT_SIGNED_IN_PATH;
  // Control characters (tabs/newlines) are stripped by URL parsers and can turn "/\t/host" into "//host".
  if (hasControlCharacters(raw)) return DEFAULT_SIGNED_IN_PATH;
  const pathname = raw.split(/[?#]/, 1)[0] ?? "";
  // Bouncing a freshly signed-in user back to /sign-in, /sign-up or an invite link is never what they wanted.
  const rejected = ["/", SIGN_IN_PATH, SIGN_UP_PATH, INVITE_PATH, "/api"];
  if (rejected.some((base) => isUnder(pathname, base))) return DEFAULT_SIGNED_IN_PATH;
  return raw;
}

export function decideAccess(req: AccessRequest): AccessDecision {
  const { pathname, search, method, isAuthenticated } = req;

  // Auth.js' own endpoints (session, csrf, callback, signout) must always be reachable.
  if (isUnder(pathname, "/api/auth")) return { kind: "allow" };

  if (SIGNED_OUT_ONLY_PATHS.some((base) => isUnder(pathname, base))) {
    const isPageLoad = method === "GET" || method === "HEAD";
    const expired = new URLSearchParams(search).has(SESSION_EXPIRED_PARAM);
    // Server-action POSTs to these pages (the sign-in / sign-up forms themselves) always pass through.
    if (isAuthenticated && isPageLoad && !expired) {
      return { kind: "redirect", to: safeCallbackUrl(new URLSearchParams(search).get("callbackUrl")) };
    }
    return { kind: "allow" };
  }

  if (PUBLIC_PATHS.some((base) => isUnder(pathname, base))) return { kind: "allow" };

  if (isAuthenticated) return { kind: "allow" };

  // API consumers get a status code they can act on, never an HTML redirect.
  if (isUnder(pathname, "/api")) return { kind: "unauthorized" };

  // Nothing lives here for anyone: let Next render the 404 rather than asking the visitor to sign in first.
  if (!PROTECTED_PATHS.some((base) => isUnder(pathname, base))) return { kind: "allow" };

  const target = safeCallbackUrl(`${pathname}${search}`);
  // Keep the URL clean when the visitor was heading to the default landing page anyway.
  if (target === DEFAULT_SIGNED_IN_PATH) return { kind: "redirect", to: SIGN_IN_PATH };
  return { kind: "redirect", to: `${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent(target)}` };
}
