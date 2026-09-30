# Production & security phase — contracts and ownership

> **Historical:** this file is the brief from the production-hardening phase of the original build. The role matrix and the `@/server/security` / `@/server/account` APIs below are still accurate. The "owner" and "frozen for this phase" wording is not a rule for contributors; see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

This phase makes the MVP publicly deployable and hardened, and redesigns the UI (see `docs/DESIGN.md`).
It supersedes the "FROZEN" list in `docs/CONTRACTS.md` **only** for the files explicitly assigned below.
Audit findings that motivate each item are referenced by ID (F-002, INF-06, OPS-01) in code comments.

## Already in place before this phase
- `package.json`: npm `overrides` (undici/postcss/deepmerge-ts) → `npm audit` = 0 vulnerabilities; `shadcn` moved to devDeps; `esbuild` added; scripts `worker`, `build:worker`, `start:worker`, `db:seed:demo`, `audit:prod`. Agents may edit `scripts` only if their brief says so; never run `npm install`.
- `prisma/schema.prisma` + migration `20260922090000_production_security` (applied to dev + test DBs): `Organization.{isDemo, monthlyBudgetUsd, maxConcurrentRuns, maxQueuedRuns, maxActiveWorkers, suspendedAt}`, `User.{sessionVersion, passwordChangedAt, lastSignInAt, disabledAt, emailVerifiedAt}`, models `RateLimitBucket`, `SecurityEvent` (+ enum `SecurityEventType`), `Invitation`, `OrgSpendMonth`, `ExecutorHeartbeat`, and hot-path indexes. The existing demo org (`acme-robotics`) was marked `isDemo = true`.
- `src/server/env.ts` — `validateEnv()` / `assertValidEnv()` (zod; production rules). Call `assertValidEnv()` at web boot (instrumentation) and worker boot.
- `src/server/config.ts` — new getters: `isProduction`, `appVersion`, `publicUrl`, `executor.mode ("inline"|"off")` — dev-only switch for whether `npm run dev` also starts a worker; the web process never executes runs, `executor.shutdownGraceMs`, `auth.*` (signupMode, signupInviteCode, demoMode, allowDemoSeed, session ages, trustedProxyHops, password policy numbers, bcryptRounds, invitationTtlDays), `limits.*` (rateLimitDisabled, defaultMonthlyBudgetUsd, platform ceilings, maxInFlightRunsPerWorker), `retention.*`, `log.*`.
- `src/server/auth/permissions.ts` — `PERMISSIONS`, `can(role, p)`, `assertCan(session, p)` (throws FORBIDDEN with a human message), `permissionsFor(role)`. Pure; any server module may deep-import it.
- `next.config.ts` — `output: "standalone"`, `poweredByHeader: false`, static security headers (HSTS in prod, nosniff, frame DENY, referrer, permissions, COOP, CORP), server-action `bodySizeLimit: 256kb` + optional `SERVER_ACTIONS_ALLOWED_ORIGINS`.
- `tests/setup/env.ts` sets `RATE_LIMIT_DISABLED=true` and `EXECUTOR_MODE=off`; rate-limit tests delete it locally.

## Role matrix (enforced inside server modules via `assertCan`)
| Permission | Min role | Enforced in |
|---|---|---|
| workers.run | MEMBER | workers.startRun, runtime.retryRun, runtime.cancelRun |
| workers.chat | MEMBER | workers.sendMessageToWorker |
| deliverables.review | MEMBER | evaluation.recordDeliverableFeedback |
| approvals.decide | MEMBER | runtime.decideApproval (all approvals) |
| approvals.decideExternal | ADMIN | runtime.decideApproval when the tool's `sideEffect === "external_write"` (re-read the deciding user's role from DB) |
| reviews.generate | MEMBER | evaluation.generatePerformanceReview |
| jobs.manage | ADMIN | staffing.scopeJob/buildJobSpec/updateJobSpec/approveJobSpec/reviseJobSpec/discardJob/proposeWorker, jobs close action |
| workers.hire | ADMIN | staffing.hireWorker, workers.hireReplacement |
| workers.manage | ADMIN | workers.pause/resume/retire/updateSchedule/updateToolGrant/proposeReplacement/rejectProposedVersion/activateVersion |
| credentials.manage | ADMIN | secrets.setCredential/deleteCredential |
| members.invite | ADMIN | account.createInvitation/revokeInvitation (can invite MEMBER or ADMIN, never OWNER) |
| members.manage | OWNER | account.changeMemberRole/removeMember |
| org.manage | OWNER | account.updateOrgSettings (name, monthly budget) |

