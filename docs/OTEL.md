# OpenTelemetry export of the approval lifecycle

Foreman can export the human-in-the-loop part of a run as OpenTelemetry traces: a tool call being referred to a
reviewer, the run pausing and checkpointing, the reviewer's decision, the run resuming and the tool finally
running (or not). It is **opt-in** (`OTEL_ENABLED=true`), exported by the **worker** (the run) and by the **web
process** (the reviewer's decision), and emits **ids, tool names, outcomes and roles — never prompts, tool inputs
or outputs, deliverables, names, emails or notes**.

The event and attribute names follow two proposals to the GenAI semantic conventions so the traces can be shown
upstream as a real implementation:

| Proposal | What Foreman emits |
|---|---|
| [open-telemetry/semantic-conventions-genai#535](https://github.com/open-telemetry/semantic-conventions-genai/pull/535) | span event `gen_ai.tool.call.decision` with `gen_ai.tool.call.decision.outcome` ∈ `require_approval` \| `allow` \| `deny` \| `expired`, plus `gen_ai.tool.call.id` / `gen_ai.tool.name` |
| [open-telemetry/semantic-conventions-genai#445](https://github.com/open-telemetry/semantic-conventions-genai/pull/445) | span events `gen_ai.agent.paused`, `gen_ai.agent.checkpointed`, `gen_ai.agent.resumed` with `gen_ai.agent.execution.id`, `gen_ai.agent.pause.id`, `gen_ai.agent.checkpoint.id`, `gen_ai.agent.resumed_from.type` / `gen_ai.agent.resumed_from.id` |

> **Provenance note.** The environment this was built in could not reach GitHub (`gh` and network tools were
> blocked), so the names above were taken from the task brief that quotes the two PRs, not re-read from the PR
> text. Before citing this implementation upstream, diff `src/server/telemetry/types.ts` against the PRs' current
> `model/` YAML and adjust any name that moved. Everything Foreman had to decide for itself is listed under
> [Foreman-specific choices](#foreman-specific-choices).

Code: `src/server/telemetry/` (contract in `types.ts`), hooks in `src/server/runtime/`, boot in `src/worker.ts`
(worker) and `src/instrumentation.ts` (web). Tests: `tests/telemetry/`. Receipt tooling: `scripts/otel-receiver.mjs`
and `scripts/otel-check.mjs` (see [Web to worker through a real OTLP receiver](#web-to-worker-through-a-real-otlp-receiver)).

## What is emitted

One trace per **slice** of a run — the stretch of work between a claim and a pause, finish or interruption. A run
that pauses for approval therefore produces two slices in two traces, correlated by `gen_ai.agent.execution.id`
(the Run id), which is exactly the cross-trace situation PR #445's events are for.

```
invoke_agent                                   span · one per executeRun slice
  gen_ai.operation.name = invoke_agent
  gen_ai.agent.id = <Worker id>                gen_ai.agent.execution.id = <Run id>
  foreman.organization.id · foreman.run.attempt · foreman.run.simulated · foreman.run.status (set at the end)
  ├─ gen_ai.agent.resumed                      event · first thing on a slice that continues an earlier one
  │     gen_ai.agent.resumed_from.type = pause | checkpoint · gen_ai.agent.resumed_from.id
  ├─ execute_tool <tool>                       child span · only for a tool that actually ran
  │     gen_ai.operation.name = execute_tool · gen_ai.tool.name · gen_ai.tool.call.id · gen_ai.tool.type = function
  │     status ERROR + error.type = tool_error when the tool failed
  ├─ gen_ai.tool.call.decision                 event · outcome = require_approval (gate) or deny (platform policy)
  ├─ gen_ai.agent.checkpointed                 event · every persisted restore point
  └─ gen_ai.agent.paused                       event · the run stopped for a human
        gen_ai.agent.pause.id · foreman.pause.reason = approval · foreman.pause.approval_count

tool_call_decision                             span · a decision made while no slice of the run is executing here
  gen_ai.agent.execution.id · gen_ai.tool.name · gen_ai.tool.call.id
  └─ gen_ai.tool.call.decision                 event · outcome = allow | deny (reviewer) or expired (system)
        foreman.approval.id · foreman.decision.source = reviewer | policy | system
        foreman.decision.actor.role = MEMBER | ADMIN | OWNER (reviewer only) · foreman.decision.reason
```

Where each piece comes from (the "map" of the implementation):

| Moment | Code | Telemetry |
|---|---|---|
| Slice starts (claim, resume after approval, crash recovery, retry) | `runtime/run.ts` → `telemetry.beginRunSlice` | `invoke_agent` span; `gen_ai.agent.resumed` when the stored checkpoint is not empty |
| Checkpoint saved (after each tool batch, each component, before a retry) | `runtime/slice.ts saveCheckpoint`, `runtime/finish.ts` | `gen_ai.agent.checkpointed` |
| Gated tool call → run pauses | `runtime/pause.ts pauseForApproval` | per request `gen_ai.tool.call.decision` = `require_approval`, then `gen_ai.agent.checkpointed`, then `gen_ai.agent.paused` |
| Reviewer approves / rejects (in the web process) | `runtime/approvals.ts decideApproval` | `gen_ai.tool.call.decision` = `allow` / `deny`, `foreman.decision.source = reviewer`, actor as a role |
| Reviewer decides a request whose run already moved on | `runtime/approvals.ts` (stale branch) | `gen_ai.tool.call.decision` = `expired`, `foreman.decision.reason = stale_decision` |
| Run cancelled, failed, retired or recovered while waiting | `runtime/transitions.ts closeOpenWork` | `gen_ai.tool.call.decision` = `expired`, `foreman.decision.reason = run_ended` |
| Platform refuses a call (grant revoked, call limit) | `runtime/tool-calls.ts` after `tools.invoke` | `gen_ai.tool.call.decision` = `deny`, `foreman.decision.source = policy`, reason code |
| A tool actually runs | `runtime/tool-calls.ts` after `tools.invoke` | `execute_tool <tool>` span with the same `gen_ai.tool.call.id` as the decision events |
| Slice ends | `runtime/run.ts` | `foreman.run.status`, span end |

Guarantees the tests pin down:

- A **denied** call (reviewer or policy) never produces an `execute_tool` span.
- An **approved** call produces exactly one `execute_tool` span, whose `gen_ai.tool.call.id` equals the id on
  its `require_approval` and `allow` events.
- A gated call that is still waiting produces no `execute_tool` span (the span is created after `tools.invoke`
  returns, with the real start and end time, only for `ok` / `error` outcomes).
- With `OTEL_ENABLED` unset or false: no SDK is loaded, no provider is registered, no span exists, and the run
  behaves identically. In the web process the telemetry module is not even imported
  (`tests/telemetry/web-instrumentation.test.ts`).
- Every attribute key is in `ALLOWED_ATTRIBUTE_KEYS`; string values are clipped to 200 characters; a sweep over all
  exported attributes finds no user email or name, no approval note or title, no tool payload, no job or persona
  name.
- Only spans from Foreman's instrumentation scope (`foreman.runtime`) reach the exporter. Anything else that
  reports to the process-wide provider — in the web process, Next.js's own request and render spans, which carry
  URLs and status codes — is dropped before export, so the allowlist holds for the whole process.

## Foreman-specific choices

These are the readings Foreman had to pick where the proposals leave room, or where Foreman has no native concept.
Each is a candidate for upstream discussion.

1. **`gen_ai.agent.execution.id` is the Run id.** A Foreman run is one agent execution that may span several
   processes and hours of human waiting; every slice of it is a separate `invoke_agent` span carrying the same id.
2. **`gen_ai.agent.checkpoint.id` is synthetic: `<runId>:<attempt>:<stepIndex>`.** Foreman keeps a single mutable
   `Run.checkpoint` column, not a checkpoint table. The id names the run, the attempt that wrote the checkpoint and
   the step index the run had reached (`checkpoint.nextStepIndex`, monotonic across attempts). A resuming slice
   recomputes the same id from the stored checkpoint, recovering the writing attempt from the step rows that
   precede it, so `resumed_from.id` matches an earlier `checkpointed` event exactly. Helper: `checkpointId()`.
3. **`gen_ai.agent.pause.id` is the Approval id of the first gated call in the batch.** One pause can refer several
   calls to a human (one Approval row each); the first one's id stands for the pause, and the resuming slice finds
   it again through its first pending call. Each gated call still gets its own `gen_ai.tool.call.decision` with
   `foreman.approval.id`.
4. **`gen_ai.tool.call.id` is Foreman's ToolCall row id**, not the model-issued call id. It is the id the Approval
   row points at, so it is the one that ties the decision chain to the execution. The model-issued id is not
   exported.
5. **`gen_ai.agent.resumed` is emitted by the slice that resumes**, not when the run is re-queued. Crash recovery
   (`recoverStaleRuns`) and automatic retry only re-queue; the resumed event appears on the next `invoke_agent`
   span with `resumed_from.type = checkpoint`. A resume after a human decision has `resumed_from.type = pause`.
6. **Decision events are emitted only when a policy intervenes**: a gate (`require_approval`), a reviewer's
   `allow` / `deny`, an `expired` request, or a platform `deny`. Ungated calls that simply run do not get an
   implicit `allow` event; the `execute_tool` span is the record that they ran.
7. **Events need a span.** While a slice is executing, events land on its `invoke_agent` span. A reviewer's
   decision or a cancel happens in another request with no active span, so it gets a short `tool_call_decision`
   span carrying the execution id for correlation. (The PRs do not say where the events live; this reading keeps
   the agent span honest about when the agent was actually running.)
8. **`expired` has two reasons**, `foreman.decision.reason = run_ended` (cancel, failure, retirement, recovery of a
   waiting run) and `stale_decision` (a reviewer acted after the run moved on).
9. **The actor is a role** (`foreman.decision.actor.role`), never a user id, name or email.
10. **Two producers, no context propagation.** `initTelemetry()` runs in `src/worker.ts` (service
    `foreman-worker`) and in `src/instrumentation.ts` for the web process (service `foreman-web`), where
    reviewers decide. A reviewer's `allow` / `deny` is therefore exported by the web process on its own
    `tool_call_decision` span, in a trace of its own; the worker's `require_approval`, `paused`, `resumed` and
    `execute_tool` are in the worker's traces. Nothing carries a trace context between the two processes (the
    hand-over is a database row, not a request), so the only link is the ids: `gen_ai.agent.execution.id` and
    `gen_ai.tool.call.id` are the same on both sides. That is the reading of PR #445's "correlate across
    traces"; it is not a claim that a backend will join the two producers into one trace. The test suite runs
    everything in one process and shows the same chain under one service name; the receiver run below shows it
    across the two real processes.

## Running it against a local collector

1. Start something that accepts OTLP/HTTP on port 4318, e.g. Jaeger v2 (UI on http://localhost:16686):
   ```bash
   docker run --rm --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.5.0
   ```
   or the Collector with the debug exporter, which prints every span to its stdout.
2. In `.env`: `OTEL_ENABLED=true` (the defaults already point at `http://localhost:4318`; set
   `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` for anything else, and
   `OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer …"` for a hosted collector). `OTEL_SERVICE_NAME` renames
   the service; leave it unset to keep the defaults `foreman-worker` and `foreman-web`, which is what lets a
   collector tell the two processes apart.
3. `npm run dev` (web + worker). The worker logs `telemetry.enabled` and `worker.started { telemetry: true }`;
   the web server logs `boot.telemetry_enabled { serviceName: "foreman-web" }`.
4. Sign in to the demo workspace (`DEMO_MODE=true`). Maya holds a pending approval: approve it under
   **Approvals**, or start a run of a worker with a notifier. In Jaeger, service `foreman-worker`, you will see the
   `invoke_agent` slice that paused (with `require_approval`, `checkpointed`, `paused`), and the slice that resumed
   (with `resumed` and the single `execute_tool send_notification`); under service `foreman-web`, the
   `tool_call_decision` span with your `allow`. Everything in the demo is Simulated.

Nothing leaves the machine unless you point the endpoint elsewhere. Turning the flag off returns both processes to
exactly their previous behaviour; the OpenTelemetry packages are not even loaded.

## Web to worker through a real OTLP receiver

The test suite proves the chain inside one process. This run proves it across the two real processes and a real
OTLP/HTTP receiver: a reviewer's decision made in the **web** process and the worker's resume, captured as
separate traces that share `gen_ai.tool.call.id` and `gen_ai.agent.execution.id`, with one approve and one deny.
Everything below is **Simulated mode** (no provider keys): the model is the mock and the tools are simulated, so
nothing is spent and nothing leaves the machine.

`scripts/otel-receiver.mjs` is a dependency-free Node server that accepts what Foreman's exporter sends
(`POST /v1/traces`, OTLP JSON, optionally gzipped) and appends every export request to a capture file, one JSON
line each (`{ receivedAt, contentType, body }`). `scripts/otel-check.mjs` reads the capture and checks the chain.

1. Start the receiver in one terminal:
   ```bash
   OTEL_RECEIVER_OUT="$TMPDIR/foreman-otel/receipt.ndjson" node scripts/otel-receiver.mjs
   ```
   It listens on `127.0.0.1:4318` (`OTEL_RECEIVER_PORT` / `OTEL_RECEIVER_HOST` to change) and prints one line per
   export request: which service it came from, how many spans, and which decision outcomes were among them.
2. Start web + worker with telemetry on, pointed at it (the defaults already are), in Simulated mode:
   ```bash
   OTEL_ENABLED=true DEMO_MODE=true FORCE_SIMULATED=true npm run dev
   ```
   Look for `telemetry.enabled` from the worker and `boot.telemetry_enabled` from the web server. Leave
   `OTEL_SERVICE_NAME` unset.
3. In the UI, produce one approved and one denied call. Each needs a run that pauses for a reviewer: the demo
   workspace's **Maya** holds a pending approval already, and any worker with a notifier produces one per run
   (**Workforce → the worker → Run now**, or the run page). Under **Approvals**, **approve** one request and
   **reject** another. The receiver shows the web decision land (`foreman-web … decisions: allow`), then the
   worker's resumed slice (`foreman-worker … invoke_agent, execute_tool send_notification` for the approved run;
   no `execute_tool send_notification` for the rejected one).
4. Check the capture:
   ```bash
   node scripts/otel-check.mjs "$TMPDIR/foreman-otel/receipt.ndjson"
   ```
   For every call a reviewer decided on it prints a PASS/FAIL row per assertion and exits non-zero on any
   failure:

   | Check | What it asserts |
   |---|---|
   | require_approval recorded in the worker service | the gate fired on a span whose resource is `foreman-worker` |
   | allow / deny recorded in the web service | the reviewer's decision is on a span whose resource is `foreman-web` |
   | decision trace differs from the run's trace | different `traceId`s: two processes, no context propagation |
   | same `gen_ai.tool.call.id` / `gen_ai.agent.execution.id` on both events | the correlation ids match |
   | exactly one / no `execute_tool` span with this call id | approved runs once; denied never runs |
   | worker resumed the run from this pause | a `foreman-worker` span carries `gen_ai.agent.resumed` with `resumed_from.id` = the pause id |
   | at least one approved and one denied call | both controls are in the capture |
   | every attribute key is in `ALLOWED_ATTRIBUTE_KEYS` | over every span and event the receiver saw |
   | every span is from scope `foreman.runtime` | nothing but Foreman's own instrumentation was exported |

   Calls with no reviewer decision yet are listed and ignored. `--worker-service` / `--web-service` override the
   expected service names if you set `OTEL_SERVICE_NAME`.
5. Keep the capture and the checker's output together as the receipt. The capture contains only what the
   allowlist permits (ids, tool names, outcomes, the reviewer's role), so it can be shared as is.

The checker's logic is unit-tested on a small hand-written capture in `tests/telemetry/fixtures/` by
`tests/telemetry/otel-check.test.ts`, including the failure cases (an approved call that never ran, a denied
one that did, a decision in the wrong service or the same trace, a foreign attribute key, a foreign scope).

What this run does and does not show: it shows that the two processes export the events the proposals describe
with matching ids, through a real OTLP/HTTP receiver, in Simulated mode. It does not show production use, and it
does not show a backend joining the two producers' traces into one — there is no shared context, only shared ids.

### Configuration

All four variables are validated at boot by `src/server/env.ts`. This is the block for section 9 of
`.env.example` ("Observability and development"):

```dotenv
# OpenTelemetry (opt-in; docs/OTEL.md). When enabled, the worker exports one trace per run slice and the web server
# exports each reviewer decision, with the approval lifecycle events proposed in
# open-telemetry/semantic-conventions-genai #535 and #445, over OTLP/HTTP (JSON). While it is false nothing is
# loaded and nothing is sent. Traces never contain prompts, tool inputs/outputs, deliverables, names, emails or
# notes — only opaque ids, tool names, outcomes and the reviewer's role.
# OTEL_ENABLED=false
# OTEL_SERVICE_NAME=                                   # resource service.name for BOTH processes; unset keeps foreman-worker / foreman-web
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318    # collector base URL; the exporter appends /v1/traces [http://localhost:4318]
# OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=                  # full traces URL; wins over the base URL when set
# OTEL_EXPORTER_OTLP_HEADERS=                          # "key=value,key2=value2" for a hosted collector; read by the exporter
```

### Dependencies

`@opentelemetry/api` (no-op shim, imported by the runtime hooks), `@opentelemetry/sdk-trace-base`,
`@opentelemetry/resources` (for `service.name`) and `@opentelemetry/exporter-trace-otlp-http`, loaded dynamically
when enabled. The exporter speaks OTLP/HTTP with the JSON encoding (`Content-Type: application/json`, hex ids);
the protobuf encoding is a different package and is not used. The experimental exporter pins the exact SDK
version it was released with, so bump `sdk-trace-base`, `resources` and the exporter together. The worker uses
a batch processor (flushed on SIGTERM); the web server uses a simple one, sending each decision span as it ends,
because Next.js offers no shutdown hook to flush a batch from and a decision is the only thing the web emits.

## Evidence for upstream

All traces below are from **Simulated mode** (no provider keys; the mock model and simulated tools). They are the
spans the tests in `tests/telemetry/approval-telemetry.test.ts` assert on. Regenerate them as JSON files with

```bash
OTEL_EVIDENCE_DIR=docs/otel-evidence npx vitest run tests/telemetry
```

which writes `docs/otel-evidence/approve-path.json` and `deny-path.json` (format: `tests/telemetry/helpers.ts
toEvidence`).

> **Status:** the captured traces are in `docs/otel-evidence/approve-path.json` and `deny-path.json`, written by
> the test suite (Simulated mode, in-memory exporter) and committed as produced. The inline JSON below is an
> abbreviated, hand-edited excerpt with placeholder ids (`run_01`, `tc_19`, ...) and repeated collector spans
> elided with `...`; treat the files, not the excerpts, as the evidence.

### Approve path (Simulated mode)

Slice 1 pauses; the reviewer (an OWNER) approves; slice 2 resumes and the send runs once.

```json
{
  "mode": "Simulated",
  "spans": [
    { "name": "execute_tool web_search", "traceId": "T1", "spanId": "S1a", "parentSpanId": "S1", "status": "UNSET",
      "attributes": { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "web_search", "gen_ai.tool.call.id": "tc_01", "gen_ai.tool.type": "function", "gen_ai.agent.execution.id": "run_01", "foreman.run.simulated": true },
      "events": [] },
    "… more execute_tool fetch_url / extract_data spans of the collector, all children of S1 …",
    { "name": "invoke_agent", "traceId": "T1", "spanId": "S1", "parentSpanId": null, "status": "UNSET",
      "attributes": { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.id": "wrk_01", "gen_ai.agent.execution.id": "run_01", "foreman.organization.id": "org_01", "foreman.run.attempt": 1, "foreman.run.simulated": true, "foreman.run.status": "WAITING_FOR_APPROVAL" },
      "events": [
        { "name": "gen_ai.agent.checkpointed", "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.agent.checkpoint.id": "run_01:1:4" } },
        "… one gen_ai.agent.checkpointed per tool batch and component boundary …",
        { "name": "gen_ai.tool.call.decision", "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.tool.name": "send_notification", "gen_ai.tool.call.id": "tc_09", "gen_ai.tool.call.decision.outcome": "require_approval", "foreman.approval.id": "apr_01", "foreman.decision.source": "policy" } },
        { "name": "gen_ai.agent.checkpointed", "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.agent.checkpoint.id": "run_01:1:17" } },
        { "name": "gen_ai.agent.paused", "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.agent.pause.id": "apr_01", "foreman.pause.reason": "approval", "foreman.pause.approval_count": 1 } }
      ] },
    { "name": "tool_call_decision", "traceId": "T2", "spanId": "S2", "parentSpanId": null, "status": "UNSET",
      "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.tool.name": "send_notification", "gen_ai.tool.call.id": "tc_09" },
      "events": [
        { "name": "gen_ai.tool.call.decision", "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.tool.name": "send_notification", "gen_ai.tool.call.id": "tc_09", "gen_ai.tool.call.decision.outcome": "allow", "foreman.approval.id": "apr_01", "foreman.decision.source": "reviewer", "foreman.decision.actor.role": "OWNER" } }
      ] },
    { "name": "execute_tool send_notification", "traceId": "T3", "spanId": "S3a", "parentSpanId": "S3", "status": "UNSET",
      "attributes": { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "send_notification", "gen_ai.tool.call.id": "tc_09", "gen_ai.tool.type": "function", "gen_ai.agent.execution.id": "run_01", "foreman.run.simulated": true },
      "events": [] },
    { "name": "invoke_agent", "traceId": "T3", "spanId": "S3", "parentSpanId": null, "status": "UNSET",
      "attributes": { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.id": "wrk_01", "gen_ai.agent.execution.id": "run_01", "foreman.organization.id": "org_01", "foreman.run.attempt": 1, "foreman.run.simulated": true, "foreman.run.status": "SUCCEEDED" },
      "events": [
        { "name": "gen_ai.agent.resumed", "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.agent.resumed_from.type": "pause", "gen_ai.agent.resumed_from.id": "apr_01" } },
        { "name": "gen_ai.agent.checkpointed", "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.agent.checkpoint.id": "run_01:1:17" } },
        { "name": "gen_ai.agent.checkpointed", "attributes": { "gen_ai.agent.execution.id": "run_01", "gen_ai.agent.checkpoint.id": "run_01:1:19" } }
      ] }
  ]
}
```

Invariants visible above: `tc_09` appears on the `require_approval` event, the `allow` event and exactly one
`execute_tool` span; `apr_01` is both the pause id and the `resumed_from.id`; `run_01` ties the three traces.

### Deny path (Simulated mode)

Slice 1 is identical to the approve path up to the pause. The reviewer rejects; slice 2 resumes, replays the
denied call from its row and finishes without running it.

```json
{
  "mode": "Simulated",
  "spans": [
    "… collector execute_tool spans and slice 1 `invoke_agent` exactly as in the approve path (require_approval → checkpointed → paused) …",
    { "name": "tool_call_decision", "traceId": "T2", "spanId": "S2", "parentSpanId": null, "status": "UNSET",
      "attributes": { "gen_ai.agent.execution.id": "run_02", "gen_ai.tool.name": "send_notification", "gen_ai.tool.call.id": "tc_19" },
      "events": [
        { "name": "gen_ai.tool.call.decision", "attributes": { "gen_ai.agent.execution.id": "run_02", "gen_ai.tool.name": "send_notification", "gen_ai.tool.call.id": "tc_19", "gen_ai.tool.call.decision.outcome": "deny", "foreman.approval.id": "apr_02", "foreman.decision.source": "reviewer", "foreman.decision.actor.role": "OWNER" } }
      ] },
    { "name": "invoke_agent", "traceId": "T3", "spanId": "S3", "parentSpanId": null, "status": "UNSET",
      "attributes": { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.id": "wrk_01", "gen_ai.agent.execution.id": "run_02", "foreman.organization.id": "org_01", "foreman.run.attempt": 1, "foreman.run.simulated": true, "foreman.run.status": "SUCCEEDED" },
      "events": [
        { "name": "gen_ai.agent.resumed", "attributes": { "gen_ai.agent.execution.id": "run_02", "gen_ai.agent.resumed_from.type": "pause", "gen_ai.agent.resumed_from.id": "apr_02" } },
        { "name": "gen_ai.agent.checkpointed", "attributes": { "gen_ai.agent.execution.id": "run_02", "gen_ai.agent.checkpoint.id": "run_02:1:17" } },
        { "name": "gen_ai.agent.checkpointed", "attributes": { "gen_ai.agent.execution.id": "run_02", "gen_ai.agent.checkpoint.id": "run_02:1:19" } }
      ] }
  ]
}
```

No span in the deny trace carries `gen_ai.tool.call.id = tc_19` other than through the two decision events: the
tool never ran. The expiry and crash-recovery cases (`expired` with `run_ended` / `stale_decision`;
`resumed_from.type = checkpoint` with an id that appeared on the crashed slice's `checkpointed` event) are covered
by the same test file.
