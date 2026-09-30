# Foreman — contributor guide (for people and Claude Code)

**Product:** the staffing agency for AI workers. A company describes a job in plain English → the platform scopes it (JobSpec) → designs an AI worker (WorkerBlueprint) → the user *hires* it → it executes runs → produces deliverables → is evaluated → can be talked to, improved, or *replaced* like a contractor. Core loop: **Job → Worker → Runs → Deliverables → Evaluation → Replace.**

Foreman is open source (Apache 2.0) and self-hosted: people run it with their own provider keys, or with none in Simulated mode. There is no hosted version. Anything that makes self-hosting harder, or that quietly spends someone's tokens, is a regression.

Before writing code, read `docs/CONTRACTS.md` (module boundaries, public function signatures, dependency direction). Read `docs/DESIGN.md` before any UI change. The typed contracts live in code: `prisma/schema.prisma`, `src/server/domain/*` and `src/server/*/types.ts`. `docs/SECURITY.md` and `docs/DEPLOYMENT.md` cover the threat model and operations.

## Stack (pinned, so don't upgrade or swap in a PR that isn't about that)
Next.js 15 App Router · React 19 · strict TypeScript · Tailwind v4 · shadcn/ui (radix, components in `src/components/ui`) · Prisma 6 + PostgreSQL 14+ · Auth.js v5 (credentials) · Vercel AI SDK **v5** (`ai@5`, `@ai-sdk/*@2`) · Zod **v4** · Vitest · lucide-react · recharts · date-fns · sonner. Node 22+.

## Hard rules
1. **Multi-tenancy:** every query and mutation is scoped by `organizationId`. A function that takes an id from the client MUST check that it belongs to the caller's org (`where: { id, organizationId }`) and throw `notFound()` otherwise.
2. **Permissions are server-side.** Tool execution goes through `tools.invoke()` only. Never call a tool's `execute()` directly from the runtime or UI. Role checks use `assertCan()` inside server modules, never only in pages.
3. **WorkerVersions are immutable** once `lockedAt` is set (first run). Changes always create a new version.
4. **All LLM calls** go through `llm.generateText/generateObject` from `@/server/models` with a `tier`, a `CallTracking` and a deterministic `mock`. Never import `ai` / `@ai-sdk/*` outside `src/server/models/`. That's how usage gets metered and budgets enforced, and how Simulated mode keeps working.
5. **Simulated mode must stay excellent.** With no API keys, the whole product has to work end to end on the mock provider and simulated tools, clearly badged "Simulated" in the UI. Mock output must be deterministic (no `Math.random()`; seed from input hashes). Every new feature needs a good simulated path, and tests always run simulated.
6. **Never spend the user's money by surprise.** Anything that makes a real provider call must be metered and must respect the per-run and per-org ceilings (`PLATFORM_*`). Anything with an external side effect must be approval-gated.
7. **Server-only code** lives under `src/server/**` and is never value-imported by client components (`"use client"`). Client components get data through props, server actions or `/api` routes. Exception: client components MAY value-import `@/server/domain` and `@/server/runtime/types` (pure, zod-only). Everything else under `src/server`, and Prisma enums, is `import type` only. Don't `import "server-only"` (not installed).
8. **Money:** Prisma `Decimal` in the DB. Convert with `Number(x)` at the query boundary and format with the helpers in `src/lib/format.ts`. Never pass `Decimal`/`Date`-containing Prisma objects into client components; map them to plain serializable objects first.
9. **Secrets:** never log, commit or echo API keys or the values of `AUTH_SECRET` / `CREDENTIAL_ENCRYPTION_KEY`. Keys live in `.env` (git-ignored) or the encrypted credentials vault.

## Changing contracts and the schema
- **Schema changes need a migration.** Edit `prisma/schema.prisma` and commit the migration that `npx prisma migrate dev --name <change>` generates, run against *your own* dev database. Never hand-edit an applied migration. Don't run `prisma migrate reset` / `db push` against a database whose data you care about.
- `src/server/domain/*`, `src/server/*/types.ts`, `src/server/tools/schemas.ts`, `src/server/db.ts`, `src/server/errors.ts` and `src/server/config.ts` are shared contracts that many modules depend on. Change them deliberately, update every caller in the same PR, and say so in the PR description.
- New environment variables go in `.env.example` (annotated) and `src/server/env.ts` (validated), with a default that works for a local, keyless setup.
- Add dependencies only when they earn their place, and say why in the PR. The `package-lock.json` change must be in the same PR.
- The ownership labels in `docs/CONTRACTS.md` / `docs/PRODUCTION.md` (FROZEN, `[runtime]`, etc.) come from the original build. They record which module owns what, and don't restrict contributors.

## Conventions
- Next 15: pages, layouts and route handlers receive `params` and `searchParams` as **Promises**: `export default async function Page({ params }: { params: Promise<{ workerId: string }> }) { const { workerId } = await params; … }`. `cookies()`/`headers()` are async too.
- Server actions live next to the route in `actions.ts` with `"use server"`, export **only async functions**, start with `const session = await requireSession()`, and call `revalidatePath` after mutations. Schemas, types and constants go in a sibling `schema.ts`. Args and returns are plain JSON.
- Actions return `ActionResult<T>` (`{ ok: true, data } | { ok: false, error: string }`, `src/lib/action-result.ts`) and never throw to the client. Server code throws `AppError` (`src/server/errors.ts`).
- Read-side helpers live in `src/server/queries/<area>.ts`, take `organizationId` first, and return plain serializable objects.
- Writes into Prisma `Json` columns go through `toJson()` from `@/server/db`. Reads are parsed with the matching Zod schema from `@/server/domain` (`parseBlueprint`, `parseJobSpec`, …).
- Each module's public API is its `index.ts`. Import `@/server/<module>`, not deep paths (except `types.ts` / `schemas.ts` / `@/server/domain`), and respect the dependency direction in `docs/CONTRACTS.md`.
- Imports use the `@/` alias (→ `src/`). Named exports. Default exports only for Next.js pages, layouts and route files.
- User-facing language is humanized and contractor-style: "Alex searched the web for…", "Hire", "Replace", "Performance review". Never "agent executed tool".
- Keep files focused (under ~400 lines). Comment the *why*, not the *what*.
- Dates are stored in UTC and displayed with `date-fns`.

## Verifying your work
- Typecheck: `npm run typecheck`. Lint: `npm run lint`.
- Tests: `npm test`, or `npx vitest run tests/<area>`. They need `.env.test` pointing at a database whose name contains `_test` (see CONTRIBUTING.md). They always run in Simulated mode with provider keys cleared.
- In tests, use `createTestOrg()` (`tests/helpers/factory.ts`, returns `{ organization, user, session, cleanup }`) and `makeJobSpec` / `makeBlueprint` / `createHiredWorker` (`tests/helpers/fixtures.ts`), and always call `cleanup()`. Don't assert on global table counts. Call engine functions directly (`executeRun(runId)`) rather than relying on the background executor, and pass `organizationId` to `claimNextRun` / `tickScheduler` / `recoverStaleRuns`. Pass `persist: false` tracking only in pure unit tests.
- To see a change in the app, run `npm run dev` (web + worker on http://localhost:3000) and use *Explore the demo workspace* (`DEMO_MODE=true`).
- The project path may contain spaces, so quote paths in shell commands.
