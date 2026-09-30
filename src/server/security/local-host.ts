/**
 * DNS-rebinding guard for a Foreman served over plain http on localhost (the self-hosted Docker or Node stack).
 * Pure and edge-safe: src/middleware.ts runs on the Edge runtime.
 *
 * That stack has open sign-up and the owner's provider key behind it, and it answers on loopback. A web page the
 * owner visits can rebind its own domain to 127.0.0.1 and then script requests to it: the browser treats them as
 * same-origin for the attacker's domain, Next.js's Server Action check passes (Origin and Host agree), and the page
 * could sign up and run workers on the owner's key. What such a request cannot fake is the Host header — it carries
 * the attacker's domain — so only loopback names (and the configured origin) are answered.
 *
 * https deployments are untouched: they are reached through their own domain, where rebinding buys nothing.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** "localhost:3000" → "localhost", "[::1]:3000" → "[::1]". Lower-cased; the port does not matter. */
function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * Whether a request's Host header may be served. Only enforced when the configured public origin is plain http —
 * the localhost-only case env.ts allows — so a real https deployment behaves exactly as before.
 */
export function isAllowedHost(host: string | null, publicUrl: string | undefined): boolean {
  if (!publicUrl?.startsWith("http://")) return true;
  if (!host) return false;
  const hostname = hostnameOf(host);
  if (LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) return true;
  try {
    return hostname === new URL(publicUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
}
