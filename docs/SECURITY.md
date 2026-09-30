# Security

Principle: **treat every AI worker as an untrusted contractor, and every input — including model output, fetched web pages and anything a client sends — as hostile.** No control relies on a system prompt. Every rule is enforced server-side, inside the module that owns the data.

This document describes what is *implemented*, with file pointers, plus the runbooks and the risks we are knowingly carrying. Audit finding ids (`F-…`, `INF-…`, `OPS-…`) refer to the production-readiness audits for this phase.

---

## 1. Threat model

**Assets.** Tenant business data (jobs, specs, deliverables, run traces, chat), stored tool credentials, model spend (real money on platform keys), and platform integrity/availability.

**Trust boundaries.**

| Boundary | Crossing | Treated as |
|---|---|---|
| Browser → app | Server actions, route handlers, Auth.js | Hostile input; session identity is re-read from the database on every request |
| App → model provider | `src/server/models/**` only | Untrusted output; nothing it returns is an instruction |
| Model → tools | `tools.invoke()` only | Every call re-authorized against the worker version's grants |
| Tool → internet | `src/server/tools/net-guard.ts`, `guarded-http.ts` | SSRF-hostile; addresses re-checked at connect time |
| Web page → model context | `fetch_url` / `web_search` output | Data, never instructions (indirect prompt injection) |

**Adversaries.**

- *Unauthenticated attacker*: credential stuffing, session forgery, IDOR probing, DoS on expensive endpoints.
- *Authenticated tenant (malicious or compromised)*: cross-tenant reads, cost abuse, privilege escalation inside the workspace.
- *Hostile web content*: a page that tells the worker to exfiltrate what it has collected, or to poison a deliverable.
- *The worker itself (excessive agency)*: runaway loops, unbounded spend, unintended external side effects.
- *Operator error / supply chain*: leaked keys, vulnerable dependencies, a misconfigured deployment.

---

## 2. Controls

### 2.1 Identity and sessions

- Auth.js v5 credentials provider; bcrypt (cost `config.auth.bcryptRounds`), identical failure message for unknown-user and wrong-password, and a timing-equalizer hash so a missing account costs the same as a wrong password — `src/server/auth/authorize.ts`.
- JWT sessions: 12 h sliding, 7 d absolute, `sessionVersion` in the token. `loadSessionContext` re-reads the user on every request and rejects a token whose `sessionVersion` is behind, or whose user is disabled — `src/server/auth/session-context.ts`. A password change, "sign out everywhere", a role change or a removal bumps it, which revokes every existing cookie.
- Sign-in throttling and lockouts (F-002): 5 failures / 15 min per `sha256(email)` and 30 / 15 min per client IP, then an exponential lockout (window × 2^n, capped at 24 h). Both are checked *before* the password compare, and the account rule is applied whether or not the account exists, so lockouts are not an account oracle — `src/server/security/rate-limit.ts` + `src/server/auth/authorize.ts`.
- Self-serve sign-up is gated by `SIGNUP_MODE` (`open` / `invite` / `closed`, closed by default in production). Invitations are single-use, expiring, and stored as `sha256(token)` — `src/server/account/**`.
- The demo workspace is refused at sign-in unless `DEMO_MODE=true` (F-001).

### 2.2 Authorization and tenant isolation

- Every query and mutation is scoped by `organizationId` taken from the session, never from the request. A child resource is verified through `where: { id, organizationId }`; a mismatch is `NOT_FOUND`, never `FORBIDDEN` — no existence oracle. Ids are `cuid()`.
- Roles (MEMBER / ADMIN / OWNER) are enforced inside the server modules with `assertCan(session, permission)` — `src/server/auth/permissions.ts`. The UI only *hides* what you may not do; the server *refuses* it. Deciding an approval for an `external_write` tool re-reads the deciding user's role from the database.
- Route handlers answer `401`/`404` JSON instead of redirecting, and never leak whether an id exists in another workspace — `src/app/api/runs/[runId]/route.ts`, `src/app/(app)/deliverables/[deliverableId]/download/route.ts`.

### 2.3 Rate limits, spend caps and the kill switch

