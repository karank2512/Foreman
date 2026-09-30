import { describe, expect, it } from "vitest";
import { config as middlewareConfig } from "@/middleware";
import { CSP_NONCE_HEADER, DOWNLOAD_CSP, LOCKED_DOWN_CSP, buildCsp, createNonce } from "@/server/security/csp";

const directives = (csp: string): Map<string, string> =>
  new Map(
    csp.split("; ").map((d) => {
      const [name, ...rest] = d.split(" ");
      return [name as string, rest.join(" ")];
    }),
  );

describe("buildCsp", () => {
  const nonce = "dGVzdC1ub25jZS12YWx1ZS0xMjM0";

  it("locks the page down and allows scripts only through the nonce", () => {
    const d = directives(buildCsp({ nonce }));
    expect(d.get("default-src")).toBe("'self'");
    expect(d.get("script-src")).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(d.get("style-src")).toBe("'self' 'unsafe-inline'");
    expect(d.get("img-src")).toBe("'self' data: blob:");
    expect(d.get("font-src")).toBe("'self' data:");
    expect(d.get("connect-src")).toBe("'self'");
    expect(d.get("object-src")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'self'");
    expect(d.get("form-action")).toBe("'self'");
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.has("upgrade-insecure-requests")).toBe(true);
  });

  it("adds only the development relaxations in dev", () => {
    const dev = directives(buildCsp({ nonce, dev: true }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toBe("'self' ws: wss:");
    expect(dev.has("upgrade-insecure-requests")).toBe(false);

    const prod = buildCsp({ nonce });
    expect(prod).not.toContain("unsafe-eval");
    expect(prod).not.toContain("ws:");
  });

  it("drops only upgrade-insecure-requests for an app served over plain http (the localhost Docker stack)", () => {
    const http = directives(buildCsp({ nonce, upgradeInsecureRequests: false }));
    expect(http.has("upgrade-insecure-requests")).toBe(false);
    expect(http.get("script-src")).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(http.get("connect-src")).toBe("'self'");
  });

  it("refuses a nonce that could break out of the header", () => {
    expect(() => buildCsp({ nonce: "abc" })).toThrow(/nonce/i);
    expect(() => buildCsp({ nonce: "'; script-src *; x='aaaaaaaaaaaaaaaaaaaa" })).toThrow(/nonce/i);
    expect(() => buildCsp({ nonce: "" })).toThrow(/nonce/i);
  });

  it("creates fresh, header-safe nonces", () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
    expect(() => buildCsp({ nonce: a })).not.toThrow();
    expect(a).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("offers inert policies for non-HTML responses", () => {
    expect(LOCKED_DOWN_CSP).toContain("default-src 'none'");
    expect(LOCKED_DOWN_CSP).toContain("frame-ancestors 'none'");
    expect(DOWNLOAD_CSP).toBe("sandbox; default-src 'none'");
  });

  it("names the request header the root layout reads", () => {
    expect(CSP_NONCE_HEADER).toBe("x-nonce");
  });
});

describe("middleware matcher", () => {
  const matches = (pathname: string): boolean =>
    middlewareConfig.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));

  it("runs on app pages and the poll API", () => {
    for (const path of ["/", "/workforce", "/runs/run_123", "/api/runs/run_123", "/sign-up", "/invite/tok"]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("skips Auth.js endpoints, static assets and the ops probes", () => {
    for (const path of ["/api/auth/session", "/api/health", "/api/ready", "/_next/static/chunk.js", "/favicon.ico", "/logo.svg"]) {
      expect(matches(path), path).toBe(false);
    }
  });
});
