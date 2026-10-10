import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { cancelRun, decideApproval, executeRun, recoverStaleRuns } from "@/server/runtime";
import { ALLOWED_ATTRIBUTE_KEYS, ATTR, EVENT_NAMES, initTelemetry, MAX_ATTRIBUTE_LENGTH, shutdownTelemetry, SPAN_NAMES } from "@/server/telemetry";
import { tools } from "@/server/tools";
import type { InvokeToolResult } from "@/server/tools/types";
import { createTestOrg } from "../helpers/factory";
import { createHiredWorker } from "../helpers/fixtures";
import { enqueue, loadRun, MINUTES, type Hired, type TestOrg } from "../runtime/helpers";
import { allAttributeEntries, decisions, eventsNamed, executeToolSpans, parentSpanId, sliceSpans, writeEvidence } from "./helpers";

/**
 * The approval lifecycle as OpenTelemetry spans and events (docs/OTEL.md), captured with the SDK's in-memory
 * exporter. Everything runs in Simulated mode; the reviewer is the test org's OWNER.
 */

const SEND = "send_notification";

async function runUntilPaused(t: TestOrg, hired: Hired) {
  const runId = await enqueue(t, hired);
  const outcome = await executeRun(runId);
  if (outcome.status !== "WAITING_FOR_APPROVAL") throw new Error(`expected a pause, got ${outcome.status}`);
  const approval = await db.approval.findUniqueOrThrow({ where: { id: outcome.approvalIds[0] } });
  return { runId, approval };
}

const checkpointIds = (spans: ReadableSpan[]) => eventsNamed(spans, EVENT_NAMES.AGENT_CHECKPOINTED).map((e) => String(e.attributes[ATTR.AGENT_CHECKPOINT_ID]));