- One Postgres-backed fixed-window limiter (`RateLimitBucket`), one atomic `INSERT … ON CONFLICT DO UPDATE` per hit, so counts are correct across instances and concurrent requests — `src/server/security/rate-limit.ts`. Rules: sign-in (account/IP), sign-up, invite accept/create, password change, LLM per user and per org, runs per org, credentials per org, and the run-page poll endpoint (429 + `Retry-After`).
- Failure policy: **auth rules fail closed**, everything else fails open and logs. The whole limiter is a no-op when `RATE_LIMIT_DISABLED=1` (refused in production by `env.ts`).
- Monthly **real** spend per workspace is tracked in `OrgSpendMonth` (UTC month, atomic increment) and enforced against `Organization.monthlyBudgetUsd ?? PLATFORM_DEFAULT_MONTHLY_BUDGET_USD` — `src/server/security/budget.ts`. Simulated runs cost nothing and are never blocked.
- `assertOrgActive` is the operator kill switch (`Organization.suspendedAt`): no runs, no LLM calls.
- Both checks are repeated as a backstop immediately before every LIVE model call, so a code path that forgets them still cannot spend — `src/server/models/index.ts`.
- Per-run ceilings (cost, tool calls, duration) are clamped to platform maxima by `clampRunLimits`, and per-worker/per-org in-flight run caps live in the runtime queue.

### 2.4 The worker as an untrusted contractor

- **Single choke point.** `tools.invoke()` is the only execution path: registry lookup → Zod validation → `authorize` (tool in the blueprint *and* a non-revoked grant for this worker version) → approval check by `toolCallId` → execute → usage record. The runtime and the UI never call a tool's `execute()` — `src/server/tools/invoke.ts`.
- **Approvals.** `send_notification` (`sideEffect: "external_write"`) defaults to requiring approval; the run pauses and a human sees the exact payload. Only an `APPROVED` row for *that* `ToolCall` in *that* workspace lets it run; `PENDING`, `REJECTED`, `EXPIRED` and "no row" all refuse. Regression test: `tests/security/tool-provenance.test.ts`.
- **SSRF.** Scheme and port allow-lists, DNS resolution with private/reserved/metadata ranges blocked, redirects capped and re-validated per hop, and the *connection* re-checked at connect time so DNS rebinding cannot reach a blocked address — `src/server/tools/net-guard.ts`, `guarded-http.ts`.
- **Exfiltration via `fetch_url` (F-010).** In live mode a URL is capped at 2,048 characters, its fragment is stripped, and the host must have *provenance* in this run: it appeared in this run's own `web_search` results, or literally in the job brief / spec / this run's instructions. Anything else is refused with a `TOOL_ERROR` telling the model to search first — `src/server/tools/provenance.ts`. Simulated mode is unaffected.
- **No dynamic execution.** No `eval`, no `Function()`, no shelling out; `calculator` is a hand-written expression parser.
- **Bounded context.** Tool outputs are size-capped and schema-validated before re-entering the model context; trace payloads are clipped field-by-field.

### 2.5 Output safety

- Markdown is parsed into an AST and rendered as React elements — no HTML string is ever produced, no `dangerouslySetInnerHTML`, and link targets are restricted to `http(s)`, `mailto:` and same-site paths — `src/lib/markdown.ts`, `src/components/markdown.tsx`.
- The parser is hardened against pathological input (INF-17): no quadratic regexes, bounded look-ahead and recursion, a 2,000-character per-line block-scan limit and a 200 KB document cap. Regression tests assert a time budget on adversarial input — `tests/security/markdown.test.ts`.
- CSV output escapes formula prefixes (`= + - @`, tab, CR).
- Deliverable downloads are served inert: `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`, and a sanitized ASCII `filename` plus RFC 5987 `filename*` — `src/app/(app)/deliverables/[deliverableId]/download/route.ts`.

### 2.6 Browser and transport

