import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_ATTRIBUTE_KEYS } from "@/server/telemetry";
import { ALLOWED_ATTRIBUTE_KEYS as SCRIPT_ALLOWED_KEYS, checkReceipt, flattenSpans, formatTable, normalizeId, parseCapture } from "../../scripts/otel-check.mjs";
import { decodeBody, summarizeBody } from "../../scripts/otel-receiver.mjs";

/**
 * The receipt tooling in scripts/ (docs/OTEL.md, "Web to worker through a real OTLP receiver") on a captured
 * fixture: two runs in Simulated mode, one approved and one denied by a reviewer in the web process, as the
 * receiver writes them (one OTLP/HTTP JSON export request per line).
 */

interface KeyValue {
  key: string;
  value: Record<string, unknown>;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: KeyValue[];
  events: Array<{ name: string; attributes: KeyValue[] }>;
}
interface OtlpBody {
  resourceSpans: Array<{ resource: { attributes: KeyValue[] }; scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }> }>;
}

const FIXTURE = fileURLToPath(new URL("./fixtures/web-worker-receipt.ndjson", import.meta.url));
const APPROVE_CALL = "tc_approve_0001";
const DENY_CALL = "tc_deny_0001";

function loadBodies(): OtlpBody[] {
  return parseCapture(readFileSync(FIXTURE, "utf8")) as OtlpBody[];
}

