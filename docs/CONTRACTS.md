# Module contracts

> **Contributors:** the FROZEN / `[owner]` labels below record how the original build split the work between modules. They don't restrict you. Treat FROZEN files as shared contracts: change them deliberately, update every caller in the same PR, and follow the rules in [`CLAUDE.md`](../CLAUDE.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).

Monolithic Next.js app with clean module boundaries under `src/server/`. Each module exposes its public API **only** from its `index.ts`. Other modules import from `@/server/<module>` (never deep paths, except `types.ts` / `schemas.ts` files and `@/server/domain`).

**FROZEN** = shared contract that many modules depend on; change it deliberately and update every caller in the same PR.

```
prisma/schema.prisma, prisma/migrations/   data model                                  FROZEN
prisma/seed.ts                             demo data                                   [seed]
src/server/db.ts                           `db`, `toJson()`, DbTx/DbOrTx types          FROZEN
src/server/errors.ts, config.ts            AppError + helpers, env-backed config       FROZEN
src/server/domain/*                        Zod schemas + pure helpers (see below)      FROZEN
src/server/*/types.ts, tools/schemas.ts    typed contracts                             FROZEN
src/server/auth/                           Auth.js config, requireSession, password    [auth]
src/middleware.ts, src/app/page.tsx, src/app/(auth)/**, src/app/api/auth/**            [auth]
src/server/secrets/                        credential vault (AES-256-GCM) + resolve    [platform]
src/server/activity/, src/server/usage/    activity feed, usage ledger                 [platform]
src/server/models/                         LLM registry, tier router, pricing, providers, mock  [models]
src/server/simulation/                     deterministic fixtures + mock agent brain   [simulation]
src/server/tools/                          registry, permission enforcement, MVP tools [tools]
src/server/evaluation/                     checks, LLM judge, feedback, score, reviews [evaluation]
src/server/runtime/, src/instrumentation.ts  queue, executor, agent loop, deterministic steps, approvals, scheduler [runtime]
src/server/staffing/                       scoping, blueprint design, cost estimate, hire [staffing]
src/server/workers/                        versions, lifecycle, permissions, chat, replace [workers]
src/lib/*, src/components/*, src/app/layout.tsx, src/app/globals.css,
  src/app/(app)/{layout,error,not-found,loading}.tsx, src/server/queries/shell.ts     [ui-shell]
src/server/queries/<area>.ts + src/app/(app)/<route>/**                                [page owners — see UI]
next.config.ts                             FROZEN (Prisma is auto-externalized; no change needed)
tests/helpers/*, tests/setup/*, vitest.config.mts                                      FROZEN (put your own helpers in tests/<area>/helpers.ts)
tests/<area>/*.test.ts                     Vitest suites                               [each module owner]
```

## Dependency direction (no cycles)
`domain` ← `models` / `simulation` / `secrets` / `activity` / `usage` ← `tools` ← `evaluation` ← `runtime` ← `staffing` ← `workers` ← `queries` / `app`

- `runtime` calls `evaluation.evaluateRun()` after a successful run. **`runtime` MUST NOT import `@/server/staffing` or `@/server/workers`.** `staffing` may import `runtime` (only `enqueueRun`). `workers` may import anything below it.
- Server modules other than app code never import the auth index — only `import type { SessionContext } from "@/server/auth/types"`. Tests and the seed import `@/server/auth/password` (no next-auth).
- `models` → `usage` is allowed (`recordUsage`). `simulation` imports only `domain`, `models/types`, `tools/schemas`.

## Frozen domain helpers (use these — do not re-implement)
- `domain/job-spec.ts`: `JobSpecSchema`, `JobSpecLlmSchema` (what the LLM produces; code adds `schemaVersion`), `ScopingQuestionsSchema`, `IntakeAnswersSchema`, `renderJobBrief(spec)` (the ONLY renderer of the `job_brief` context value).
- `domain/blueprint.ts`: `WorkerBlueprintSchema` (+ referential `superRefine`), `parseBlueprint`, `safeParseBlueprint`, component schemas, `DETERMINISTIC_CHECK_CONFIG_SCHEMAS`, `KPI_METRICS`, `DEFAULT_RUN_LIMITS`, `DEFAULT_EVALUATION_WEIGHTS`, `AVATAR_COLORS`, `WorkerProposalSchema`. Read the "Pipeline conventions" comment at the top.
- `domain/blueprint-draft.ts`: `BlueprintDraftSchema` — the only thing the staffing LLM emits.
- `domain/schedule.ts`: `computeNextRunAt`, `cadenceToWorkerFields`, `workerFieldsToCadence`, `runsPerMonth`, `describeCadence` (hours are SERVER LOCAL TIME).
- `domain/db-mapping.ts`: `toDbDeliverableFormat` / `fromDbDeliverableFormat`.
- `domain/evaluation.ts`: details schemas, `JudgeOutputSchema`, `ReviewNarrativeSchema`, `ReviewMetrics`, `WorkerScore`, `HEALTH_THRESHOLDS`.
- `domain/replacement.ts`: `ReplacementPlanSchema` (LLM output), `ReplacementAnalysis`, `BlueprintDiff`, `MessageClassificationSchema`.
- `db.ts`: `toJson(value)` for every write into a Prisma `Json` column.

## Database rules
- DATABASE_URL pins the session to UTC (`options=-c TimeZone=UTC`). **Prefer Prisma client queries.** Raw SQL must never rely on the session time zone: compare DateTime columns only against bound JS `Date`s or `(now() AT TIME ZONE 'UTC')`; quote identifiers; cast enums (`'QUEUED'::"RunStatus"`); set `"updatedAt"` yourself.
- Org scoping for models without `organizationId` goes through the parent relation: `db.workerVersion.findFirst({ where: { id, worker: { organizationId } } })`, `db.jobSpec.findFirst({ where: { id, job: { organizationId } } })`, same for `WorkerToolGrant` (worker), `RunStep`/`ToolCall` (run).

