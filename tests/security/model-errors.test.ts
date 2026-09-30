import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { runAction } from "@/lib/action-result";
import { llm } from "@/server/models";
import type { CallTracking } from "@/server/models/types";
import { recordRealSpend } from "@/server/security";
import { createTestOrg } from "../helpers/factory";
import { withModelEnv } from "../models/helpers";

/**
 * Two things every LIVE model call owes the platform:
 *  - F-009 / INF-13: the tenant-visible message is one sentence of ours that names the fix; the provider's own text
 *    (request ids, echoed prompt fragments, API keys) stays in `details` and in ModelCall.error, scrubbed.
 *  - F-004: it cannot start at all when the workspace is suspended or over its monthly budget.
 * Simulated calls cost nothing and are never blocked — the product works end to end without keys.
 */

const PROVIDER_LEAK = "Incorrect API key provided: sk-ant-api03-Zm9vYmFyYmF6cXV4MTIzNDU2";

/** A 401 from the provider's HTTP API, served without touching the network. */
function stubProvider401() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: PROVIDER_LEAK } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  );
}

const neverMock = () => {
  throw new Error("the mock producer must never run on the live path");
};

const liveEnv = { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key", MODEL_TIER_FAST: "anthropic:claude-3-5-haiku-20241022" };

describe("live model failures", () => {
  let t: Awaited<ReturnType<typeof createTestOrg>>;
  let tracking: CallTracking;

  beforeAll(async () => {
    t = await createTestOrg("sec-model");
    tracking = { organizationId: t.organization.id, purpose: "test.security", persist: false };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.orgSpendMonth.deleteMany({ where: { organizationId: t.organization.id } });
    await db.organization.update({ where: { id: t.organization.id }, data: { monthlyBudgetUsd: null, suspendedAt: null } });
  });
  afterAll(async () => {
    await t.cleanup();
  });

  const generate = (over: Partial<CallTracking> = {}) =>
    llm.generateText({ tier: "fast", messages: [{ role: "user", content: "hello" }], mock: neverMock }, { ...tracking, ...over });

  it("returns an actionable message of ours and keeps the provider text in details", async () => {
    stubProvider401();
    const error = await withModelEnv(liveEnv, () => generate().catch((e: unknown) => e));

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("MODEL_ERROR");
    expect(appError.message).toBe("Anthropic rejected the API key — check ANTHROPIC_API_KEY in your .env, then restart Foreman.");
    expect(appError.message).not.toContain("sk-ant");

    const details = appError.details as { provider: string; statusCode: number; providerMessage: string; kind: string };
    expect(details).toMatchObject({ provider: "anthropic", statusCode: 401, kind: "auth" });
    expect(details.providerMessage).toContain("[redacted]");
    expect(details.providerMessage).not.toContain("Zm9vYmFy");
  });

  it("shows that message verbatim to the person who hit it in a server action (describe a job, talk to a worker)", async () => {
    stubProvider401();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await withModelEnv(liveEnv, () => runAction(() => generate()));

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^Anthropic rejected the API key — check ANTHROPIC_API_KEY in your \.env, then restart Foreman\. \(ref [0-9a-f]{6}\)$/,
      ),
    });
    expect(JSON.stringify(result)).not.toContain("sk-ant");
    expect(JSON.stringify(result)).not.toContain("Zm9vYmFy");
    log.mockRestore();
  });

  it("writes the scrubbed detail to ModelCall.error for operators", async () => {
    stubProvider401();
    await withModelEnv(liveEnv, () => generate({ persist: true }).catch(() => undefined));

    const call = await db.modelCall.findFirstOrThrow({
      where: { organizationId: t.organization.id },
      orderBy: { createdAt: "desc" },
    });
    expect(call.error).toContain("HTTP 401");
    expect(call.error).toContain("[redacted]");
    expect(call.error).not.toContain("Zm9vYmFy");
    await db.modelCall.deleteMany({ where: { organizationId: t.organization.id } });
  });

  it("refuses to start a live call for a workspace over its monthly budget", async () => {
    const fetchSpy = stubProvider401();
    await db.organization.update({ where: { id: t.organization.id }, data: { monthlyBudgetUsd: 1 } });
    await recordRealSpend(t.organization.id, 1.5);

    const error = await withModelEnv(liveEnv, () => generate().catch((e: unknown) => e));
    expect((error as AppError).code).toBe("LIMIT_EXCEEDED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to start a live call for a suspended workspace", async () => {
    const fetchSpy = stubProvider401();
    await db.organization.update({ where: { id: t.organization.id }, data: { suspendedAt: new Date() } });

    const error = await withModelEnv(liveEnv, () => generate().catch((e: unknown) => e));
    expect((error as AppError).code).toBe("FORBIDDEN");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never blocks Simulated mode — no spend, no keys, no budget check", async () => {
    await db.organization.update({ where: { id: t.organization.id }, data: { monthlyBudgetUsd: 1, suspendedAt: new Date() } });
    await recordRealSpend(t.organization.id, 99);

    const result = await llm.generateText(
      { tier: "fast", messages: [{ role: "user", content: "hello" }], mock: () => ({ text: "simulated reply" }) },
      tracking,
    );
    expect(result.simulated).toBe(true);
    expect(result.text).toBe("simulated reply");
  });
});