- Static headers on every response (HSTS in production, `nosniff`, `X-Frame-Options: DENY`, referrer, permissions, COOP, CORP, no `X-Powered-By`) — `next.config.ts`.
- A per-request nonce-based **Content-Security-Policy** with `strict-dynamic`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` and `upgrade-insecure-requests` in production — `src/server/security/csp.ts` + `src/middleware.ts`. Redirect and 401 responses get an inert deny-all policy. `style-src` keeps `'unsafe-inline'` because React SSR emits style attributes and the toast library injects a stylesheet; there is no raw-HTML rendering path, so that residual is small.
- A **DNS-rebinding guard** for the self-hosted stack on plain `http://localhost`: when `AUTH_URL` is `http://`, the middleware answers only requests whose `Host` is a loopback name or the `AUTH_URL` host and returns `421` for anything else, so a website the owner visits cannot rebind its domain to 127.0.0.1 and sign up or run workers on the owner's key — `src/server/security/local-host.ts` + `src/middleware.ts`. `https://` deployments skip it. `npm run dev` also binds to `localhost` rather than every interface.
- Server actions: Next.js origin checking (do not add a wildcard `SERVER_ACTIONS_ALLOWED_ORIGINS`) plus a 256 KB body limit. Every export of a `"use server"` file is a public endpoint, so `tests/security/server-actions.test.ts` asserts that each one is an async function that starts from `requireSession()` (with a named allow-list for sign-in, sign-up, invite acceptance and sign-out), and that route handlers export `GET` only (F-017).

### 2.7 Secrets