## `@/server/security` (owner: **security**) — API other modules code against
```ts
export type RateRule = { name: string; limit: number; windowSec: number };
export const RATE_RULES: {
  signInAccount: RateRule;   // 5 / 15 min per sha256(email) — lockout with exponential backoff (15 min × 2^lockCount, max 24 h)
  signInIp: RateRule;        // 30 / 15 min per client IP
  signUpIp: RateRule;        // 5 / hour per IP
  inviteAcceptIp: RateRule;  // 20 / hour per IP
  invitesCreateOrg: RateRule;// 30 / day per org
  passwordChangeUser: RateRule; // 5 / hour per user
  llmUser: RateRule;         // 30 / 10 min per user — every action that calls an LLM
  llmOrg: RateRule;          // 300 / day per org
  runOrg: RateRule;          // 60 / hour per org — Run now, retry, hire-with-first-run
  credentialsOrg: RateRule;  // 20 / hour per org
  pollUser: RateRule;        // 240 / min per user — GET /api/runs/[id]
};
export async function hit(rule: RateRule, subject: string): Promise<{ allowed: boolean; count: number; retryAfterSec: number }>;
export async function enforce(rule: RateRule, subject: string): Promise<void>;          // throws AppError("LIMIT_EXCEEDED", "You're doing that too often. Try again in N s.")
export async function isLocked(rule: RateRule, subject: string): Promise<{ locked: boolean; retryAfterSec: number }>;
export async function lock(rule: RateRule, subject: string): Promise<{ lockedUntil: Date }>; // exponential backoff via lockCount
export async function resetLimit(rule: RateRule, subject: string): Promise<void>;
export async function sweepRateLimits(now?: Date): Promise<number>;                      // delete buckets idle > 2 days
// All limiter functions are no-ops (allowed) when config.limits.rateLimitDisabled; non-auth rules fail OPEN on DB errors (log), auth rules fail CLOSED.

export async function recordSecurityEvent(e: { type: SecurityEventType; organizationId?: string; userId?: string; email?: string; ip?: string; userAgent?: string | null; metadata?: Record<string, unknown> }): Promise<void>; // never throws; hashes email; clips UA
export async function listSecurityEvents(organizationId: string, opts?: { userId?: string; limit?: number }): Promise<SecurityEventView[]>; // plain JSON
export async function requestContext(): Promise<{ ip: string; userAgent: string | null }>; // next/headers; safe outside a request (→ "unknown")
export function clientIpFromHeaders(headers: Headers, trustedHops?: number): string;
export function hashEmail(email: string): string;

export async function assertOrgActive(organizationId: string): Promise<void>;           // suspendedAt → FORBIDDEN "This workspace is suspended…"
export async function assertWithinBudget(organizationId: string): Promise<void>;        // month-to-date REAL spend (OrgSpendMonth) ≥ budget → LIMIT_EXCEEDED
export async function getBudgetStatus(organizationId: string): Promise<{ month: string; spentUsd: number; budgetUsd: number; remainingUsd: number; exceeded: boolean }>;
export async function recordRealSpend(organizationId: string, costUsd: number, tx?: DbOrTx): Promise<void>; // atomic upsert-increment of OrgSpendMonth (UTC month)
export function clampRunLimits(limits: RunLimits): RunLimits;                            // platform ceilings from config.limits

export function redactSecrets(text: string): string;                                     // sk-…, tvly-…, AIza…, Bearer …, long hex/base64 tokens → [redacted]
export function publicErrorMessage(e: unknown): { message: string; ref: string };        // safe for clients; logs internals with ref
```
Dependency position: `security` imports only `db`, `errors`, `config`, `domain`, Prisma types and `next/headers` (lazily). `usage` may import it (recordRealSpend); everything above may import it.