## Who writes what (single-writer rules)
| Data | Only writer |
|---|---|
| `Run.costUsd / inputTokens / outputTokens` | `usage.recordUsage` (atomic increment). The runtime never writes these columns. |
| `ModelCall` rows | `models` (inside `llm.generateText/Object`) |
| `UsageRecord` rows | `usage.recordUsage`, called by `models` (MODEL) and `tools.invoke` (TOOL) |
| `RunStep`, `ToolCall`, `Approval`, `Deliverable` rows, `Run.checkpoint/status/durationMs` | `runtime` (tools.invoke only READS Approval). ToolCall status mapping after invoke: ok→SUCCEEDED · error/invalid_input→FAILED · denied/rejected→DENIED · approval_required→PENDING_APPROVAL |
| `RunStep(kind EVALUATION)` | `runtime`, around its `evaluateRun` call. `evaluation` never touches RunStep. |
| `Evaluation`, `WorkerReview`, `Worker.score/health/healthReason` | `evaluation` |
| `Worker.status/schedule/currentVersionId`, `WorkerVersion`, `WorkerToolGrant`, `WorkerMessage` | `workers` (plus `staffing.hireWorker` for the initial rows) |

**Activity rule:** the function that performs the mutation records the event; callers never do. Owners — staffing: JOB_CREATED (scopeJob), JOB_SPEC_APPROVED, WORKER_HIRED · runtime: RUN_*, APPROVAL_*, DELIVERABLE_CREATED, TOOL_USED (only for `sideEffect: "external_write"` tools) · evaluation: EVALUATION_COMPLETED, DELIVERABLE_ACCEPTED/REJECTED, REVIEW_GENERATED · workers: VERSION_PROPOSED (inside `createProposedVersion` only), VERSION_REJECTED, WORKER_REPLACED/PAUSED/RESUMED/RETIRED, PERMISSION_CHANGED, INSTRUCTION_RECEIVED. Metadata keys: see `activity/types.ts`.

---

