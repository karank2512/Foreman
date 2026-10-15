#!/usr/bin/env node
/**
 * Checks a capture written by scripts/otel-receiver.mjs for the web → worker approval chain described in
 * docs/OTEL.md ("Web to worker through a real OTLP receiver"): for every tool call a reviewer decided on,
 *
 *   - `require_approval` was recorded by the worker service,
 *   - the reviewer's `allow` / `deny` was recorded by the web service, in a different trace,
 *   - both carry the same gen_ai.tool.call.id and gen_ai.agent.execution.id,
 *   - an approved call has exactly one `execute_tool` span with that id and a denied one has none,
 *   - the worker resumed the run from that pause,
 *
 * and, over the whole capture, that there is at least one approved and one denied call, that every attribute
 * key is in the telemetry allowlist, and that every span comes from Foreman's instrumentation scope.
 *
 *   node scripts/otel-check.mjs [capture.ndjson] [--worker-service foreman-worker] [--web-service foreman-web]
 *
 * The capture path defaults to OTEL_RECEIVER_OUT. Prints a pass/fail table and exits 1 on any failure.
 * The pure parts (`parseCapture`, `flattenSpans`, `checkReceipt`) are unit-tested on a fixture in
 * tests/telemetry/otel-check.test.ts; the allowlist below is pinned to the one in src/server/telemetry/types.ts
 * by the same test.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Mirror of ALLOWED_ATTRIBUTE_KEYS in src/server/telemetry/types.ts (a script cannot import the TypeScript). */
export const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "gen_ai.operation.name",
  "gen_ai.agent.id",
  "gen_ai.tool.name",
  "gen_ai.tool.call.id",
  "gen_ai.tool.type",
  "gen_ai.tool.call.decision.outcome",
  "gen_ai.agent.execution.id",
  "gen_ai.agent.pause.id",
  "gen_ai.agent.checkpoint.id",
  "gen_ai.agent.resumed_from.type",
  "gen_ai.agent.resumed_from.id",
  "error.type",
  "foreman.organization.id",
  "foreman.run.attempt",
  "foreman.run.simulated",
  "foreman.run.status",
  "foreman.approval.id",
  "foreman.decision.source",
  "foreman.decision.actor.role",
  "foreman.decision.reason",
  "foreman.pause.reason",
  "foreman.pause.approval_count",
]);

export const DEFAULTS = Object.freeze({ workerService: "foreman-worker", webService: "foreman-web", scope: "foreman.runtime" });

const DECISION_EVENT = "gen_ai.tool.call.decision";
const RESUMED_EVENT = "gen_ai.agent.resumed";
const EXECUTE_TOOL_PREFIX = "execute_tool ";
const A = {
  toolCallId: "gen_ai.tool.call.id",
  executionId: "gen_ai.agent.execution.id",
  outcome: "gen_ai.tool.call.decision.outcome",
  source: "foreman.decision.source",
  approvalId: "foreman.approval.id",
  resumedFromType: "gen_ai.agent.resumed_from.type",
  resumedFromId: "gen_ai.agent.resumed_from.id",
};

