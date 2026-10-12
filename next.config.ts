import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Static security headers for every response. The Content-Security-Policy is NOT here: it needs a per-request
 * nonce, so src/middleware.ts sets it (and Next stamps the nonce onto its own inline scripts).
 */
const securityHeaders = [
  // Only meaningful over HTTPS; add `; preload` once every subdomain is confirmed HTTPS-only.
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const allowedOrigins = process.env.SERVER_ACTIONS_ALLOWED_ORIGINS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (node .next/standalone/server.js).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  /**
   * Because the app has middleware, Next also compiles `instrumentation.ts` for the Edge runtime. Its
   * `import("@/server/runtime")` and `import("@/server/telemetry")` are guarded by `NEXT_RUNTIME === "nodejs"`
   * and never execute there, but webpack still follows them and fails on the Node built-ins they need (node:net,
   * node:dns, node:http for the tools layer; http, zlib and Prisma for the OTLP exporter and the telemetry hooks).
   * Resolving those specifiers to an empty module in the Edge compiler keeps the guard honest and the build green.
   * `$` makes it an exact match, so `@/server/runtime/types` (pure types used by client components) still resolves.
   */
  webpack(config, { nextRuntime }) {
    if (nextRuntime === "edge") {
      config.resolve.alias = { ...config.resolve.alias, "@/server/runtime$": false, "@/server/telemetry$": false };
    }
    return config;
  },
  experimental: {
    serverActions: {
      // Largest legitimate payload is a job description / chat message; keep the ceiling tight.
      bodySizeLimit: "256kb",
      ...(allowedOrigins && allowedOrigins.length > 0 ? { allowedOrigins } : {}),
    },
  },
};

export default nextConfig;
