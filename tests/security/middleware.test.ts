import { encode } from "@auth/core/jwt";
import type { NextFetchEvent } from "next/server";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import middleware from "@/middleware";
import { DOWNLOAD_CSP, LOCKED_DOWN_CSP } from "@/server/security/csp";

/**
 * Drives the real middleware (Auth.js gate + CSP) with a NextRequest, signed out and with a genuine session
 * cookie. Next.js applies the headers of the middleware's pass-through response on top of the route handler's
 * own, so what is asserted here is what the browser actually receives — the route-handler tests in
 * routes.test.ts only see the handler's half.
 */

const ORIGIN = "http://localhost:3000";
const CSP = "Content-Security-Policy";
const event = {} as NextFetchEvent;

let sessionCookie = "";

beforeAll(async () => {
  // Same shape the jwt callback persists at sign-in; the secret and cookie name (= salt) are what the
  // middleware's Auth.js instance uses to decode it.
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET must be set for the middleware tests (see .env.test)");
  const token = await encode({
    token: { sub: "user_1", userId: "user_1", organizationId: "org_1", role: "OWNER", sv: 0, authAt: Math.floor(Date.now() / 1000) },
    secret,
    salt: "authjs.session-token",
    maxAge: 60,
  });
  sessionCookie = `authjs.session-token=${token}`;
});

/**
 * Next.js stamps `host` and `x-forwarded-proto` on every request that reaches the middleware. Auth.js derives
 * the cookie name from that protocol (an unknown one is assumed https, whose cookie is `__Secure-…`), so a
 * bare `new NextRequest(url)` would never see the session.
 */
const call = (path: string, opts: { signedIn?: boolean } = {}) =>
  middleware(
    new NextRequest(`${ORIGIN}${path}`, {
      headers: { host: "localhost:3000", "x-forwarded-proto": "http", ...(opts.signedIn ? { cookie: sessionCookie } : {}) },
    }),
    event,
  );

const passesThrough = (response: Response) => response.status === 200 && response.headers.get("x-middleware-next") === "1";

describe("middleware: signed out", () => {
  it("answers /api/* with 401 JSON that is inert and never cached", async () => {
    const response = await call("/api/runs/run_1");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not signed in", code: "UNAUTHENTICATED" });
    expect(response.headers.get(CSP)).toBe(LOCKED_DOWN_CSP);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("redirects a page request to sign-in with an inert policy and no caching", async () => {
    const response = await call("/workers/w1?tab=cost");
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("Location") ?? "").pathname).toBe("/sign-in");
    expect(response.headers.get(CSP)).toBe(LOCKED_DOWN_CSP);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("redirects an unauthenticated download rather than sandboxing a sign-in page", async () => {
    const response = await call("/deliverables/d1/download");
    expect(response.status).toBe(307);
    expect(response.headers.get(CSP)).toBe(LOCKED_DOWN_CSP);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("middleware: signed in", () => {
  it("lets the app pages through with the nonce policy and no cache directive of its own", async () => {
    const response = await call("/workforce", { signedIn: true });
    expect(passesThrough(response)).toBe(true);
    const csp = response.headers.get(CSP) ?? "";
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toContain("sandbox");
    // Pages decide their own caching; the middleware only pins the file and JSON routes.
    expect(response.headers.has("Cache-Control")).toBe(false);
  });

  it("sandboxes the deliverable download so the handler's policy is what the browser sees", async () => {
    const response = await call("/deliverables/cmudb483c0013rw3xsrmykh9b/download", { signedIn: true });
    expect(passesThrough(response)).toBe(true);
    expect(response.headers.get(CSP)).toBe(DOWNLOAD_CSP);
    expect(response.headers.get(CSP)).not.toContain("nonce-");
  });

  it("does not mistake a page under /deliverables for the download", async () => {
    for (const path of ["/deliverables/d1", "/deliverables/d1/downloads", "/deliverables/download", "/deliverables/d1/x/download"]) {
      const response = await call(path, { signedIn: true });
      expect(passesThrough(response), path).toBe(true);
      expect(response.headers.get(CSP), path).toContain("script-src 'self' 'nonce-");
    }
  });

  it("gives the JSON API the deny-all policy and no-store", async () => {
    const response = await call("/api/runs/run_1", { signedIn: true });
    expect(passesThrough(response)).toBe(true);
    expect(response.headers.get(CSP)).toBe(LOCKED_DOWN_CSP);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("issues a fresh nonce per page request", async () => {
    const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];
    const a = nonceOf((await call("/workforce", { signedIn: true })).headers.get(CSP) ?? "");
    const b = nonceOf((await call("/workforce", { signedIn: true })).headers.get(CSP) ?? "");
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});