describe("telemetry: approval lifecycle (PR #535 decisions, PR #445 pause/checkpoint/resume)", () => {
  let t: TestOrg;
  let notifier: Hired;
  let exporter: InMemorySpanExporter;

  beforeAll(async () => {
    t = await createTestOrg("otel");
    notifier = await createHiredWorker(t.organization.id, { withNotifier: true });
  });
  beforeEach(async () => {
    exporter = new InMemorySpanExporter();
    expect(await initTelemetry({ enabled: true, exporter, processor: "simple" })).toEqual({ enabled: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownTelemetry();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("approve → resume: require_approval, allow, resumed_from=pause and exactly one execute_tool span for the call", async () => {
    const { runId, approval } = await runUntilPaused(t, notifier);

    // Slice 1 paused: the gated call was referred to a human, the conversation was checkpointed, the run paused.
    let spans = exporter.getFinishedSpans();
    const [first] = sliceSpans(spans);
    expect(sliceSpans(spans)).toHaveLength(1);
    expect(first.attributes).toMatchObject({
      [ATTR.OPERATION_NAME]: "invoke_agent",
      [ATTR.AGENT_EXECUTION_ID]: runId,
      [ATTR.AGENT_ID]: notifier.worker.id,
      [ATTR.ORGANIZATION_ID]: t.organization.id,
      [ATTR.RUN_ATTEMPT]: 1,
      [ATTR.RUN_SIMULATED]: true,
      [ATTR.RUN_STATUS]: "WAITING_FOR_APPROVAL",
    });
    expect(first.resource.attributes["service.name"]).toBe("foreman-worker");
    const referred = decisions(spans);
    expect(referred).toHaveLength(1);
    expect(referred[0].span).toBe(first);
    expect(referred[0].attributes).toMatchObject({
      [ATTR.AGENT_EXECUTION_ID]: runId,
      [ATTR.TOOL_NAME]: SEND,
      [ATTR.TOOL_CALL_ID]: approval.toolCallId,
      [ATTR.TOOL_CALL_DECISION_OUTCOME]: "require_approval",
      [ATTR.APPROVAL_ID]: approval.id,
      [ATTR.DECISION_SOURCE]: "policy",
    });
    const paused = eventsNamed(spans, EVENT_NAMES.AGENT_PAUSED);
    expect(paused).toHaveLength(1);
    expect(paused[0].attributes).toMatchObject({ [ATTR.AGENT_EXECUTION_ID]: runId, [ATTR.AGENT_PAUSE_ID]: approval.id, [ATTR.PAUSE_APPROVAL_COUNT]: 1 });
    const ids = checkpointIds(spans);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(new RegExp(`^${runId}:1:\\d+$`));
    const tail = first.events.slice(-3).map((e) => e.name);
    expect(tail).toEqual([EVENT_NAMES.TOOL_CALL_DECISION, EVENT_NAMES.AGENT_CHECKPOINTED, EVENT_NAMES.AGENT_PAUSED]);
    expect(eventsNamed(spans, EVENT_NAMES.AGENT_RESUMED)).toHaveLength(0);
    // The collector's ungated tools ran and were traced; the gated send did not run.
    expect(executeToolSpans(spans).length).toBeGreaterThan(0);
    expect(executeToolSpans(spans, SEND)).toHaveLength(0);
    for (const tool of executeToolSpans(spans)) expect(parentSpanId(tool)).toBe(first.spanContext().spanId);

    // The reviewer approves (no slice is executing, so the decision gets its own span).
    await decideApproval({ organizationId: t.organization.id, approvalId: approval.id, userId: t.user.id, decision: "approve", note: "Looks good" });
    spans = exporter.getFinishedSpans();
    const allowed = decisions(spans, "allow");
    expect(allowed).toHaveLength(1);
    expect(allowed[0].span.name).toBe(SPAN_NAMES.TOOL_CALL_DECISION);
    expect(allowed[0].attributes).toMatchObject({
      [ATTR.AGENT_EXECUTION_ID]: runId,
      [ATTR.TOOL_CALL_ID]: approval.toolCallId,
      [ATTR.TOOL_NAME]: SEND,
      [ATTR.APPROVAL_ID]: approval.id,
      [ATTR.DECISION_SOURCE]: "reviewer",
      [ATTR.DECISION_ACTOR_ROLE]: "OWNER",
    });

    // Slice 2 resumes from the pause and the approved call executes exactly once.
    expect(await executeRun(runId)).toMatchObject({ status: "SUCCEEDED" });
    spans = exporter.getFinishedSpans();
    const slices = sliceSpans(spans);
    expect(slices).toHaveLength(2);
    const second = slices[1];
    expect(second.attributes).toMatchObject({ [ATTR.AGENT_EXECUTION_ID]: runId, [ATTR.RUN_ATTEMPT]: 1, [ATTR.RUN_STATUS]: "SUCCEEDED" });
    const resumed = eventsNamed(spans, EVENT_NAMES.AGENT_RESUMED);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].span).toBe(second);
    expect(resumed[0].attributes).toEqual({
      [ATTR.AGENT_EXECUTION_ID]: runId,
      [ATTR.AGENT_RESUMED_FROM_TYPE]: "pause",
      [ATTR.AGENT_RESUMED_FROM_ID]: approval.id,
    });
    expect(second.events[0].name).toBe(EVENT_NAMES.AGENT_RESUMED);

    const sends = executeToolSpans(spans, SEND);
    expect(sends).toHaveLength(1);
    expect(sends[0].attributes).toMatchObject({
      [ATTR.OPERATION_NAME]: "execute_tool",
      [ATTR.TOOL_NAME]: SEND,
      [ATTR.TOOL_CALL_ID]: approval.toolCallId,
      [ATTR.TOOL_TYPE]: "function",
      [ATTR.AGENT_EXECUTION_ID]: runId,
      [ATTR.RUN_SIMULATED]: true,
    });
    expect(sends[0].status.code).not.toBe(2);
    expect(parentSpanId(sends[0])).toBe(second.spanContext().spanId);
    expect(sends[0].spanContext().traceId).toBe(second.spanContext().traceId);
    // One decision chain, one execution, same call id throughout.
    expect(spans.filter((s) => s.attributes[ATTR.TOOL_CALL_ID] === approval.toolCallId && s.name.startsWith(SPAN_NAMES.EXECUTE_TOOL))).toHaveLength(1);
    expect(decisions(spans).map((d) => d.attributes[ATTR.TOOL_CALL_DECISION_OUTCOME])).toEqual(["require_approval", "allow"]);
    expect(decisions(spans).every((d) => d.attributes[ATTR.TOOL_CALL_ID] === approval.toolCallId)).toBe(true);
    writeEvidence("approve-path.json", spans);
  });

  it("deny → resume: the call is denied once and no execute_tool span ever carries its id", async () => {
    const { runId, approval } = await runUntilPaused(t, notifier);
    await decideApproval({ organizationId: t.organization.id, approvalId: approval.id, userId: t.user.id, decision: "reject", note: "Not this week" });
    expect(await executeRun(runId)).toMatchObject({ status: "SUCCEEDED" });

    const spans = exporter.getFinishedSpans();
    expect(sliceSpans(spans)).toHaveLength(2);
    const denied = decisions(spans, "deny");
    expect(denied).toHaveLength(1);
    expect(denied[0].attributes).toMatchObject({
      [ATTR.TOOL_CALL_ID]: approval.toolCallId,
      [ATTR.TOOL_NAME]: SEND,
      [ATTR.APPROVAL_ID]: approval.id,
      [ATTR.DECISION_SOURCE]: "reviewer",
      [ATTR.DECISION_ACTOR_ROLE]: "OWNER",
    });
    expect(decisions(spans).map((d) => d.attributes[ATTR.TOOL_CALL_DECISION_OUTCOME])).toEqual(["require_approval", "deny"]);
    expect(executeToolSpans(spans, SEND)).toHaveLength(0);
    expect(executeToolSpans(spans).filter((s) => s.attributes[ATTR.TOOL_CALL_ID] === approval.toolCallId)).toHaveLength(0);
    const resumed = eventsNamed(spans, EVENT_NAMES.AGENT_RESUMED);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].attributes).toMatchObject({ [ATTR.AGENT_RESUMED_FROM_TYPE]: "pause", [ATTR.AGENT_RESUMED_FROM_ID]: approval.id });
    expect((await db.toolCall.findUniqueOrThrow({ where: { id: approval.toolCallId } })).status).toBe("DENIED");
    writeEvidence("deny-path.json", spans);
  });

  it("expiry: a cancelled run and a stale decision both record outcome=expired, and the call never executes", async () => {
    // (a) The run is cancelled while waiting: its pending request expires with the run.
    const cancelled = await runUntilPaused(t, notifier);
    await cancelRun(t.session, cancelled.runId);
    let spans = exporter.getFinishedSpans();
    let expired = decisions(spans, "expired");
    expect(expired).toHaveLength(1);
    expect(expired[0].span.name).toBe(SPAN_NAMES.TOOL_CALL_DECISION);
    expect(expired[0].attributes).toMatchObject({
      [ATTR.AGENT_EXECUTION_ID]: cancelled.runId,
      [ATTR.TOOL_CALL_ID]: cancelled.approval.toolCallId,
      [ATTR.APPROVAL_ID]: cancelled.approval.id,
      [ATTR.DECISION_SOURCE]: "system",
      [ATTR.DECISION_REASON]: "run_ended",
    });
    expect((await db.approval.findUniqueOrThrow({ where: { id: cancelled.approval.id } })).status).toBe("EXPIRED");

    // (b) The run moved on before the reviewer clicked: the late decision expires the request instead.
    const stale = await runUntilPaused(t, notifier);
    await db.run.update({ where: { id: stale.runId }, data: { status: "QUEUED" } });
    await expect(decideApproval({ organizationId: t.organization.id, approvalId: stale.approval.id, userId: t.user.id, decision: "approve" })).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === "CONFLICT",
    );
    spans = exporter.getFinishedSpans();
    expired = decisions(spans, "expired");
    expect(expired).toHaveLength(2);
    expect(expired[1].attributes).toMatchObject({
      [ATTR.AGENT_EXECUTION_ID]: stale.runId,
      [ATTR.TOOL_CALL_ID]: stale.approval.toolCallId,
      [ATTR.APPROVAL_ID]: stale.approval.id,
      [ATTR.DECISION_SOURCE]: "system",
      [ATTR.DECISION_REASON]: "stale_decision",
    });
    expect(decisions(spans, "allow")).toHaveLength(0);
    expect(executeToolSpans(spans, SEND)).toHaveLength(0);
    await db.run.update({ where: { id: stale.runId }, data: { status: "CANCELLED", finishedAt: new Date() } });
  });

  it("worker restart: the recovered slice resumes from a checkpoint id that was emitted before the crash", async () => {
    const hired = await createHiredWorker(t.organization.id);
    const runId = await enqueue(t, hired);
    const original = tools.invoke;
    let fetches = 0;
    let unblock!: (r: InvokeToolResult) => void;
    const spy = vi.spyOn(tools, "invoke").mockImplementation(async (args) => {
      if (args.ctx.runId === runId && args.toolName === "fetch_url" && ++fetches === 3) {
        // The executor "dies" while the third page is being read.
        return new Promise<InvokeToolResult>((r) => (unblock = r));
      }
      return original(args);
    });
    const dead = executeRun(runId, { executorId: "doomed" });
    await vi.waitFor(() => expect(fetches).toBe(3), { timeout: 10_000 });
    await db.run.update({ where: { id: runId }, data: { heartbeatAt: new Date(Date.now() - 30 * MINUTES) } });
    expect(await recoverStaleRuns({ organizationId: t.organization.id })).toBe(1);
    spy.mockRestore();

    expect(await executeRun(runId)).toMatchObject({ status: "SUCCEEDED" });
    // Let the dead slice notice it lost the run; its span (with the checkpoints it wrote) is exported when it ends.
    unblock({ status: "error", message: "late", latencyMs: 1 });
    await dead;

    const spans = exporter.getFinishedSpans();
    const slices = sliceSpans(spans);
    expect(slices).toHaveLength(2);
    const recovered = slices.find((s) => s.attributes[ATTR.RUN_ATTEMPT] === 2);
    const crashed = slices.find((s) => s.attributes[ATTR.RUN_ATTEMPT] === 1);
    expect(recovered).toBeDefined();
    expect(crashed).toBeDefined();
    expect(crashed!.attributes[ATTR.RUN_STATUS]).toBe("INTERRUPTED");
    expect(recovered!.attributes[ATTR.RUN_STATUS]).toBe("SUCCEEDED");

    const resumed = eventsNamed([recovered!], EVENT_NAMES.AGENT_RESUMED);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].attributes[ATTR.AGENT_RESUMED_FROM_TYPE]).toBe("checkpoint");
    const from = String(resumed[0].attributes[ATTR.AGENT_RESUMED_FROM_ID]);
    expect(from).toMatch(new RegExp(`^${runId}:1:\\d+$`));
    expect(checkpointIds([crashed!])).toContain(from);
    expect(eventsNamed(spans, EVENT_NAMES.AGENT_PAUSED)).toHaveLength(0);
    expect((await loadRun(runId)).attempt).toBe(2);
    // The resumed batch replayed the pages fetched before the crash instead of re-running them: no call that has
    // an execute_tool span under the crashed slice (other than the one it was still running) appears again under
    // the recovered slice, and nothing under the recovered slice ran twice.
    const fetchSpans = executeToolSpans(spans, "fetch_url");
    const doneBeforeCrash = fetchSpans.filter((s) => parentSpanId(s) === crashed!.spanContext().spanId && s.status.code !== 2).map((s) => s.attributes[ATTR.TOOL_CALL_ID]);
    expect(doneBeforeCrash).toHaveLength(2);
    const afterRecovery = fetchSpans.filter((s) => parentSpanId(s) === recovered!.spanContext().spanId).map((s) => s.attributes[ATTR.TOOL_CALL_ID]);
    expect(afterRecovery.length).toBeGreaterThan(0);
    expect(new Set(afterRecovery).size).toBe(afterRecovery.length);
    for (const id of doneBeforeCrash) expect(afterRecovery).not.toContain(id);
  });

  it("disabled (the default): no provider, no spans, no behaviour change", async () => {
    await shutdownTelemetry();
    delete process.env.OTEL_ENABLED;
    expect(await initTelemetry()).toEqual({ enabled: false });
    const quiet = new InMemorySpanExporter();
    expect(await initTelemetry({ enabled: false, exporter: quiet })).toEqual({ enabled: false });

    const { runId, approval } = await runUntilPaused(t, notifier);
    await decideApproval({ organizationId: t.organization.id, approvalId: approval.id, userId: t.user.id, decision: "approve" });
    expect(await executeRun(runId)).toMatchObject({ status: "SUCCEEDED" });
    expect(quiet.getFinishedSpans()).toEqual([]);
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect((await db.toolCall.findUniqueOrThrow({ where: { id: approval.toolCallId } })).status).toBe("SUCCEEDED");
  });

  it("never exports prompts, inputs, outputs, names, emails or notes: only allowlisted keys with short values", async () => {
    const { runId, approval } = await runUntilPaused(t, notifier);
    await decideApproval({ organizationId: t.organization.id, approvalId: approval.id, userId: t.user.id, decision: "approve", note: "Looks good to me" });
    expect(await executeRun(runId)).toMatchObject({ status: "SUCCEEDED" });
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(2);

    const payload = approval.payload as { subject: string; recipients: string[]; body: string };
    const forbidden = [t.user.email, t.user.name, "Looks good", approval.title, payload.subject, payload.body.slice(0, 40), ...payload.recipients, notifier.spec.title, notifier.blueprint.persona.name, "@"];
    for (const [key, value] of allAttributeEntries(spans)) {
      expect(ALLOWED_ATTRIBUTE_KEYS.has(key)).toBe(true);
      expect(["string", "number", "boolean"]).toContain(typeof value);
      if (typeof value === "string") {
        expect(value.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_LENGTH);
        for (const needle of forbidden) expect(value).not.toContain(needle);
      }
    }
    // Span names carry the tool name only.
    for (const span of spans) expect(span.name).toMatch(/^(invoke_agent|tool_call_decision|execute_tool [a-z_]+)$/);
    // The reviewer is a role, not a person.
    const allow = decisions(spans, "allow")[0];
    expect(allow.attributes[ATTR.DECISION_ACTOR_ROLE]).toBe("OWNER");
    expect(Object.keys(allow.attributes)).not.toContain("foreman.decision.actor.name");
  });
});
