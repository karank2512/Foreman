import NextAuth from "next-auth";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { authConfig } from "@/server/auth/auth.config";
import { CSP_NONCE_HEADER, DOWNLOAD_CSP, LOCKED_DOWN_CSP, buildCsp, createNonce } from "@/server/security/csp";

/**
 * Runs on the Edge runtime, so it is built from the edge-safe config only (no Prisma / bcrypt).
 *
 * Two jobs:
 *  1. The Auth.js gate (`authorized` in auth.config.ts → decideAccess) —
 *       unauthenticated page request   → redirect to /sign-in?callbackUrl=…
 *       unauthenticated /api/* request → 401 JSON (except /api/auth/*)
 *       signed-in visitor on /sign-in  → redirect into the app
 *     Whether the user row still exists is checked later by getSession()/requireSession() (Node runtime).
 *  2. A per-request Content-Security-Policy (INF-06). Pages get a nonce-based policy: the nonce goes on the
 *     REQUEST headers so Next.js stamps its own inline bootstrap scripts with it (and the root layout reads
 *     `x-nonce`, which makes every route render dynamically); the policy itself goes on the response.
 *
 * Next.js applies the headers of the pass-through response set here ON TOP of whatever the route handler
 * answers with, so the policy chosen here is the one the browser sees — a handler cannot override it. The
 * route handlers that serve non-HTML therefore get their inert policies from here: the deliverable download
 * is sandboxed (`DOWNLOAD_CSP`, the same header its handler sets) and the JSON API is denied everything.
 */

const CSP_HEADER = "Content-Security-Policy";
const CACHE_HEADER = "Cache-Control";
const isDev = process.env.NODE_ENV !== "production";

/** `/deliverables/<id>/download` — the one route that streams worker output as a file. */
const DOWNLOAD_PATH = /^\/deliverables\/[^/]+\/download\/?$/;

const isApiPath = (pathname: string): boolean => pathname === "/api" || pathname.startsWith("/api/");

/** Which policy a request gets. Only pages carry a nonce; the file and JSON routes render no markup of ours. */
function policyFor(pathname: string): { csp: string; nonce: string | null } {
  if (DOWNLOAD_PATH.test(pathname)) return { csp: DOWNLOAD_CSP, nonce: null };
  if (isApiPath(pathname)) return { csp: LOCKED_DOWN_CSP, nonce: null };
  const nonce = createNonce();
  return { csp: buildCsp({ nonce, dev: isDev }), nonce };
}

/** Auth.js types `auth(handler)` for route handlers; in middleware Next.js passes a NextFetchEvent. */
type EdgeMiddleware = (request: NextRequest, event: NextFetchEvent) => Promise<Response>;

const gate = NextAuth(authConfig).auth((request) => {
  const { csp, nonce } = policyFor(request.nextUrl.pathname);
  if (nonce === null) {
    const response = NextResponse.next();
    response.headers.set(CSP_HEADER, csp);
    return response;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER.toLowerCase(), csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, csp);
  return response;
}) as unknown as EdgeMiddleware;

/**
 * When the gate answers with a redirect or a 401 it short-circuits the handler above, so those responses
 * would carry no policy at all. They contain no markup of ours, so they get the inert policy instead. They
 * also depend on the visitor's cookie, so no cache may keep them; the JSON API is `no-store` by contract, and
 * setting it here means a handler that forgets it is still safe.
 */
export default async function middleware(request: NextRequest, event: NextFetchEvent): Promise<Response> {
  const response = (await gate(request, event)) as Response;
  if (!response) return response;
  if (!response.headers.has(CSP_HEADER)) response.headers.set(CSP_HEADER, LOCKED_DOWN_CSP);
  const gateAnswered = response.status === 401 || response.headers.has("Location");
  if (!response.headers.has(CACHE_HEADER) && (gateAnswered || isApiPath(request.nextUrl.pathname))) {
    response.headers.set(CACHE_HEADER, "no-store");
  }
  return response;
}

export const config = {
  // Everything except Next.js internals, Auth.js' own endpoints, the ops probes and public static assets.
  // The extension list is explicit (rather than "anything with a dot") so a future route like
  // /api/…/export.csv stays protected. "/", "/sign-up" and "/invite/*" are matched on purpose: decideAccess
  // decides what is public, and they still need a CSP.
  matcher: [
    "/((?!_next/static|_next/image|api/auth/|api/health|api/ready|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest|map|woff|woff2|ttf)$).*)",
  ],
};
