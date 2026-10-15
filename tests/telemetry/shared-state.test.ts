import { describe, expect, it, vi } from "vitest";

// Next.js bundles instrumentation.ts and the server actions separately, so the telemetry module can be evaluated
// twice in one process. The state must be one object either way, or the web process starts an exporter and never
// emits anything (found in the web-to-worker receipt run).
describe("telemetry state is shared across module copies", () => {
  it("returns the same state object when the module is evaluated twice", async () => {
    const a = (await import("@/server/telemetry/state")).state;
    vi.resetModules();
    const b = (await import("@/server/telemetry/state")).state;
    expect(b).toBe(a);
  });
});