## `@/server/account` (owner: **accounts**) — API
```ts
export function checkPasswordPolicy(password: string, ctx?: { email?: string; name?: string; organizationName?: string }): { ok: true } | { ok: false; reason: string };
export async function signUp(input: { name: string; email: string; password: string; organizationName: string; inviteCode?: string }, ctx: { ip: string; userAgent: string | null }): Promise<{ userId: string; organizationId: string }>;
export async function changePassword(s: SessionContext, input: { currentPassword: string; newPassword: string }): Promise<void>;       // bumps sessionVersion
export async function signOutEverywhere(s: SessionContext): Promise<void>;                                                             // bumps sessionVersion
export async function listMembers(organizationId: string): Promise<MemberView[]>;
export async function changeMemberRole(s: SessionContext, userId: string, role: UserRole): Promise<void>;   // OWNER; never leaves the org without an OWNER; bumps target sessionVersion
export async function removeMember(s: SessionContext, userId: string): Promise<void>;                        // OWNER; disabledAt + sessionVersion bump; cannot remove self/last owner
export async function createInvitation(s: SessionContext, input: { email: string; role: "MEMBER" | "ADMIN" }): Promise<{ invitationId: string; inviteUrl: string; expiresAt: string }>;
export async function listInvitations(organizationId: string): Promise<InvitationView[]>;
export async function revokeInvitation(s: SessionContext, invitationId: string): Promise<void>;
export async function getInvitationByToken(token: string): Promise<{ organizationName: string; email: string; role: UserRole; expiresAt: string } | null>;
export async function acceptInvitation(token: string, input: { name: string; password: string }, ctx: { ip: string; userAgent: string | null }): Promise<{ email: string }>;
export async function getOrgSettings(organizationId: string): Promise<OrgSettingsView>;
export async function updateOrgSettings(s: SessionContext, input: { name?: string; monthlyBudgetUsd?: number | null }): Promise<void>;   // OWNER
```
Invitation links are shown to the inviting admin to share (no email provider in Phase 1). Self-service password reset needs an email provider — documented as a known gap.

## File ownership this phase
**Wave B (parallel)**
- **accounts** — `src/server/auth/**` (not `types.ts`, `permissions.ts`), `src/types/next-auth.d.ts`, `src/server/account/**`, `src/app/(auth)/**` (actions/schema + minimal functional `/sign-up` and `/invite/[token]` pages; wave C restyles), `src/app/(app)/settings/account-actions.ts`, `tests/auth/**`, `tests/account/**`.
- **security** — `src/server/security/**`, `src/middleware.ts`, `src/lib/action-result.ts`, `src/lib/markdown.ts`, `src/server/secrets/**`, `src/server/tools/**` (not `types.ts`/`schemas.ts`), `src/server/models/**` (not `types.ts`), `src/app/(app)/deliverables/[deliverableId]/download/route.ts`, `src/app/api/runs/[runId]/route.ts`, `docs/SECURITY.md`, `tests/security/**` + tests for the modules above.
- **guardrails** — `src/server/staffing/**`, `src/server/workers/**`, `src/server/runtime/**` except `executor.ts`, `src/server/evaluation/**`, `src/server/usage/**`, `src/server/activity/**`, every `actions.ts` / `manage-actions.ts` under `src/app/(app)/**` (rate limits + permission-aware results only — no UI changes), `src/server/queries/**` (adding `permissions` to view models), tests for those areas.
- **ops** — `src/worker.ts`, `src/instrumentation.ts`, `src/server/runtime/executor.ts`, `src/server/maintenance/**`, `src/server/log/**`, `src/app/api/health/route.ts`, `src/app/api/ready/route.ts`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.github/workflows/**`, `.env.example`, `.env.test.example`, `docs/DEPLOYMENT.md`, `prisma/seed.ts` + `prisma/seed/**`, `package.json` `scripts` only, `tests/ops/**`, `tests/seed/**`.
- **design-foundation** — `src/app/globals.css`, `src/app/layout.tsx`, `src/app/global-error.tsx`, `src/app/not-found.tsx`, `src/app/(app)/{layout,error,not-found,loading}.tsx`, `src/components/**` (incl. restyling `ui/*` primitives), `src/components/README.md`, `src/lib/**` except `action-result.ts`/`markdown.ts`, `src/server/queries/shell.ts`, `src/app/(dev)/styleguide/**`, `docs/DESIGN.md`, `tests/ui/**`.

**Wave C (after B)** — page redesigns per `docs/DESIGN.md`; assignments in the wave-C briefs.