## auth — `@/server/auth`
```ts
// index.ts (imports next-auth — app code only)
export const { handlers, auth, signIn, signOut }            // Auth.js v5, JWT sessions; token carries userId, organizationId, role
export async function getSession(): Promise<SessionContext | null>     // also verifies the user row still exists (stale cookie after re-seed → null)
export async function requireSession(): Promise<SessionContext>         // redirect("/sign-in") when unauthenticated
// password.ts (NO next-auth import) — re-exported from index
export async function hashPassword(pw: string): Promise<string>         // bcryptjs
export async function verifyPassword(pw: string, hash: string): Promise<boolean>
```
- `src/middleware.ts` protects everything except `/sign-in`, `/api/auth/*`, static assets; for `/api/*` it returns `401 JSON` instead of redirecting. Edge-safe: split `auth.config.ts` (no Prisma/bcrypt) from `index.ts`.
- Route handlers under `/api/**` use `getSession()` and return `401 JSON` — never `requireSession()`.
- `src/app/(auth)/sign-in/page.tsx`: credentials form pre-filled with `DEMO_USER`; `src/app/(auth)/actions.ts` exports `signInAction`, `signOutAction` (AppShell's user menu imports `signOutAction`). `/` redirects to `/workforce`.
- Never `import "server-only"` (not installed; breaks vitest).

## secrets — `@/server/secrets`
```ts
export const KNOWN_CREDENTIALS: ReadonlyArray<{ name: string; label: string; usedBy: string[]; docsUrl: string }>   // Phase 1: TAVILY_API_KEY (web_search)
export async function resolveSecret(organizationId: string, name: string): Promise<string | undefined> // org Credential (updates lastUsedAt) → process.env[name]; "" counts as unset
export async function setCredential(s: SessionContext, args: { name: string; value: string; label?: string }): Promise<void>  // role !== MEMBER else forbidden(); name must be in KNOWN_CREDENTIALS (VALIDATION)
export async function deleteCredential(s: SessionContext, name: string): Promise<void>
export async function listCredentials(organizationId: string): Promise<Array<{ name: string; label: string | null; last4: string; createdAt: string; lastUsedAt: string | null }>>  // never returns values
export function encrypt(plain: string): string; export function decrypt(payload: string): string  // AES-256-GCM, key = CREDENTIAL_ENCRYPTION_KEY (base64, 32 bytes), random IV per value
```
**Decision:** model-provider keys are **env-only** in Phase 1 (process-wide, read by `llm.status()`); the credentials vault feeds **tools only**.

## activity — `@/server/activity`  (types: `activity/types.ts`)
```ts
export async function recordActivity(e: {
  organizationId: string; type: ActivityType; title: string; detail?: string;
  workerId?: string; jobId?: string; runId?: string;
  actorType?: ActorType; actorName?: string; metadata?: ActivityMetadata;
}, tx?: DbOrTx): Promise<void>
  // WITHOUT tx: never throws (logs on failure). WITH tx: lets DB errors propagate (the tx is already doomed). Prefer recording after commit unless atomicity matters.
export async function listActivity(organizationId: string, opts?: { workerId?: string; jobId?: string; types?: ActivityType[]; limit?: number; before?: Date }): Promise<ActivityItem[]>   // newest first, href pre-computed
```

## usage — `@/server/usage`  (types: `usage/types.ts`)
```ts
export async function recordUsage(u: {
  organizationId: string; kind: "MODEL" | "TOOL"; provider: string; resource: string;
  inputTokens?: number; outputTokens?: number; costUsd: number; simulated: boolean;
  workerId?: string; jobId?: string; runId?: string;
}): Promise<void>     // never throws. billableUsd = costUsd × config.usage.marginMultiplier. If runId is set, ALSO atomically increments Run.costUsd/inputTokens/outputTokens.
export async function getUsageSummary(organizationId: string, range: { from: Date; to: Date }): Promise<UsageSummary>
export async function getWorkerCostSummary(organizationId: string, workerId: string, days?: number): Promise<WorkerCostSummary>   // default 30
```
Day bucketing is done in JS on local calendar days (no raw SQL date_trunc).

## models — `@/server/models`  (types: `models/types.ts`)
```ts
export const llm: Llm
```
- Providers via AI SDK v5 (`createAnthropic`, `createOpenAI`, `createGoogleGenerativeAI`); available iff the env key is non-empty and `config.forceSimulated` is false. **Live tool calling:** pass tools WITHOUT `execute` so the SDK returns tool calls and stops after one step; the runtime owns the loop. Never set OpenAI `strictJsonSchema: true` or Anthropic `structuredOutputMode: "outputFormat"`.
- Tier routing: first available provider in order anthropic → openai → google; per-tier override via `MODEL_TIER_FAST|STANDARD|REASONING="<provider>:<model>"`. Nothing available → `mock` provider (`simulated: true`): calls `req.mock(...)`, applies `normalize`, validates against `req.schema`, estimates usage from text length (~4 chars/token), priced at the tier's reference model so cost pages look realistic. Mock tool-call ids are deterministic (`mock_<turn>_<i>`).
- `pricing.ts`: central table `{ "<provider>:<model>": ModelPrice }` + per-tier reference prices; comment the date verified. For Anthropic model ids/pricing consult the `claude-api` skill if available.
- `generateObject` (live): pass `experimental_repairText` that JSON-parses, recursively deletes null-valued properties, re-serializes; apply `req.normalize`; validate; on validation failure ONE re-ask with the Zod issues appended to the prompt; then `AppError("MODEL_ERROR")`.
- Every call: measure latency → compute cost → if `tracking.persist !== false`: create `ModelCall` and call `usage.recordUsage(kind: "MODEL")`. Persist failures are logged, never thrown. Transient live errors (429/5xx/network): retry ≤ 2× with backoff, then throw `AppError("MODEL_ERROR")` and persist a ModelCall with `error`.
- `ModelCall.request = { system?, messages?: ChatMessage[], prompt?, tools?: string[], schemaName? }`, `ModelCall.response = { text?, toolCalls?, object?, finishReason? }`. Truncate by clipping individual string fields to 2,000 chars (`…[truncated]`) and keeping the last 12 messages. Never slice serialized JSON.
- Convert `ChatMessage[]` ↔ AI SDK `ModelMessage[]` (assistant tool-call parts / tool-result parts, error results as `error-json`).

## simulation — `@/server/simulation`  (types: `simulation/types.ts`)
```ts
export const simulation: Simulation
export function hashSeed(s: string): number; export function seededPick<T>(arr: readonly T[], seed: number): T; export function seededShuffle<T>(arr: readonly T[], seed: number): T[]
```
- Fixtures: ≥ 40 realistic (clearly fictional) AI-infrastructure companies with funding data; ≥ 60 customer feedback items across ≥ 7 categories; ≥ 30 support tickets. `dataset("customer_feedback" | "funding_rounds" | "support_tickets")`. Search results + page text are generated from these, keyed by query keywords (funding/startups/AI infra → companies; feedback/reviews → feedback; pricing/competitor → pricing pages; anything else → plausible generic results). Simulated URLs use the `.example` TLD.
- Tool calls emitted by `agentTurn` MUST validate against `TOOL_INPUT_SCHEMAS` (`tools/schemas.ts`) and it reads tool outputs per `ToolOutputs`.
- `agentTurn` is a small state machine over the conversation:
  1. **Notifier rule:** if `send_notification` is in `tools` and no tool message for it exists yet → emit exactly one call (`channel: "email"`, recipients from the job brief/spec or `["team@acme.example"]`, subject = deliverable title, body = first 1,500 chars of the input). After its tool result — ok OR `{error}` — emit a one-line final answer.
  2. **Collector (json output):** plan from granted tools only: `read_dataset` (when granted, esp. feedback/support families) or `web_search` → `fetch_url` top results → `extract_data` with `fields = spec.deliverable.fields`. When enough results exist (or no tools) → final answer = TOP-LEVEL JSON ARRAY of flat records with the spec's field names, sized to `spec.deliverable.targetCount` (default 12).
  3. **Analyst (markdown output):** no tools → markdown insights derived from the `records`/`stats` it was given (specific numbers, categories, names).
  4. Tool errors in the conversation → adapt (skip that tool), never loop forever; always finish within `maxTurns`.
- **Simulated quality model** (deterministic): collector on `fast` tier ⇒ ~30% of records missing a required field + ~15% duplicates; instructions shorter than ~120 chars ⇒ ~40% fewer records; `standard`/`reasoning` with specific instructions ⇒ complete. One-off `instructions` mentioning a count ("top 5") or a focus keyword are honored.

## tools — `@/server/tools`  (types: `tools/types.ts`, I/O shapes: `tools/schemas.ts`)
```ts
export const tools: Tools
```
| name | category | sideEffect | approval default | backend |
|---|---|---|---|---|
| `web_search` | research | external_read | no | Tavily when `TAVILY_API_KEY` resolves (and ctx not simulated), else `simulation.search` |
| `fetch_url` | research | external_read | no | real `fetch` + cheerio text (10 s timeout, 200 KB cap, http/https only, blocks private/loopback IPs) when live; `simulation.fetchPage` for `.example` hosts or when simulated |
| `extract_data` | data | none | no | simulated: `simulation.extractRecords`; live: `llm.generateObject` (fast tier) |
| `read_dataset` | data | external_read | no | Phase 1: built-in sample datasets via `simulation.dataset` (always `simulated: true`) |
| `csv_export` | output | none | no | papaparse `unparse` |
| `create_report` | output | none | no | markdown assembly |
| `calculator` | compute | none | no | safe recursive-descent arithmetic parser (no `eval`) |
| `send_notification` | communication | external_write | **yes** | Phase 1: always-simulated outbox (`{ delivered: true, simulated: true }`) |

- Each tool in `tools/impl/<name>.ts`, input schema from `TOOL_INPUT_SCHEMAS`, output per `ToolOutputs`.
- `invoke()` order: registry lookup → Zod-validate (→ `invalid_input`) → `authorize` → approval check by `toolCallId` (none/PENDING → `approval_required`; REJECTED/EXPIRED → `rejected`; APPROVED → continue) → `execute` → `recordUsage(kind: "TOOL")`. Never throws.
- `authorize`: tool in registry? listed in the version's `blueprint.tools`? non-revoked `WorkerToolGrant`? `grant.config.maxCallsPerRun` (per tool): count ToolCall rows where `{ runId, toolName, attempt, status IN (RUNNING, SUCCEEDED, FAILED) }`; deny `call_limit` when `count > max` (the runtime always creates the current row first, so it is included). `blueprint.limits.maxToolCallsPerRun` is enforced by the runtime only.
- `describe(toolName, input)`: never throws.

## evaluation — `@/server/evaluation`  (types: `evaluation/types.ts`)
```ts
export async function evaluateRun(runId: string): Promise<{ deterministic: Evaluation | null; judge: Evaluation | null }>
  // idempotent: upserts on (deliverableId, type). Deterministic checks over the run's deliverable + Run rollups; LLM judge (standard tier, tracking includes runId) against rubric + JobSpec; then refreshWorkerScore; activity EVALUATION_COMPLETED.
export function runDeterministicChecks(plan: EvaluationPlan, subject: EvalSubject): { score: number; passed: boolean; checks: CheckResult[] }   // PURE; score = weighted mean of check scores; configs via DETERMINISTIC_CHECK_CONFIG_SCHEMAS
export async function recordDeliverableFeedback(s: SessionContext, args: { deliverableId: string; decision: "accept" | "reject"; feedback?: string }): Promise<void>
  // tx: Deliverable status/feedback/reviewedBy; upsert ONE USER_FEEDBACK Evaluation (accepted=1, rejected=0) copying runId + workerVersionId FROM THE DELIVERABLE; then refreshWorkerScore; activity
export function combineScores(parts: { deterministic: number[]; judge: number[]; user: number[] }, weights: { deterministic: number; judge: number; user: number }, runs?: number): WorkerScore
  // PURE: mean per source; re-normalize weights over sources WITH data; no data or weight sum 0 → score null (never NaN)
export async function computeWorkerScore(workerId: string, opts?: { workerVersionId?: string; lastNRuns?: number }): Promise<WorkerScore>
  // default: current version, last 10 FINISHED runs; each FAILED run contributes a 0 to `deterministic`; CANCELLED excluded
export async function refreshWorkerScore(workerId: string): Promise<WorkerScore>   // caches Worker.score/scoreUpdatedAt + refreshWorkerHealth
export async function refreshWorkerHealth(workerId: string): Promise<void>         // HEALTH_THRESHOLDS → health + healthReason
export async function getWorkerMetrics(organizationId: string, workerId: string, opts?: { windowDays?: number; workerVersionId?: string }): Promise<ReviewMetrics>
export async function generatePerformanceReview(s: SessionContext, workerId: string): Promise<{ reviewId: string }>
  // metrics computed deterministically; LLM (standard tier) writes ReviewNarrative; mock narrative derived from metrics (REPLACE when score < 65 or recent failure rate high; IMPROVE 65–80; KEEP otherwise); activity REVIEW_GENERATED
```
Definitions: `runScore(run)` = SUCCEEDED → `combineScores` over Evaluation rows with `runId = run.id` (all three types) using that run's version weights, ×100 · FAILED → 0 · CANCELLED/non-terminal → excluded. `scoreTrend` = runScore per finished run, chronological. Duration metrics read `Run.durationMs` (active time).

## runtime — `@/server/runtime`  (types: `runtime/types.ts`)
```ts
export async function enqueueRun(args: EnqueueRunArgs): Promise<{ runId: string }>
  // verifies worker ACTIVE + has currentVersion (org-scoped); locks the version (lockedAt) on first run; consumes active TEMPORARY_INSTRUCTION WorkerMessages into input.instructions (instructionActive=false, appliedToRunId); Run.simulated = llm.isSimulated(); activity RUN_QUEUED
export async function claimNextRun(executorId: string, opts?: { organizationId?: string }): Promise<string | null>
  // atomic claim via Prisma: findFirst candidate (QUEUED, availableAt <= new Date(), worker.status ACTIVE, orderBy availableAt) + guarded updateMany({ where: { id, status: "QUEUED" } }); loop on count === 0. Sets RUNNING, lockedBy, lockedAt, heartbeatAt, startedAt ??= now.
export async function executeRun(runId: string, opts?: { executorId?: string }): Promise<ExecuteOutcome>
  // drives the run from its checkpoint as far as possible. If QUEUED it claims it itself (tests / inline execution).
export async function transitionRun(runId: string, to: RunStatus, patch?: Prisma.RunUpdateManyMutationInput, opts?: { expectLockedBy?: string; tx?: DbOrTx }): Promise<void>
  // enforces RUN_TRANSITIONS with a guarded updateMany on the current status (→ AppError("INVALID_TRANSITION")); transitions out of RUNNING clear lockedBy/lockedAt/heartbeatAt
export async function cancelRun(s: SessionContext, runId: string): Promise<void>
  // one tx: guarded → CANCELLED; the run's PENDING Approvals → EXPIRED; their ToolCalls → DENIED; open WAITING/RUNNING RunSteps → SKIPPED; activity RUN_CANCELLED
export async function cancelWorkerRuns(organizationId: string, workerId: string, statuses: Array<"QUEUED" | "WAITING_FOR_APPROVAL">): Promise<number>   // same path as cancelRun; used by workers.pause/retire
export async function retryRun(s: SessionContext, runId: string): Promise<{ runId: string }>        // NEW Run (trigger RETRY) for a FAILED/CANCELLED run
export async function decideApproval(args: DecideApprovalArgs): Promise<void>
  // one tx: require approval.status === PENDING AND run.status === WAITING_FOR_APPROVAL (else mark the approval EXPIRED + conflict("This request is no longer awaiting a decision")); write decision (Approval APPROVED|REJECTED, ToolCall APPROVED|DENIED, APPROVAL RunStep SUCCEEDED|FAILED); when no PENDING approvals remain for the run → WAITING_FOR_APPROVAL → QUEUED; activity APPROVAL_APPROVED|REJECTED
export async function recoverStaleRuns(opts?: { organizationId?: string }): Promise<number>
  // RUNNING with heartbeatAt older than staleLockMs → guarded updateMany on { id, status: RUNNING, heartbeatAt: <stale value read> } → QUEUED (attempt+1) or FAILED when attempts exhausted
export async function tickScheduler(now?: Date, opts?: { organizationId?: string }): Promise<number>
  // ACTIVE workers with nextRunAt <= now and no QUEUED/RUNNING/WAITING run → enqueue SCHEDULED; nextRunAt = computeNextRunAt(cadence, now)
export function startExecutor(): void; export function stopExecutor(): Promise<void>
```
**Executor.** Pure DB polling — it shares NO in-memory state with request handlers (separate webpack bundle). `startExecutor` stores `{ stop, generation }` on `globalThis`; when called again it stops the previous loop and starts a fresh one (replace, not skip). Poll loop with `config.executor.concurrency`; calls `recoverStaleRuns()` and `tickScheduler()` on their intervals (unscoped). While `executeRun` holds a run, a timer updates `heartbeatAt` every `staleLockMs / 4` (cleared in `finally`). **Fencing:** every executor write to Run (checkpoint save, transition, heartbeat) is a guarded `updateMany` with `where: { id, status: "RUNNING", lockedBy: executorId }`; `count === 0` ⇒ lock lost ⇒ stop immediately, write nothing further.
`src/instrumentation.ts`: `register()` → `if (process.env.NEXT_RUNTIME === "nodejs" && !config.executor.disabled) { try { const { startExecutor } = await import("@/server/runtime"); startExecutor(); } catch (e) { console.error(e) } }`.

**Execution semantics.**
- On every `executeRun` slice: `nextStepIndex = max(checkpoint.nextStepIndex, max(RunStep.index for run) + 1)`; mark leftover RunSteps in RUNNING (and WAITING non-approval) and ToolCalls in RUNNING from a dead slice as FAILED `"interrupted"`; stamp new RunStep/ToolCall rows with `run.attempt`.
- Seed context: `job_brief = renderJobBrief(spec)` (spec from the version's JobSpec row), `instructions = run.input.instructions`.
- **Agent component** — loop ≤ `maxTurns`: create RunStep(MODEL_CALL, RUNNING) FIRST → `llm.generateText({ tier, system: instructions, messages, tools: tools.specsFor(component.tools), mock: (i) => simulation.agentTurn({ component, jobFamily, spec, jobBrief, instructions, ...i }) }, { runId, runStepId, workerId, jobId, organizationId, purpose: "agent.turn" })` → finalize the step. Per assistant turn with tool calls:
  1. Tool names not in `component.tools` → tool message `{ error }`, no ToolCall row.
  2. For ALL remaining calls create RunStep(TOOL_CALL, title = `tools.describe(name, input).title`) + ToolCall(callId, input, RUNNING, runStepId) first (check `limits.maxToolCallsPerRun` before creating → LIMIT_EXCEEDED).
  3. Invoke each in order via `tools.invoke`. ok → tool message with output; denied/invalid_input/error/rejected → tool message `{ error }` (`isError: true`) so the agent adapts; `approval_required` → ToolCall PENDING_APPROVAL, call stays in `pendingToolCalls`.
  4. If any are pending: in ONE `$transaction` create the Approval rows (title/description from `tools.describe().approval`, payload = input) + RunStep(APPROVAL, WAITING, input `{ approvalId, toolCallId }`), save `checkpoint.agent`, transition → WAITING_FOR_APPROVAL; activity APPROVAL_REQUESTED; return.
  5. **Resume is idempotent:** for each pending call re-read the ToolCall: SUCCEEDED/FAILED/DENIED → reuse the stored output/error as the tool message, do NOT invoke; RUNNING with an `external_write` tool → `{ error: "outcome unknown after restart" }` without re-executing; otherwise invoke. After draining, immediately persist `checkpoint.agent` (messages appended, `pendingToolCalls: []`), then continue the loop.
  6. Final answer: `outputFormat: "json"` → parse JSON (tolerate ```json fences; unwrap `{ records: [...] }` defensively); on parse failure one repair turn, then fail the component.
- **Deterministic component** → pure functions in `runtime/deterministic/<operation>.ts` (config already validated by the blueprint schema; they receive the full context) → RunStep(DETERMINISTIC).
- **Deliverable** is created (idempotently — check `checkpoint.deliverableId` / existing row for the run) at the FIRST component boundary where `deliverable.contentKey` (and `dataKey`, if set) are present in context → RunStep(DELIVERABLE), activity DELIVERABLE_CREATED `{ deliverableId }`; later components (e.g. the approval-gated notifier) run after it. Title template supports `{{date}}` and `{{job_title}}`.
- **Limits:** cost vs `Run.costUsd` (DB), tool calls vs ToolCall rows of the current attempt, duration vs `counters.activeMs + current slice` → fail with `LIMIT_EXCEEDED` (no retry). Each slice adds its elapsed ms to `counters.activeMs` when it persists the checkpoint (pause, retry, finish). `Run.durationMs = counters.activeMs` on terminal transition — never `finishedAt − startedAt`.
- Checkpoint saved at every component boundary. Re-read run status at component boundaries: CANCELLED ⇒ stop.
- On success: SUCCEEDED with `RunOutput` → RunStep(EVALUATION) around `evaluation.evaluateRun(runId)` (failure to evaluate never fails the run) → `Worker.lastRunAt` → activity RUN_SUCCEEDED.
- On failure: RunStep(ERROR); if retryable and `attempt < maxAttempts` → QUEUED with backoff (`availableAt = now + 15 s × attempt`), attempt+1, checkpoint restored to the failed component's start (componentIndex/context/agent only — never rewind `nextStepIndex`); else FAILED → `evaluation.refreshWorkerScore(workerId)` → activity RUN_FAILED. A WAITING_FOR_APPROVAL → FAILED/CANCELLED transition expires its approvals (same as `cancelRun`).

## staffing — `@/server/staffing`  (types: `staffing/types.ts`)
```ts
export async function scopeJob(s: SessionContext, description: string): Promise<{ jobId: string; questions: ScopingQuestions }>
  // Job(DRAFT) with detected family + draft title; LLM (fast tier) asks ≤ 3 follow-ups (normalize: slice); stores Job.intake { questions, answers: {} }; activity JOB_CREATED
export async function buildJobSpec(s: SessionContext, jobId: string, answers: Record<string, string>): Promise<{ jobSpecId: string; spec: JobSpec }>
  // saves answers to Job.intake; LLM (standard tier) with JobSpecLlmSchema → add schemaVersion → filter toolsLikelyNeeded to the registry → JobSpecSchema.parse → JobSpec row (DRAFT, version n+1); Job.title/jobFamily synced
export async function updateJobSpec(s: SessionContext, jobSpecId: string, patch: Partial<JobSpec>): Promise<JobSpec>   // only while DRAFT; re-validates
export async function approveJobSpec(s: SessionContext, jobSpecId: string): Promise<void>   // → APPROVED; older APPROVED → SUPERSEDED; Job → SPEC_APPROVED only when Job.status is DRAFT; activity
export async function reviseJobSpec(s: SessionContext, jobId: string): Promise<{ jobSpecId: string; spec: JobSpec }>
  // only while Job is DRAFT|SPEC_APPROVED: clone latest spec → new DRAFT (version n+1), clear pendingProposal, Job → DRAFT ("Back" from the proposal step)
export async function discardJob(s: SessionContext, jobId: string): Promise<void>        // only DRAFT|SPEC_APPROVED with no workers → delete
export async function getHireFlowState(organizationId: string, jobId: string): Promise<HireFlowState>   // notFound() once the job is STAFFED/CLOSED
export async function proposeWorker(s: SessionContext, jobId: string, opts?: { regenerate?: boolean }): Promise<WorkerProposal>
  // from the APPROVED spec: LLM (standard tier) → BlueprintDraft → designBlueprint → stores Job.pendingProposal (returns the stored one unless regenerate)
export async function hireWorker(s: SessionContext, jobId: string, opts?: { name?: string; startFirstRun?: boolean }): Promise<{ workerId: string; versionId: string; runId?: string }>
  // CONFLICT if the job already has a non-RETIRED worker. tx: re-read pendingProposal → Worker + WorkerVersion v1 (ACTIVE, INITIAL_HIRE, changeSummary = proposal.rationale.join("\n")) + currentVersionId + WorkerToolGrants from blueprint.tools + schedule fields (cadenceToWorkerFields) + nextRunAt (computeNextRunAt) + Job → STAFFED + clear pendingProposal + activity WORKER_HIRED. After commit: enqueueRun({ trigger: "HIRE" }) unless startFirstRun === false.
export function designBlueprint(spec: JobSpec, draft: BlueprintDraft, opts?: { usedNames?: string[] }): WorkerBlueprint   // PURE
export function estimateCost(blueprint: Omit<WorkerBlueprint, "costEstimate">): CostEstimate   // PURE: token heuristics per component × llm.estimateCostUsd + tool costs; × runsPerMonth(schedule)
export function deriveKpis(spec: JobSpec): Kpi[]                       // PURE
export function deriveEvaluationPlan(spec: JobSpec, draft: Pick<BlueprintDraft, "keyFields">): EvaluationPlan   // PURE
export function draftFromTemplate(spec: JobSpec, opts?: { usedNames?: string[] }): BlueprintDraft   // PURE: job-family templates (the mock path; also the fallback when live output is unusable)
```
**`designBlueprint` wiring** (deterministic):
- `collector` agent (id `collector`, json, `inputKeys: ["job_brief", "instructions"]`, `outputKey: "records"`, `maxTurns 8`, `outputSchemaHint` from `spec.deliverable.fields`); tools filtered to the registry.
- `keyFields` / `rankBy` / `groupBy` filtered to names in `spec.deliverable.fields` (fallback for keyFields: first required field; skip the step when nothing is usable).
- In-place record steps on `records` in this order when enabled: `validate_records` (requiredFields = required spec fields, `dropInvalid: true`) → `dedupe` → `rank` (limit = targetCount × 1.5 rounded, when targetCount set).
- `compute_stats` → `stats` (when `steps.computeStats` and `groupBy` usable).
- Markdown deliverable: `analyst` agent (id `analyst`, markdown, no tools, `inputKeys: ["job_brief", "records"] (+ "stats")`, `outputKey: "insights"`, `maxTurns 2`) → `compile_report` → `report` (sections: insights as markdown; records as table; stats when present); deliverable `{ contentKey: "report", dataKey: "records" }`. CSV: `to_csv` → `csv`; deliverable `{ contentKey: "csv", dataKey: "records" }`; analyst omitted. JSON: deliverable `{ contentKey: "records", dataKey: "records" }`.
- `steps.notify` (or `spec.toolsLikelyNeeded` includes `send_notification`): append agent `notifier` (fast tier, `maxTurns 3`, `inputKeys: [contentKey]`, tools `[send_notification]`, `outputKey: "notification_status"`, markdown) + ToolRequirement `{ send_notification, requiresApproval: true }`.
- `tools[]` = union of agent tools with reasons from `draft.toolReasons` (fallback: the tool's `humanDescription`), `requiresApproval` = registry default.
- persona: name from the draft unless in `usedNames` → deterministic pick from a pool; `avatarColor` deterministic from the name. KPIs, evaluation plan, limits (`DEFAULT_RUN_LIMITS`, `maxCostPerRunUsd` from `spec.budget` when set), schedule = `spec.cadence`, `costEstimate` = `estimateCost(...)`. Finally `parseBlueprint` — throw `AppError("VALIDATION")` with issues when invalid.
- Mock templates: research families use `standard` collector + validate + dedupe + rank; feedback_analysis uses `read_dataset` collector ("categorizer") + computeStats(groupBy category) + analyst + notify when the description mentions sending/sharing; lead_research → CSV.

## workers — `@/server/workers`  (types: `workers/types.ts`)
```ts
// versions.ts
export async function assertVersionMutable(versionId: string): Promise<void>        // AppError("IMMUTABLE_VERSION") when lockedAt set or status !== PROPOSED
export async function createProposedVersion(args: { organizationId: string; workerId: string; blueprint: WorkerBlueprint; changeReason: "REPLACEMENT" | "SPEC_CHANGE" | "MANUAL"; changeSummary: string; analysis?: ReplacementAnalysis; userId?: string }): Promise<{ versionId: string; version: number }>
  // version = max+1; parentVersionId = worker.currentVersionId; any other still-PROPOSED version → REJECTED first (one open proposal per worker); activity VERSION_PROPOSED
export async function activateVersion(s: SessionContext, versionId: string, opts?: { newName?: string }): Promise<void>
  // CONFLICT when the worker has a RUNNING/WAITING_FOR_APPROVAL run. tx: old current → REPLACED + retiredAt; new → ACTIVE + activatedAt; worker.currentVersionId; persona (title; name only when newName given); sync grants (add missing from blueprint.tools; keep user-tightened settings; revoke grants for tools no longer in the blueprint); worker.health → UNKNOWN, score → null; schedule + nextRunAt from the blueprint; activity WORKER_REPLACED (title by changeReason: "hired a replacement for …" vs "updated how <name> works").
export async function rejectProposedVersion(s: SessionContext, versionId: string): Promise<void>
export function diffBlueprints(before: WorkerBlueprint, after: WorkerBlueprint): BlueprintDiff      // PURE, human-labelled
export async function listVersions(organizationId: string, workerId: string): Promise<VersionSummary[]>
export async function getVersionComparison(organizationId: string, versionId: string, againstVersionId?: string): Promise<VersionComparison>
// lifecycle.ts
export async function pauseWorker(s, workerId): Promise<void>      // PAUSED, nextRunAt = null, QUEUED runs → cancelled (WAITING runs untouched)
export async function resumeWorker(s, workerId): Promise<void>     // ACTIVE, nextRunAt recomputed
export async function retireWorker(s, workerId): Promise<void>     // RETIRED + retiredAt, nextRunAt = null, QUEUED + WAITING runs cancelled; when the job has no other non-RETIRED worker: Job → SPEC_APPROVED (re-hire via /hire?jobId=)
export async function updateSchedule(s, workerId, schedule: Cadence): Promise<void>
export async function updateToolGrant(s, workerId, toolName, patch: { requiresApproval?: boolean; revoked?: boolean }): Promise<void>   // activity PERMISSION_CHANGED
export async function startRun(s: SessionContext, workerId: string, opts?: { instructions?: string[] }): Promise<{ runId: string }>   // manual "Run now" (thin wrapper over runtime.enqueueRun, trigger MANUAL)
// chat.ts
export async function sendMessageToWorker(s: SessionContext, workerId: string, content: string): Promise<{ userMessageId: string; replyMessageId: string; classification: MessageClassification; proposedVersionId?: string }>
  // classify (fast tier) → QUESTION: answer from worker context (job spec, recent runs, metrics) · TEMPORARY_INSTRUCTION: store instructionActive=true, acknowledge "I'll apply this on my next run"; activity INSTRUCTION_RECEIVED · SPEC_CHANGE: apply the change to the current blueprint (instructions / limits / schedule / deliverable target) → estimateCost + parseBlueprint → createProposedVersion(SPEC_CHANGE, analysis undefined) → reply metadata { proposedVersionId, href: "/workers/<id>/replace/<versionId>" }
export async function listMessages(organizationId: string, workerId: string, limit?: number): Promise<Array<{ id; role; content; classification; metadata; createdAt: string }>>
// replace.ts
export function applyReplacementPlan(current: WorkerBlueprint, spec: JobSpec, plan: ReplacementPlan): WorkerBlueprint   // PURE
export async function proposeReplacement(s: SessionContext, workerId: string): Promise<{ versionId: string }>
  // aggregates failed runs, low evals, rejected deliverables + feedback (window 30 d) → LLM (reasoning tier) ReplacementPlan → applyReplacementPlan → createProposedVersion(REPLACEMENT, analysis)
export async function hireReplacement(s: SessionContext, versionId: string, opts?: { newName?: string; startFirstRun?: boolean }): Promise<{ runId?: string }>   // activateVersion + optional first run
```
**`applyReplacementPlan`:** (1) `instructionRewrites` / `tierChanges` apply only where `componentId` matches an AGENT component; others ignored. (2) `addValidationStep`: if no `validate_records` exists, insert immediately after the first json agent (key K): `{ id: "validate_records", inputKeys: [K], outputKey: K, config: { requiredFields: <required spec fields>, dropInvalid: true } }`; skip when that list is empty. (3) `addDedupeStep`: same, after validate, `keyFields = [first required field]`. Append matching `required_fields` / `no_duplicates` checks when absent. (4) Re-run `staffing.estimateCost`, then `parseBlueprint`. The mock plan (Simulated mode) is derived from evidence: fast-tier collector → upgrade to standard; missing validate/dedupe → add; rejected-deliverable feedback is quoted into the instruction rewrite.

## seed — `prisma/seed.ts`
Idempotent: delete the demo Organization by slug, then recreate with FIXED ids (`org_demo`, `user_demo`) so existing session cookies stay valid. Writes rows directly with `db` + domain helpers (`@/server/auth/password`, `designBlueprint`/`draftFromTemplate` allowed). Three workers: **Alex** (market_research, healthy, weekly; rich history), **Maya** (feedback_analysis with notifier; holds the ONE pending approval: a WAITING_FOR_APPROVAL run with a valid `checkpoint` incl. `agent.pendingToolCalls`, `counters.activeMs`, `deliverableId`, so clicking Approve resumes it for real), **Sam** (market_analysis, NEEDS_ATTENTION: v1 = fast-tier collector WITHOUT validate/dedupe, failed runs + low evals + rejected deliverables with feedback — and no WAITING run, so Replace works). Runs carry RunSteps, ModelCalls/ToolCalls (with `runStepId`), UsageRecords, Deliverables, Evaluations (all 3 types), a WorkerReview, WorkerMessages, ActivityEvents with correct metadata keys; dates spread over the last ~21 days relative to now.

## UI
- `src/lib/action-result.ts`: `type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }` + `runAction(fn)`: its catch block FIRST calls `unstable_rethrow(e)` (from `next/navigation`) so `redirect()` / `notFound()` propagate, then maps `AppError` → `{ ok: false, error: e.message }`, unknown → logged + generic message. Actions that navigate on success return `{ ok: true, data: { redirectTo } }` and the client calls `router.push` — do not call `redirect()` inside `runAction`.
- `src/lib/format.ts`: `formatUsd`, `formatUsdPrecise` (sub-cent), `formatTokens`, `formatDuration(ms)`, `formatPercent(x /* 0..1 */)`, `formatRelativeTime`, `formatDateTime`, `titleCase`.
- `(app)/layout.tsx`: `const s = await requireSession(); const shell = await getShellData(s.organizationId)` → `<AppShell user={{ name, email, organizationName }} simulated={shell.simulated} pendingApprovals={shell.pendingApprovals}>`. `queries/shell.ts`: `getShellData(orgId): Promise<{ simulated: boolean; pendingApprovals: number }>` (approvals where status PENDING and run.status WAITING_FOR_APPROVAL). Root layout: metadata, fonts, `<TooltipProvider>`, sonner `<Toaster />`.
- Sidebar: Workforce · Hire · Jobs · **Approvals (count badge)** · Activity · Usage · Settings; user menu with sign-out; global Simulated-mode badge.
- Shared components (`src/components/`), exact props:
  `AppShell` · `PageHeader({ title, description?, actions?, breadcrumbs? })` · `WorkerAvatar({ name, color, size?: "sm" | "md" | "lg" })` · `StatusBadge({ kind: "run" | "worker" | "health" | "deliverable" | "version" | "approval" | "job" | "spec"; status: string })` · `ScoreRing({ score: number | null /* 0..100 */; size?: number })` · `StatCard({ label, value, hint?, icon?, trend? })` · `EmptyState({ icon?, title, description?, action? })` · `SimulatedBadge({ className? })` · `Markdown({ content })` (safe minimal renderer: headings, lists, tables, bold/italic/code, links; NO raw HTML) · `DataTable({ rows: Array<Record<string, unknown>>; columns?: string[]; maxRows?: number })` · `AutoRefresh({ active: boolean; intervalMs?: number })` (client; `router.refresh()`) · `CopyButton({ value })` · `ConfirmDialog({ trigger, title, description, confirmLabel, destructive?, onConfirm: () => Promise<void> })` · `Sparkline({ values: number[]; className? })` · `JsonView({ value })` (collapsible debug JSON) · `RelativeTime({ iso })`.
- Routes (all under `src/app/(app)/`, behind auth) and owners' query files (one owner each):
  `/workforce` → `queries/workforce.ts` · `/hire`, `/hire?jobId=` (resume; step derived from `getHireFlowState`, never from client state; after `scopeJob` the client does `router.replace("/hire?jobId=…")`) · `/jobs`, `/jobs/[jobId]` → `queries/jobs.ts` (DRAFT/SPEC_APPROVED jobs link to `/hire?jobId=`) · `/workers/[workerId]` → `queries/worker-profile.ts`, tabs via `?tab=` in `workers/[workerId]/_tabs/<tab>.tsx`: overview · activity · deliverables · performance · cost · permissions · chat · versions · debug · `/workers/[workerId]/replace/[versionId]` (title "Proposed change" + CTA "Apply change" for SPEC_CHANGE; failure-analysis panels only when `analysis !== null`; Versions tab links "Compare with previous" here) · `/runs/[runId]` + `src/app/api/runs/[runId]/route.ts` → `queries/runs.ts` · `/deliverables/[deliverableId]` → `queries/deliverables.ts` · `/approvals` → `queries/approvals.ts` (`listApprovals(orgId, { status?, workerId? })`; pending list filters `run.status = WAITING_FOR_APPROVAL`) · `/activity` · `/usage` → `queries/usage.ts` · `/settings` → `queries/settings.ts` (three cards: Workspace (read-only) · AI providers from `llm.status()` — no input field, "set in .env and restart" · Tool credentials: `KNOWN_CREDENTIALS` × `listCredentials` with set/delete, Live vs Simulated per tool).
- Live updates: `GET /api/runs/[runId]` → `RunLiveView` built by `queries/runs.ts:getRunLiveView(orgId, runId)`; 401/404 JSON. The client polls every 1.5 s while `!isTerminal(status) || evaluationPending`, and calls `router.refresh()` once when polling stops. List pages use `AutoRefresh`.
- Browser storage (`localStorage`/`sessionStorage`) only inside `useEffect`/event handlers guarded by `typeof window !== "undefined"` — Node 25 exposes a non-functional global `localStorage` during SSR.

---

## Implementation notes (post-build, wave 1–2) — behaviours page code must know
- **auth:** `requireSession()` redirects a stale cookie (user row gone) to `/sign-in?expired=1`. Unauthenticated `/api/*` → `401 { error: "Not signed in", code: "UNAUTHENTICATED" }` — route handlers should return the same shape. `signOutAction` lives at `src/app/(auth)/actions.ts`.
- **ui-shell:** "Hire a worker" is the primary button above the nav (not a nav row); nav = Workforce · Jobs · Approvals (badge) · Activity · Usage · Settings. `formatUsd` renders sub-cent non-zero as `<$0.01`; `Section` and `IconSlot` are extra components (see `src/components/README.md`).
- **models:** mock provider models are `mock-fast` / `mock-standard` / `mock-reasoning` under provider `mock`. `llm` index also re-exports its types.
- **tools:** `tools.authorize` accepts an optional `organizationId` (invoke passes `ctx.organizationId`). Implementation files are kebab-case (`impl/web-search.ts`). `extract_data` live path bills through the ModelCall, not the TOOL record.
- **evaluation:** `getWorkerMetrics` defaults to the CURRENT version; `EVALUATION_COMPLETED` activity sets `runId` AND `metadata.deliverableId` (feed links to the deliverable). `runScore` excludes SUCCEEDED runs that have no evaluation rows yet.
- **runtime:** `RUN_STARTED` activity is recorded on the first claim of a run ("Alex started working"). `decideApproval` on a run no longer waiting marks the approval EXPIRED (outside the tx) and throws CONFLICT. `recoverStaleRuns` also treats RUNNING runs with a null heartbeat and an old `lockedAt`/`updatedAt` as stale. `compute_stats.share` is 0..1 with 4 decimals. Public index re-exports `./types`.
- **staffing:** `buildJobSpec` only while `Job.status === DRAFT` (after approval call `reviseJobSpec` first); `proposeWorker` requires the newest open spec to be the APPROVED one; `WORKER_HIRED` metadata is `{ version: 1, changeReason: "INITIAL_HIRE" }` (no versionId, so the feed links to the worker). `hireWorker` row-locks the Job so double clicks cannot double-hire.
- **workers:** `updateSchedule` records a `NOTE` activity; `updateToolGrant` refuses to loosen approval below the registry default (VALIDATION); `activateVersion` keeps a PAUSED worker paused (nextRunAt null); proposals seed `blueprint.schedule` from the worker's LIVE cadence; `retireWorker` also rejects open proposals; `VersionSummary.metrics` uses a 365-day window; `hireReplacement` enqueues the first run unless `startFirstRun === false`. No `closeJob` exists — a Jobs page action may set `Job.status = CLOSED` directly when the job has no ACTIVE/PAUSED workers.

## Implementation notes (post-review, wave 4)
- **runtime index** additionally exports the pure helpers the seed reuses: `compact`, `oneLine`, `deliverableSummary`, `narrativeSummary`, `renderTitle`, `DECLINED_MESSAGE`, `runDeterministic` (+ `ReportMeta`), `buildInitialMessage`, `buildSystemPrompt`, `repairPrompt`; `runtime/deterministic` exports cell formatters (`formatColumnCell`, `formatUsdCompact`, `isMoneyColumn`, `isUrlColumn`) — reports render money compactly and URLs as links, while `Deliverable.data`/CSV keep raw values. **models index** exports `buildRequestTrace`, `buildResponseTrace`.
- **simulation**: `agentTurnHints(blueprint)` → `{ keyFields? }` is spread into the `agentTurn` input by the runtime (and the seed) so the analyst counts duplicates on the blueprint's dedupe keys. Named vendors in a spec drive the simulated pricing search.
- **staffing**: feedback-analysis markdown reports add two record steps that write a `notable_feedback` shortlist (≤ 10, most severe first); `compile_report` reads that key for the "Notable feedback" table while `records` stays complete for data, stats and evaluation. Simulated scoping synthesizes concise titles, parses user-listed columns into spec fields, skips follow-up questions the description already answers, and treats prospecting cues ("good fit for our", "target accounts") as lead research.
- **tools**: approval descriptions are plain-text excerpts (markdown stripped); the payload keeps the raw body. A gated TOOL_CALL step's duration is the tool latency, not the human wait.
- **evaluation**: `generatePerformanceReview` throws CONFLICT for a worker with no scored runs. Rubric criteria are content-quality dimensions, never KPI names.
- **seed** imports only public module indexes (enforced by `tests/seed/boundaries.test.ts`).
