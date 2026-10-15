import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The web process's telemetry guard (src/instrumentation.ts): `initTelemetry()` runs only in the Node runtime,
 * outside `next build`, and only when OTEL_ENABLED is true — and the telemetry module is not even imported
 * otherwise. The module is mocked so no provider, exporter or socket is created here.
 */

const mocks = vi.hoisted(() => ({
  initTelemetry: vi.fn(async () => ({ enabled: true })),
  loaded: vi.fn(),
}));

vi.mock("@/server/telemetry", () => {
  mocks.loaded();
  return { initTelemetry: mocks.initTelemetry };
});

const ORIGINAL = { ...process.env };

async function registerWith(env: Record<string, string | undefined>): Promise<void> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // A fresh copy of instrumentation.ts (and of the config it reads) for every scenario.
  vi.resetModules();
  const { register } = await import("@/instrumentation");
  await register();
}

describe("telemetry: web process guard (src/instrumentation.ts register)", () => {
  beforeEach(() => {
    mocks.initTelemetry.mockClear();
    mocks.loaded.mockClear();
    delete process.env.OTEL_ENABLED;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.NEXT_PHASE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("never loads telemetry on the Edge runtime, even when enabled", async () => {
    await registerWith({ NEXT_RUNTIME: "edge", OTEL_ENABLED: "true" });
    expect(mocks.loaded).not.toHaveBeenCalled();
    expect(mocks.initTelemetry).not.toHaveBeenCalled();
  });

  it("does nothing during `next build`", async () => {
    await registerWith({ NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build", OTEL_ENABLED: "true" });
    expect(mocks.loaded).not.toHaveBeenCalled();
    expect(mocks.initTelemetry).not.toHaveBeenCalled();
  });

  it("with OTEL_ENABLED unset or false the telemetry module is not imported", async () => {
    await registerWith({ NEXT_RUNTIME: "nodejs", OTEL_ENABLED: undefined });
    await registerWith({ NEXT_RUNTIME: "nodejs", OTEL_ENABLED: "false" });
    expect(mocks.loaded).not.toHaveBeenCalled();
    expect(mocks.initTelemetry).not.toHaveBeenCalled();
  });

  it("with OTEL_ENABLED=true in the Node runtime it starts telemetry as foreman-web with the simple processor", async () => {
    await registerWith({ NEXT_RUNTIME: "nodejs", OTEL_ENABLED: "true" });
    expect(mocks.initTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.initTelemetry).toHaveBeenCalledWith({ serviceName: "foreman-web", processor: "simple" });
  });

  it("OTEL_SERVICE_NAME renames the web service too", async () => {
    await registerWith({ NEXT_RUNTIME: "nodejs", OTEL_ENABLED: "true", OTEL_SERVICE_NAME: "foreman-review" });
    expect(mocks.initTelemetry).toHaveBeenCalledWith({ serviceName: "foreman-review", processor: "simple" });
  });

  it("a telemetry failure is logged and does not stop the web server from booting", async () => {
    mocks.initTelemetry.mockRejectedValueOnce(new Error("collector unreachable"));
    await expect(registerWith({ NEXT_RUNTIME: "nodejs", OTEL_ENABLED: "true" })).resolves.toBeUndefined();
    expect(mocks.initTelemetry).toHaveBeenCalledTimes(1);
  });
});