- Tool credentials are encrypted with AES-256-GCM under `CREDENTIAL_ENCRYPTION_KEY`. The envelope is `v2:<kid>:<iv>:<tag>:<ciphertext>`, where `kid` identifies the key and the GCM **AAD binds the ciphertext to `organizationId:name`** — moving a row to another workspace or renaming it makes it undecryptable (F-014) — `src/server/secrets/crypto.ts`.
- Values are never logged, never returned by any list endpoint, and `last4` is only kept for values of 12+ characters.
- A credential that cannot be decrypted does **not** fall back to the platform env key (that would silently spend the platform's own key): the tool drops to Simulated mode and the operator sees `secrets.unreadable_credential` — `src/server/secrets/vault.ts`.
- `setCredential` / `deleteCredential` require `credentials.manage` (ADMIN), are rate limited per workspace, and write `CREDENTIAL_SET` / `CREDENTIAL_DELETED` audit events carrying the credential *name* only.
- Model-provider keys are process-wide environment variables, never per-tenant in Phase 1. `env.ts` refuses to boot in production with a missing/weak `AUTH_SECRET`, a bad `CREDENTIAL_ENCRYPTION_KEY`, a non-HTTPS `AUTH_URL` or a database URL without TLS.

### 2.8 Audit trail and logging hygiene

- `SecurityEvent` records sign-ins, throttles, lockouts, sign-outs, password and role changes, invitations, credential changes, rate-limit blocks and budget stops. It stores `sha256(email)` — never the address — the client IP, a 256-character user agent, and metadata with secret-looking keys and values scrubbed — `src/server/security/audit.ts`. `recordSecurityEvent` never throws.
- The client IP is read from the **right** of `X-Forwarded-For` using `TRUSTED_PROXY_HOPS`, never the leftmost (client-controlled) value — `src/server/security/request.ts`.
- Logs are structured JSON lines with clipped, `redactSecrets`-scrubbed fields; error *objects* are never logged whole (Prisma metadata can contain row values) — `src/server/security/log.ts`, `redact.ts`.
- Tenant-facing errors never carry internals: `runAction` passes through only the AppError codes whose message is written for users, and turns everything else into one generic sentence plus a `(ref xxxxxx)` that appears in the log line — `src/lib/action-result.ts`, `src/server/security/public-error.ts`. Provider text (request ids, echoed prompts, keys) stays in `ModelCall.error` and `AppError.details`, scrubbed.

### 2.9 Retention

`RETENTION_TRACE_DAYS` (default 30) clears `ModelCall` request/response payloads; `RETENTION_EVENTS_DAYS` (default 365) deletes activity and security events; rate-limit buckets idle for two days are swept (`sweepRateLimits`). The maintenance tick runs them — `src/server/maintenance/**`.

---

## 3. Runbooks

### 3.1 Rotating `CREDENTIAL_ENCRYPTION_KEY`

1. Generate a key: `openssl rand -base64 32`.
2. Deploy with `CREDENTIAL_ENCRYPTION_KEY=<new>` **and** `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=<old>`. Both old (`v1`/`v2`) and new rows decrypt; new writes use the new key.
3. Re-encrypt every stored credential: `reencryptAll()` from `@/server/secrets` (idempotent, batched; rows already on the active key are skipped). It reports `{ scanned, reencrypted, failed }`.
4. Confirm `failed === 0`, then remove `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` and redeploy. Any `failed` row must be re-entered by a workspace admin in Settings.
5. Keep an offline escrow copy of the key, separate from database backups — losing it means losing every stored credential.

### 3.2 Rotating `AUTH_SECRET`

Deploy with the new secret; Auth.js accepts an array, so keep the previous value in `AUTH_SECRET_PREVIOUS` for one release to avoid signing everyone out, then drop it. To force a global sign-out instead, increment every `User.sessionVersion`.

### 3.3 Suspending a workspace / stopping spend

`UPDATE "Organization" SET "suspendedAt" = now() WHERE id = '…';` — runs stop being claimed, LLM calls refuse, the UI explains why. To cap instead of stop, set `monthlyBudgetUsd`.

### 3.4 Incident response

1. **Contain.** Suspend the affected workspace (3.3). For a suspected credential compromise, delete the credential and rotate the provider key at the provider.
2. **Revoke sessions.** Increment `sessionVersion` for the affected users (all sessions for that user stop on their next request).
3. **Assess.** `listSecurityEvents(organizationId)` for the actor's trail (sign-ins, IPs, credential and role changes); `ModelCall` / `ToolCall` / `ActivityEvent` for what the worker did; `UsageRecord` and `OrgSpendMonth` for spend.
4. **Find the error.** A user-reported `(ref xxxxxx)` appears verbatim in the JSON log line that carries the real cause.
5. **Rotate.** `CREDENTIAL_ENCRYPTION_KEY` (3.1), `AUTH_SECRET` (3.2), provider keys, and the database password if the host was reachable.
6. **Record.** Timeline, blast radius (which workspaces, which data), fix, and the regression test that keeps it fixed.

---

## 4. Residual risks (honest list)

- **Indirect prompt injection is mitigated, not solved.** Provenance limits *where* data can go, approvals gate *sending*, and tool output is bounded — but a hostile page can still steer a worker's reasoning and poison a deliverable's content. Human review of deliverables remains the real control.
- **No per-tenant provider keys.** All live model spend runs on platform keys, bounded by the monthly budget and the run limits. A tenant that exhausts its budget stops; the platform still carries the cost until billing exists.
- **No self-service password reset.** There is no email provider in this phase. An owner-initiated reset (or a support-assisted one) is the only path; invitations are shared as links by the inviting admin.
- **No 2FA / SSO.** Passwords only. A stolen password gives full workspace access until the session version is bumped.
- **`style-src 'unsafe-inline'`.** Required by React SSR style attributes and the toast library; scripts are nonce-only.
- **Rate limits are per-subject, not per-network.** A distributed attacker with many IPs can still spread sign-in attempts across accounts; the per-account rule is the backstop.
- **Trace payloads contain tenant data** (prompts, fetched page text) until the retention sweep clears them. Access to the database is access to that data.
- **`simulated` mode is the default everywhere.** It is safe by construction, but it also means the live paths get less production mileage; treat the first live deployment as a fresh surface.
- **Deliverable content is not scanned for malware**; it is worker-generated text served inert and never executed.

---

## 5. Reporting a vulnerability

For Foreman itself, open a private security advisory at https://github.com/karank2512/Foreman/security/advisories/new. If you run your own deployment, route reports to whoever operates it. Include: what you found, how to reproduce it, what you could access, and whether any tenant data was involved. Please do not open a public issue, do not test against workspaces that are not yours, and do not run denial-of-service tests against shared infrastructure. We aim to acknowledge within two business days and to ship a fix or a mitigation before any public disclosure; we are happy to credit you.

---

## 6. Verifying the controls

```bash
npx vitest run tests/security     # limiter windows/lockouts/concurrency, CSP, redaction, budget, provenance, routes
npx vitest run tests/auth tests/tools tests/platform/secrets.test.ts
npm run audit:prod                # dependency advisories (expected: 0)
curl -sI https://<host>/ | grep -Ei 'content-security-policy|strict-transport|x-frame|x-content-type'
```

After a deploy, load one page per route group with the browser console open and confirm there are no CSP violations (charts, dialogs and toasts are the ones worth checking), and confirm `/api/health` and `/api/ready` are reachable without a session while every other route redirects or 401s.
