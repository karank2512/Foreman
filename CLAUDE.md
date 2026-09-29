# Foreman — engineering guide

**Product:** Foreman — the staffing agency for AI workers. A company describes a job in plain English → the platform scopes it (JobSpec) → designs an AI worker (WorkerBlueprint) → the user *hires* it → it executes runs → produces deliverables → is evaluated → can be talked to, improved, or *replaced* like a contractor. Core loop: **Job → Worker → Runs → Deliverables → Evaluation → Replace.**

**Name:** the product was renamed from "AI Staffing Agency" to Foreman; the folder on disk, the database names (`ai_staffing_agency`, `ai_staffing_agency_test`, `ai_staffing_agency_shadow`), and the docker-compose project name (`ai-staffing-agency`) still use the old name — leave them unless your task says otherwise. The demo login is `demo@foreman.example`.

**Read `docs/CONTRACTS.md` before writing any code.** For the production/security/redesign phase also read `docs/PRODUCTION.md` (contracts + file ownership that override the FROZEN list for assigned files) and `docs/DESIGN.md` (the design system every UI change follows). It defines module boundaries, public function signatures, and file ownership. The typed contracts live in code: `prisma/schema.prisma`, `src/server/domain/*`, `src/server/*/types.ts`.

## Stack (pinned — do not upgrade or swap)
Next.js 15 App Router · React 19 · strict TypeScript · Tailwind v4 · shadcn/ui (radix, components already in `src/components/ui`) · Prisma 6 + PostgreSQL 14 · Auth.js v5 (credentials) · Vercel AI SDK **v5** (`ai@5`, `@ai-sdk/*@2`) · Zod **v4** · Vitest · lucide-react · recharts · date-fns · sonner.

## Hard rules
1. **Never edit** FROZEN files — `prisma/**` (except `prisma/seed.ts` for its owner), `src/server/domain/*`, `src/server/*/types.ts`, `src/server/tools/schemas.ts`, `src/server/db.ts`, `src/server/errors.ts`, `src/server/config.ts`, `package.json`, `next.config.ts`, `vitest.config.mts`, `tests/helpers/*`, `tests/setup/*` — or another module's files, unless your task explicitly says you own them. If a contract is wrong or missing something, make the smallest workable choice inside your own files and **report it in your final output** under "CONTRACT ISSUES".
2. **Never run** `npm install`, `prisma migrate dev`, `prisma db push`, `prisma migrate reset`, `dropdb`, or anything that mutates a database schema or wipes data. (Prisma blocks `migrate reset` for AI agents without explicit user consent — do not work around it.) All dependencies are already installed. If you truly need a new package, report it instead.
3. **Multi-tenancy:** every query/mutation is scoped by `organizationId`. Functions that take an id from the client MUST verify it belongs to the caller's org (`where: { id, organizationId }`) and throw `notFound()` otherwise.
4. **Permissions are server-side.** Tool execution goes through `tools.invoke()` only. Never execute a tool's `execute()` directly from the runtime or UI.
5. **WorkerVersions are immutable** once `lockedAt` is set (first run). Changes always create a new version.
6. **All LLM calls** go through `llm.generateText/generateObject` from `@/server/models` with a `tier`, a `CallTracking`, and a deterministic `mock`. Never import `ai` / `@ai-sdk/*` outside `src/server/models/`.
7. **Simulated mode must be excellent.** No API keys exist on this machine. The whole product must work end-to-end on the mock provider + simulated tools, clearly badged "Simulated" in the UI. Mock output must be deterministic (no `Math.random()`; seed from input hashes).
8. **Server-only code** lives under `src/server/**` and must never be value-imported by client components (`"use client"`). Client components get data via props, server actions, or `/api` routes. Exception: client components MAY value-import from `@/server/domain` and `@/server/runtime/types` (pure, zod-only). Everything else under `src/server` — and Prisma enums — is `import type` only. Never `import "server-only"` (not installed).
9. Money: Prisma `Decimal` in the DB; convert with `Number(x)` at the query boundary; format with helpers in `src/lib/format.ts`. Never pass `Decimal`/`Date`-containing Prisma objects straight into client components — map to plain serializable objects first.

## Conventions
- Next 15: pages, layouts and route handlers receive `params` and `searchParams` as **Promises**: `export default async function Page({ params, searchParams }: { params: Promise<{ workerId: string }>; searchParams: Promise<{ tab?: string }> }) { const { workerId } = await params; … }`. `cookies()`/`headers()` are async too.
- `actions.ts` files with `"use server"` export **only async functions**. Put schemas, types and constants in a sibling `schema.ts`. Action args and returns must be plain JSON.
- Writes into Prisma `Json` columns go through `toJson()` from `@/server/db`. Reads are parsed with the matching Zod schema from `@/server/domain` (`parseBlueprint`, `parseJobSpec`, …).
- Imports use the `@/` alias (→ `src/`). Named exports; no default exports except Next.js pages/layouts/route files.
- Errors: throw `AppError` (`src/server/errors.ts`). Server actions return `{ ok: true, data } | { ok: false, error: string }` (type `ActionResult<T>` in `src/lib/action-result.ts`) — they never throw to the client.
- Server actions live next to the route in `actions.ts` with `"use server"`, start with `const session = await requireSession()`, and call `revalidatePath` after mutations.
- Read-side query helpers live in `src/server/queries/<area>.ts`, take `organizationId` first, and return plain serializable objects.
- Humanized, contractor-style language everywhere user-facing: "Alex searched the web for…", "Hire", "Replace", "Performance review" — never "agent executed tool".
- Keep files focused (< ~400 lines). Comment the *why*, not the *what*.
- Dates: store UTC; display with `date-fns`.

## Verifying your work
- Typecheck: `npx tsc --noEmit -p .` — other agents may be mid-edit in parallel, so **only fix errors in files you own**; ignore errors elsewhere (mention them in your report if they look like contract mismatches).
- Tests: `npx vitest run tests/<your-area>` — tests use the `ai_staffing_agency_test` DB in Simulated mode. Use `createTestOrg()` (`tests/helpers/factory.ts`, returns `{ organization, user, session, cleanup }`) and `makeJobSpec` / `makeBlueprint` / `createHiredWorker` (`tests/helpers/fixtures.ts`) for isolation; always `cleanup()`. Never assert on global table counts. Call engine functions directly (`executeRun(runId)`) rather than relying on the background executor, and ALWAYS pass `organizationId` to `claimNextRun` / `tickScheduler` / `recoverStaleRuns` in tests (other agents share this DB). Pass `persist: false` tracking only in pure unit tests.
- Do **not** start `next dev` / `next build` unless your task says so (parallel agents share the port and `.next/`).
- The project path contains spaces (`AI Staffing Agency`) — quote paths in shell commands.