function allSpans(bodies: OtlpBody[]): OtlpSpan[] {
  return bodies.flatMap((b) => b.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
}

function spanNamed(bodies: OtlpBody[], name: string, callId?: string): OtlpSpan {
  const span = allSpans(bodies).find((s) => s.name === name && (callId === undefined || s.attributes.some((a) => a.key === "gen_ai.tool.call.id" && a.value.stringValue === callId)));
  if (!span) throw new Error(`fixture has no span ${name}${callId ? ` for ${callId}` : ""}`);
  return span;
}

function run(bodies: OtlpBody[]) {
  return checkReceipt(flattenSpans(bodies));
}

function failures(bodies: OtlpBody[]): string[] {
  return run(bodies)
    .rows.filter((r) => !r.ok)
    .map((r) => `${r.chain}: ${r.check}`);
}

describe("telemetry: OTLP receipt checker (scripts/otel-check.mjs)", () => {
  it("mirrors the telemetry allowlist exactly", () => {
    expect([...SCRIPT_ALLOWED_KEYS].sort()).toEqual([...ALLOWED_ATTRIBUTE_KEYS].sort());
  });

  it("parses the receiver's capture: one export request per line, envelope or bare body", () => {
    const bodies = loadBodies();
    expect(bodies).toHaveLength(6);
    const bare = parseCapture(bodies.map((b) => JSON.stringify(b)).join("\n\n"));
    expect(bare).toEqual(bodies);
    expect(() => parseCapture("{not json")).toThrow(/line 1/);
    const spans = flattenSpans(bodies);
    expect(spans).toHaveLength(9);
    expect(new Set(spans.map((s) => s.service))).toEqual(new Set(["foreman-worker", "foreman-web"]));
    expect(spans.every((s) => s.scope === "foreman.runtime")).toBe(true);
    // Attribute values come back typed, not as OTLP AnyValue wrappers.
    const slice = spans.find((s) => s.name === "invoke_agent");
    expect(slice?.attributes).toMatchObject({ "foreman.run.attempt": 1, "foreman.run.simulated": true, "foreman.run.status": "WAITING_FOR_APPROVAL" });
  });

  it("accepts base64 ids (proto3 JSON) as well as the hex the JS exporter sends", () => {
    expect(normalizeId("A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1")).toBe("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
    expect(normalizeId("AAECAwQFBgcICQoLDA0ODw==")).toBe("000102030405060708090a0b0c0d0e0f");
    expect(normalizeId("CgoKCgoKCgE=")).toBe("0a0a0a0a0a0a0a01");
    expect(normalizeId(undefined)).toBe("");
  });

  it("passes on the fixture: worker gate, web decision in another trace, one execution for allow and none for deny", () => {
    const result = run(loadBodies());
    expect(result.rows.filter((r) => !r.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.chains.map((c) => [c.callId, c.verdict])).toEqual([
      [APPROVE_CALL, "allow"],
      [DENY_CALL, "deny"],
    ]);
    expect(result.ignoredCallIds).toEqual([]);
    const checks = result.rows.map((r) => r.check);
    for (const check of [
      "require_approval recorded in the worker service",
      "allow recorded in the web service",
      "deny recorded in the web service",
      "decision trace differs from the run's trace",
      "same gen_ai.tool.call.id on both events",
      "same gen_ai.agent.execution.id on both events",
      "exactly one execute_tool span with this call id",
      "no execute_tool span with this call id",
      "worker resumed the run from this pause",
      "at least one approved and one denied call",
      "every attribute key is in ALLOWED_ATTRIBUTE_KEYS",
      "every span is from scope foreman.runtime",
    ]) {
      expect(checks).toContain(check);
    }
    const table = formatTable(result.rows);
    expect(table).toMatch(/^RESULT\s+CHAIN\s+CHECK\s+DETAIL/);
    expect(table).not.toContain("FAIL");
  });

  it("fails when the approved call never executed, or the denied one did", () => {
    const noExecution = loadBodies();
    const resumed = noExecution[2].resourceSpans[0].scopeSpans[0];
    resumed.spans = resumed.spans.filter((s) => s.name !== "execute_tool send_notification");
    expect(failures(noExecution)).toEqual([`approve ${APPROVE_CALL}: exactly one execute_tool span with this call id`]);

    const denyRan = loadBodies();
    const execution = structuredClone(spanNamed(denyRan, "execute_tool send_notification", APPROVE_CALL));
    for (const attr of execution.attributes) {
      if (attr.key === "gen_ai.tool.call.id") attr.value = { stringValue: DENY_CALL };
      if (attr.key === "gen_ai.agent.execution.id") attr.value = { stringValue: "run_deny_0001" };
    }
    denyRan[5].resourceSpans[0].scopeSpans[0].spans.push(execution);
    expect(failures(denyRan)).toEqual([`deny ${DENY_CALL}: no execute_tool span with this call id`]);
  });

  it("fails when the decision did not come from the web service, or shares the run's trace", () => {
    const sameProcess = loadBodies();
    for (const attr of sameProcess[1].resourceSpans[0].resource.attributes) if (attr.key === "service.name") attr.value = { stringValue: "foreman-worker" };
    expect(failures(sameProcess)).toEqual([`approve ${APPROVE_CALL}: allow recorded in the web service`]);

    const sameTrace = loadBodies();
    const denyGate = allSpans(sameTrace).find((s) => s.name === "invoke_agent" && s.attributes.some((a) => a.key === "gen_ai.agent.execution.id" && a.value.stringValue === "run_deny_0001"));
    expect(denyGate).toBeDefined();
    spanNamed(sameTrace, "tool_call_decision", DENY_CALL).traceId = denyGate!.traceId;
    expect(failures(sameTrace)).toEqual([`deny ${DENY_CALL}: decision trace differs from the run's trace`]);
  });

  it("fails when the ids do not line up across the two processes", () => {
    const bodies = loadBodies();
    const decision = spanNamed(bodies, "tool_call_decision", APPROVE_CALL);
    for (const attr of decision.events[0].attributes) if (attr.key === "gen_ai.agent.execution.id") attr.value = { stringValue: "run_other" };
    expect(failures(bodies)).toEqual([`approve ${APPROVE_CALL}: same gen_ai.agent.execution.id on both events`]);
  });

  it("fails when the worker never resumed from the pause", () => {
    const bodies = loadBodies();
    const resumedSlice = allSpans(bodies).find((s) => s.events.some((e) => e.name === "gen_ai.agent.resumed" && e.attributes.some((a) => a.value.stringValue === "apr_approve_0001")));
    expect(resumedSlice).toBeDefined();
    resumedSlice!.events = resumedSlice!.events.filter((e) => e.name !== "gen_ai.agent.resumed");
    expect(failures(bodies)).toEqual([`approve ${APPROVE_CALL}: worker resumed the run from this pause`]);
  });

  it("fails on any attribute key outside the allowlist and on spans from another scope", () => {
    const leaked = loadBodies();
    spanNamed(leaked, "tool_call_decision", APPROVE_CALL).attributes.push({ key: "http.target", value: { stringValue: "/approvals?note=hello" } });
    spanNamed(leaked, "invoke_agent").events[0].attributes.push({ key: "user.email", value: { stringValue: "someone@example.com" } });
    const result = run(leaked);
    const row = result.rows.find((r) => r.check === "every attribute key is in ALLOWED_ATTRIBUTE_KEYS");
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("http.target");
    expect(row?.detail).toContain("user.email");

    const foreign = loadBodies();
    foreign[1].resourceSpans[0].scopeSpans[0].scope.name = "next.js";
    expect(failures(foreign)).toEqual(["capture: every span is from scope foreman.runtime"]);
  });

  it("needs both an approved and a denied call, and ignores calls no reviewer decided on", () => {
    const onlyApprove = loadBodies().slice(0, 3);
    const result = run(onlyApprove);
    expect(result.ok).toBe(false);
    expect(result.rows.find((r) => r.check === "at least one approved and one denied call")?.detail).toBe("1 approved, 0 denied, 0 without a reviewer decision (ignored)");

    const pending = loadBodies().slice(0, 4);
    const pendingResult = run(pending);
    expect(pendingResult.ignoredCallIds).toEqual([DENY_CALL]);
    expect(pendingResult.chains).toHaveLength(1);
  });
});

describe("telemetry: OTLP receiver (scripts/otel-receiver.mjs)", () => {
  const body = JSON.stringify({ resourceSpans: [] });

  it("decodes JSON, gzipped JSON and rejects protobuf with an explanation", () => {
    expect(decodeBody({ contentType: "application/json", raw: Buffer.from(body) })).toEqual({ ok: true, body: { resourceSpans: [] } });
    expect(decodeBody({ contentType: "application/json; charset=utf-8", contentEncoding: "gzip", raw: gzipSync(Buffer.from(body)) })).toEqual({ ok: true, body: { resourceSpans: [] } });
    const proto = decodeBody({ contentType: "application/x-protobuf", raw: Buffer.from([0x0a]) });
    expect(proto).toMatchObject({ ok: false, status: 415 });
    expect(proto.ok === false && proto.message).toMatch(/exporter-trace-otlp-http/);
    expect(decodeBody({ contentType: "text/plain", raw: Buffer.from(body) })).toMatchObject({ ok: false, status: 415 });
    expect(decodeBody({ contentType: "application/json", raw: Buffer.from("{nope") })).toMatchObject({ ok: false, status: 400 });
    expect(decodeBody({ contentType: "application/json", contentEncoding: "br", raw: Buffer.from(body) })).toMatchObject({ ok: false, status: 415 });
  });

  it("summarizes an export request without printing ids or attributes", () => {
    const [sliceOne, decision] = loadBodies();
    expect(summarizeBody(sliceOne)).toEqual({ services: ["foreman-worker"], spans: 2, outcomes: ["require_approval"], names: ["execute_tool web_search", "invoke_agent"] });
    expect(summarizeBody(decision)).toEqual({ services: ["foreman-web"], spans: 1, outcomes: ["allow"], names: ["tool_call_decision"] });
    expect(summarizeBody({})).toEqual({ services: [], spans: 0, outcomes: [], names: [] });
  });
});