// ── Capture parsing ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * One JSON object per non-empty line: either the receiver's envelope `{ receivedAt, body }` or a bare OTLP
 * ExportTraceServiceRequest. Returns the request bodies.
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseCapture(text) {
  const bodies = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (e) {
      throw new Error(`line ${i + 1} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    bodies.push(value && typeof value === "object" && "body" in value && !("resourceSpans" in value) ? value.body : value);
  }
  return bodies;
}

/** OTLP AnyValue → plain JS value. */
function fromAnyValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return v.boolValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("bytesValue" in v) return v.bytesValue;
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(fromAnyValue);
  if ("kvlistValue" in v) return fromKeyValues(v.kvlistValue?.values ?? []);
  return null;
}

/** OTLP `[{ key, value }]` → object. */
function fromKeyValues(list) {
  const out = {};
  for (const kv of Array.isArray(list) ? list : []) if (kv && typeof kv.key === "string") out[kv.key] = fromAnyValue(kv.value);
  return out;
}

/**
 * Trace and span ids as lowercase hex. The JS exporter sends hex; a collector or another SDK may re-encode them
 * as base64 (the proto3 JSON mapping for bytes), so both are accepted.
 * @param {unknown} id
 * @returns {string}
 */
export function normalizeId(id) {
  if (typeof id !== "string") return "";
  const s = id.trim();
  if (s === "") return "";
  if (/^[0-9a-fA-F]+$/.test(s) && (s.length === 32 || s.length === 16)) return s.toLowerCase();
  if (/^[A-Za-z0-9+/]+=*$/.test(s)) {
    const hex = Buffer.from(s, "base64").toString("hex");
    if (hex.length === 32 || hex.length === 16) return hex;
  }
  return s;
}

/** @typedef {{ name: string; attributes: Record<string, unknown> }} FlatEvent */
/** @typedef {{ traceId: string; spanId: string; parentSpanId: string; name: string; service: string; scope: string; attributes: Record<string, unknown>; events: FlatEvent[] }} FlatSpan */

/**
 * Every span in every request body, with its resource's service.name and its scope name attached.
 * @param {unknown[]} bodies
 * @returns {FlatSpan[]}
 */
export function flattenSpans(bodies) {
  const spans = [];
  for (const body of bodies) {
    const resourceSpans = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];
    for (const rs of resourceSpans) {
      const resource = fromKeyValues(rs?.resource?.attributes);
      const service = typeof resource["service.name"] === "string" ? resource["service.name"] : "";
      for (const ss of rs?.scopeSpans ?? []) {
        const scope = typeof ss?.scope?.name === "string" ? ss.scope.name : "";
        for (const span of ss?.spans ?? []) {
          spans.push({
            traceId: normalizeId(span?.traceId),
            spanId: normalizeId(span?.spanId),
            parentSpanId: normalizeId(span?.parentSpanId),
            name: typeof span?.name === "string" ? span.name : "",
            service,
            scope,
            attributes: fromKeyValues(span?.attributes),
            events: (Array.isArray(span?.events) ? span.events : []).map((e) => ({
              name: typeof e?.name === "string" ? e.name : "",
              attributes: fromKeyValues(e?.attributes),
            })),
          });
        }
      }
    }
  }
  return spans;
}

// ── Checks ───────────────────────────────────────────────────────────────────────────────────────────────────

/** @typedef {{ chain: string; check: string; ok: boolean; detail: string }} Row */
/** @typedef {{ callId: string; verdict: "allow" | "deny"; executionId: string; approvalId: string }} Chain */

const short = (id) => (id.length > 12 ? `…${id.slice(-8)}` : id);

/** Every (span, event) pair for one event name. */
function eventsNamed(spans, name) {
  const found = [];
  for (const span of spans) for (const event of span.events) if (event.name === name) found.push({ span, event });
  return found;
}

/**
 * Run every check over the flattened spans.
 * @param {FlatSpan[]} spans
 * @param {{ workerService?: string; webService?: string; scope?: string }} [opts]
 * @returns {{ ok: boolean; rows: Row[]; chains: Chain[]; ignoredCallIds: string[] }}
 */
export function checkReceipt(spans, opts = {}) {
  const workerService = opts.workerService ?? DEFAULTS.workerService;
  const webService = opts.webService ?? DEFAULTS.webService;
  const scope = opts.scope ?? DEFAULTS.scope;
  /** @type {Row[]} */
  const rows = [];
  const row = (chain, check, ok, detail) => rows.push({ chain, check, ok, detail });

  // Group decision events by tool call; only calls a reviewer decided on are chains the receipt is about.
  const byCall = new Map();
  for (const { span, event } of eventsNamed(spans, DECISION_EVENT)) {
    const callId = String(event.attributes[A.toolCallId] ?? "");
    if (!byCall.has(callId)) byCall.set(callId, []);
    byCall.get(callId).push({ span, event });
  }
  /** @type {Chain[]} */
  const chains = [];
  const ignoredCallIds = [];
  for (const [callId, decisions] of byCall) {
    const reviewer = decisions.filter((d) => d.event.attributes[A.source] === "reviewer");
    const verdicts = new Set(reviewer.map((d) => String(d.event.attributes[A.outcome])));
    if (reviewer.length === 0 || callId === "") {
      ignoredCallIds.push(callId);
      continue;
    }
    const verdict = verdicts.has("allow") ? "allow" : verdicts.has("deny") ? "deny" : null;
    if (verdict === null || verdicts.size !== 1) {
      row(callId, "one reviewer verdict (allow or deny)", false, `found: ${[...verdicts].join(", ") || "none"}`);
      continue;
    }
    const required = decisions.filter((d) => d.event.attributes[A.outcome] === "require_approval");
    const executionId = String(required[0]?.event.attributes[A.executionId] ?? reviewer[0].event.attributes[A.executionId] ?? "");
    const approvalId = String(required[0]?.event.attributes[A.approvalId] ?? reviewer[0].event.attributes[A.approvalId] ?? "");
    chains.push({ callId, verdict, executionId, approvalId });
    // The full call id, so a row can be matched against the capture and the Approvals page.
    const label = `${verdict === "allow" ? "approve" : "deny"} ${callId}`;

    // 1. The gate fired in the worker.
    const gate = required[0];
    row(
      label,
      "require_approval recorded in the worker service",
      required.length === 1 && gate.span.service === workerService,
      required.length === 1
        ? `span ${gate.span.name} · service ${gate.span.service || "(none)"} · trace ${short(gate.span.traceId)}`
        : `${required.length} require_approval events`,
    );

    // 2. The reviewer decided in the web process.
    const decided = reviewer[0];
    row(
      label,
      `${verdict} recorded in the web service`,
      reviewer.length === 1 && decided.span.service === webService,
      reviewer.length === 1
        ? `span ${decided.span.name} · service ${decided.span.service || "(none)"} · trace ${short(decided.span.traceId)}`
        : `${reviewer.length} reviewer decisions`,
    );

    // 3. Two processes, two traces: nothing propagates context between them, the ids are the correlation.
    const gateTrace = gate?.span.traceId ?? "";
    row(
      label,
      "decision trace differs from the run's trace",
      gateTrace !== "" && decided.span.traceId !== "" && gateTrace !== decided.span.traceId,
      `${short(gateTrace)} vs ${short(decided.span.traceId)}`,
    );

    // 4 + 5. The same tool call and the same execution on both sides.
    const sameCall = gate !== undefined && gate.event.attributes[A.toolCallId] === callId && decided.event.attributes[A.toolCallId] === callId;
    row(label, "same gen_ai.tool.call.id on both events", sameCall, callId);
    const sameExecution = executionId !== "" && gate !== undefined && gate.event.attributes[A.executionId] === executionId && decided.event.attributes[A.executionId] === executionId;
    row(label, "same gen_ai.agent.execution.id on both events", sameExecution, executionId || "(missing)");

    // 6. Execution follows the verdict: once for allow, never for deny.
    const executions = spans.filter((s) => s.name.startsWith(EXECUTE_TOOL_PREFIX) && s.attributes[A.toolCallId] === callId);
    if (verdict === "allow") {
      const only = executions[0];
      row(
        label,
        "exactly one execute_tool span with this call id",
        executions.length === 1 && only.service === workerService && only.attributes[A.executionId] === executionId,
        executions.length === 1 ? `${only.name} · service ${only.service || "(none)"} · trace ${short(only.traceId)}` : `${executions.length} execute_tool spans`,
      );
    } else {
      row(label, "no execute_tool span with this call id", executions.length === 0, executions.length === 0 ? "none" : executions.map((s) => s.name).join(", "));
    }

    // 7. The worker picked the run back up from this pause.
    const resumed = eventsNamed(spans, RESUMED_EVENT).filter(
      ({ span, event }) => span.service === workerService && event.attributes[A.executionId] === executionId && event.attributes[A.resumedFromType] === "pause" && event.attributes[A.resumedFromId] === approvalId,
    );
    row(
      label,
      "worker resumed the run from this pause",
      resumed.length >= 1,
      resumed.length >= 1 ? `${resumed.length} gen_ai.agent.resumed · span ${resumed[0].span.name} · trace ${short(resumed[0].span.traceId)}` : `no gen_ai.agent.resumed with resumed_from.id ${approvalId || "(missing)"}`,
    );
  }

  // Whole-capture checks.
  const approves = chains.filter((c) => c.verdict === "allow").length;
  const denies = chains.filter((c) => c.verdict === "deny").length;
  row("capture", "at least one approved and one denied call", approves >= 1 && denies >= 1, `${approves} approved, ${denies} denied, ${ignoredCallIds.length} without a reviewer decision (ignored)`);

  const services = new Set(spans.map((s) => s.service));
  row("capture", "spans from both services", services.has(workerService) && services.has(webService), [...services].map((s) => s || "(none)").join(", ") || "no spans");

  const foreignKeys = new Map();
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) foreignKeys.set(key, (foreignKeys.get(key) ?? 0) + 1);
    for (const event of span.events) for (const key of Object.keys(event.attributes)) if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) foreignKeys.set(key, (foreignKeys.get(key) ?? 0) + 1);
  }
  row(
    "capture",
    "every attribute key is in ALLOWED_ATTRIBUTE_KEYS",
    foreignKeys.size === 0,
    foreignKeys.size === 0 ? `${spans.length} spans checked` : [...foreignKeys].slice(0, 10).map(([k, n]) => `${k} ×${n}`).join(", "),
  );

  const foreignScopes = new Map();
  for (const span of spans) if (span.scope !== scope) foreignScopes.set(span.scope, (foreignScopes.get(span.scope) ?? 0) + 1);
  row(
    "capture",
    `every span is from scope ${scope}`,
    spans.length > 0 && foreignScopes.size === 0,
    spans.length === 0 ? "no spans" : foreignScopes.size === 0 ? `${spans.length} spans` : [...foreignScopes].map(([s, n]) => `${s || "(none)"} ×${n}`).join(", "),
  );

  return { ok: rows.every((r) => r.ok), rows, chains, ignoredCallIds };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {Row[]} rows
 * @returns {string}
 */
export function formatTable(rows) {
  const header = { result: "RESULT", chain: "CHAIN", check: "CHECK", detail: "DETAIL" };
  const cells = rows.map((r) => ({ result: r.ok ? "PASS" : "FAIL", chain: r.chain, check: r.check, detail: r.detail }));
  const width = (key) => Math.max(header[key].length, ...cells.map((c) => c[key].length));
  const w = { result: width("result"), chain: width("chain"), check: width("check") };
  const line = (c) => `${c.result.padEnd(w.result)}  ${c.chain.padEnd(w.chain)}  ${c.check.padEnd(w.check)}  ${c.detail}`;
  const rule = "-".repeat(w.result + w.chain + w.check + 6 + Math.min(40, width("detail")));
  return [line(header), rule, ...cells.map(line)].join("\n");
}

function parseArgs(argv) {
  const opts = { file: process.env.OTEL_RECEIVER_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--worker-service") opts.workerService = argv[++i];
    else if (arg === "--web-service") opts.webService = argv[++i];
    else if (arg === "--scope") opts.scope = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else opts.file = arg;
  }
  if (!opts.file) throw new Error("usage: node scripts/otel-check.mjs <capture.ndjson> (or set OTEL_RECEIVER_OUT)");
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const file = resolve(opts.file);
  let bodies;
  try {
    bodies = parseCapture(readFileSync(file, "utf8"));
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const spans = flattenSpans(bodies);
  const result = checkReceipt(spans, opts);
  const failed = result.rows.filter((r) => !r.ok).length;
  process.stdout.write(`${file}: ${bodies.length} export request(s), ${spans.length} span(s)\n\n${formatTable(result.rows)}\n\n`);
  process.stdout.write(`${result.rows.length - failed} passed, ${failed} failed · ${result.chains.length} reviewer-decided call(s)\n`);
  process.exit(result.ok ? 0 : 1);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
