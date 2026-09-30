/**
 * Content-Security-Policy builder (INF-06). Pure, dependency-free and **edge-safe**: `src/middleware.ts`
 * runs on the Edge runtime, so nothing here may touch Node APIs, Prisma or config.
 *
 * The policy is nonce-based. The middleware puts the nonce on the REQUEST headers (`x-nonce`) and the policy
 * on the response; Next.js reads the request's CSP header and stamps the nonce onto its own inline bootstrap
 * scripts, and the root layout reads `x-nonce` so every route renders dynamically (a prerendered page would
 * otherwise ship un-nonced scripts and break under 'strict-dynamic').
 */

/** Request header the root layout reads to get the per-request nonce. */
export const CSP_NONCE_HEADER = "x-nonce";

/** base64 of a random UUID — the character set a CSP nonce is allowed to use. */
const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,128}$/;

/**
 * A fresh nonce per request. Uses Web Crypto (`crypto.randomUUID`), which exists on both the Edge and Node
 * runtimes; `btoa` is likewise available in both.
 */
export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

export interface CspOptions {
  nonce: string;
  /** Dev needs 'unsafe-eval' (React refresh / source maps) and websocket connections (HMR). */
  dev?: boolean;
  /**
   * `upgrade-insecure-requests` (default: on outside dev). Only an app deliberately served over plain http turns
   * it off — the self-hosted stack on http://localhost — because WebKit (Safari) upgrades same-origin
   * subresources even on localhost, so every script would be requested over https and the page never hydrates.
   */
  upgradeInsecureRequests?: boolean;
}

/**
 * Notes on the two relaxations:
 * - `style-src 'unsafe-inline'`: React SSR emits `style=""` attributes (radix Popper, recharts) and sonner
 *   injects a `<style>` element at runtime. A nonce cannot cover style ATTRIBUTES, and nothing in the app
 *   renders raw HTML (the markdown renderer builds React elements), so the residual risk is low.
 * - `img-src data: blob:` and `font-src data:`: inline SVG data URIs and self-hosted font fallbacks.
 */
export function buildCsp({ nonce, dev = false, upgradeInsecureRequests = !dev }: CspOptions): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error("buildCsp: nonce must be a base64-ish token of 16-128 characters");
  }
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (upgradeInsecureRequests) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/**
 * Policy for responses that carry no markup of ours (redirects, 401/404 JSON): deny everything. Cheap to set
 * and removes any doubt about how a browser might interpret the body.
 */
export const LOCKED_DOWN_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** Policy for a downloaded deliverable: inert even if a browser decides to render it instead of saving it. */
export const DOWNLOAD_CSP = "sandbox; default-src 'none'";
