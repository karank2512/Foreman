# Deployment

How to run Foreman in production: what the pieces are, how to configure them, how to release, and
what to do when something breaks. Threat model, key handling and incident response live in
[`docs/SECURITY.md`](./SECURITY.md).

---

## 1. Architecture

Three processes and one database. Nothing is held in memory between requests — every decision, lease and
checkpoint is a row — so each tier scales on its own.

```
            ┌──────────────┐        ┌────────────────────────────┐
  users ──▶ │  web (N)     │ ─────▶ │                            │
            │  next start  │        │   PostgreSQL 14+           │
            │  EXECUTOR_   │        │   (managed, PITR on)       │
            │  MODE=off    │        │                            │
            └──────────────┘        │   Run queue · leases ·     │
                                    │   checkpoints · usage      │
            ┌──────────────┐        │                            │
            │  worker (N)  │ ─────▶ │                            │
            │  dist/       │        └────────────────────────────┘
            │  worker.cjs  │
            └──────────────┘
                   │
                   └─▶ model providers (or the deterministic mock in Simulated mode), tools
```

**web** — the Next.js app (`output: "standalone"`). Stateless; run as many replicas as you like behind a load
balancer. It never executes runs in production: `EXECUTOR_MODE=off` keeps `src/instrumentation.ts` from starting
the in-process executor, so scaling the web tier does not silently scale run concurrency.

**worker** — `src/worker.ts`, bundled to `dist/worker.cjs`. Claims queued runs, drives them through the
blueprint, recovers crashed leases, ticks the scheduler and runs the maintenance sweeps (retention, rate-limit
buckets, stale heartbeats). It always executes; `EXECUTOR_MODE` only governs the web process.

**database** — PostgreSQL 14 or later. It is the queue, the lease manager and the ledger. There is no Redis and
no message broker to operate.

Local development runs the same two processes: `npm run dev` starts the Next.js server and a worker side by side (`scripts/dev.mjs`). The web process never executes runs in any environment — it only enqueues them.

---

## 2. Environment reference

Every variable is validated at boot by `src/server/env.ts`. A bad value stops the worker immediately (exit code
78, `EX_CONFIG`) and, in production, stops the web process too — a misconfigured deploy fails fast instead of
failing on the first request that needs the missing value. `.env.example` is the annotated master copy.

### Required everywhere

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `postgres://…`. Add `sslmode=require` and `connection_limit` in production (§5). |
| `AUTH_SECRET` | `openssl rand -base64 32`. ≥ 32 chars in production. Rotating it signs everyone out. |
| `CREDENTIAL_ENCRYPTION_KEY` | base64 of exactly 32 bytes: `openssl rand -base64 32`. Encrypts the org credentials vault. |

### Required in production

| Variable | Notes |
|---|---|
| `NODE_ENV=production` | Turns on JSON logging, https cookie rules, the closed-signup default and the demo-seed guard. |
| `AUTH_URL` | The public origin, `https://app.example.com`. Pins Auth.js callbacks instead of trusting `X-Forwarded-Host`. |
| `APP_VERSION` | Git sha baked in at image build; reported by `/api/health` and on every log line's deploy. |

`RATE_LIMIT_DISABLED` is **rejected** in production, as is a `DATABASE_URL` containing `sslmode=disable`.

### Commonly set

| Variable | Default | Notes |
|---|---|---|
| `EXECUTOR_MODE` | `off` in prod, `inline` in dev | `inline` makes `npm run dev` start a worker alongside the web server; `off` starts the web server alone. The deployed web process never executes runs either way. |
| `EXECUTOR_CONCURRENCY` | `2` | Runs in flight per worker process. Total parallelism = replicas × this. |
| `EXECUTOR_POLL_MS` | `1000` | Queue poll interval. |
| `EXECUTOR_STALE_LOCK_MS` | `120000` | A `RUNNING` run with no heartbeat for this long is recovered (costs one attempt). |
| `SHUTDOWN_GRACE_MS` | `20000` | Drain window on SIGTERM. **Must be below** the orchestrator's termination grace period. |
| `SIGNUP_MODE` | `closed` in prod | `open` \| `invite` \| `closed`. |
| `SIGNUP_INVITE_CODE` | — | ≥ 12 chars; required when `SIGNUP_MODE=invite`. |
| `TRUSTED_PROXY_HOPS` | `1` in prod | Number of proxies whose `X-Forwarded-For` entries you trust for rate limiting. |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` in prod | |
| `SERVICE_NAME` | `web` | Set to `worker` on the worker so one log stream is filterable. |
| `RETENTION_TRACE_DAYS` | `30` | Model prompts/responses and step payloads are cleared after this (§9). |
| `RETENTION_EVENTS_DAYS` | `365` | Activity + security events are deleted after this. |
| `PLATFORM_*` | see `.env.example` | Per-run and per-org spend ceilings. |
| `ALLOW_DEMO_SEED` | unset | Required before the demo seed will touch a production database. See §10. |
| `FORCE_SIMULATED` | unset | Forces the deterministic mock provider. With no provider key set, Simulated mode is the default. |

Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `TAVILY_API_KEY`) are
optional. **Without them the product runs fully, in clearly badged Simulated mode.** That is the right default
for a demo and the wrong default for paying customers: if you intend real model calls, confirm the badge is gone
after the first deploy.

---

## 3. First deploy

1. **Provision Postgres.** Create the database and pin its clock (§5.2). Turn on point-in-time recovery.
2. **Generate secrets.** `openssl rand -base64 32` twice, for `AUTH_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`.
   Store them in your platform's secret manager. Escrow the encryption key **separately from database backups**:
   whoever holds both holds the customer credentials.
3. **Build the image.** `docker build --build-arg APP_VERSION=$(git rev-parse --short HEAD) .`
4. **Run migrations** as a one-shot job, before any new code starts:
   `npx prisma migrate deploy` (in the image: `docker run --rm --env-file .env IMAGE npx prisma migrate deploy`).
5. **Start web.** Wait for `/api/ready` to return 200 before putting it in the load balancer rotation.
6. **Start the worker.** It is idle until the first run is queued.
7. **Create the first account.** There is no bootstrap admin on purpose. Either:
   - set `SIGNUP_MODE=open` (or `invite` with a `SIGNUP_INVITE_CODE`), sign up at `/sign-up`, then set
     `SIGNUP_MODE=closed` and redeploy; or
   - seed nothing and have an existing owner invite colleagues from **Settings → Members** (invite links are
     shown to the inviting admin to share — there is no email provider in Phase 1).
8. **Verify.** `/api/health` → 200, `/api/ready` → 200 with `checks.migrations: "ok"`, hire a worker, run it once,
   and check the run reaches `SUCCEEDED`.

### Release order for every subsequent deploy

```
build image → migrate job (must succeed) → roll worker → roll web
```

Migrations first because both tiers assume the schema is at least as new as their code. Workers before web so a
run started by the old code is finished by a process that understands it. Never put `migrate deploy` in a
container's `CMD`: N replicas would race, and Prisma's advisory lock turns that into N failed containers.

---

## 4. Containers

`Dockerfile` builds one image with three roles:

| Role | Command | Notes |
|---|---|---|
| web | `node server.js` (default `CMD`) | Next.js standalone server on `$PORT` (3000). |
| worker | `node dist/worker.cjs` | `STOPSIGNAL SIGTERM`; give it ≥ 30 s to stop. |
| migrate | `npx prisma migrate deploy` | One-shot release job. |

It runs as the non-root `node` user and carries a `HEALTHCHECK` against `/api/health`. `.dockerignore` keeps
`.env*`, `.git`, `node_modules` and test fixtures out of the build context, so nothing secret is ever baked in —
the image is configured entirely through the environment.

### Docker Compose on your own machine

`docker-compose.yml` runs the whole product on one machine with zero configuration. It is the quickstart in the
README, and it is meant for **your own machine**, not the internet. It needs Docker with Compose v2.24 or newer
(any current Docker Desktop); nothing else has to be installed on the host:

```bash
git clone https://github.com/karank2512/Foreman.git && cd Foreman
cp .env.example .env     # optional: set ONE provider key. No key = Simulated mode.
docker compose up        # first run builds the image; then open http://localhost:3000
```

| Service | What it does |
|---|---|
| `db` | Postgres 16, clock pinned to UTC, data in the `pgdata` volume. Published on `127.0.0.1:5433` so `npm run dev` can use it too. |
| `setup` | One-shot; web and worker wait for it to succeed. Generates the secrets on first boot, runs `prisma migrate deploy`, and seeds the demo workspace if it does not exist yet (`dist/seed-demo.cjs`, so a restart never wipes it). A failed demo seed is logged and does not block start-up. |
| `web` | `node server.js` on `127.0.0.1:${WEB_PORT:-3000}`. |
| `worker` | `node dist/worker.cjs`, which executes every run. |

What it does for you, and how to change it:

- **Secrets.** `docker/entrypoint.sh` generates `AUTH_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` once, into the
  `secrets` volume, and loads them into every service. A non-empty value in `.env` always wins. The entrypoint
  only does this when `FOREMAN_SECRETS_FILE` is set, which only the compose file does: the image run anywhere
  else behaves as described above and generates nothing.
- **`.env` is optional** (`required: false`). When it exists every service reads it, which is how provider keys
  and any other setting reach the containers. `DATABASE_URL` always points at `db`, whatever `.env` says.
- **Local defaults**, each overridable in `.env`: `AUTH_URL=http://localhost:$WEB_PORT`, `SIGNUP_MODE=open`,
  `DEMO_MODE=true` (`false` also skips the demo seed), `APP_VERSION=local`. `ALLOW_DEMO_SEED=true` is set on the
  `setup` job only, never on web or worker.
- **Ports** are bound to `127.0.0.1`. Change them with `WEB_PORT` and `POSTGRES_PORT` in `.env`.

It runs with `NODE_ENV=production` and the same hardening as a real deployment. The only differences for plain
http come from `AUTH_URL`, never from a separate "insecure" switch:

- Session cookies lose the `__Secure-` prefix and the `Secure` flag because `AUTH_URL` is `http://`
  (`src/server/auth/index.ts`). An `https://` `AUTH_URL` keeps both.
- `src/server/env.ts` accepts an `http://` `AUTH_URL` in production only for `localhost`, `127.0.0.1` and `[::1]`.
- With an `http://` `AUTH_URL`, the middleware answers only requests whose `Host` is a loopback name or the
  `AUTH_URL` host, and gives everything else `421` (`src/server/security/local-host.ts`). The stack has open
  sign-up and your provider key behind it, and a web page you visit could otherwise rebind its own domain to
  127.0.0.1 and drive it from your browser (DNS rebinding). An `https://` `AUTH_URL` skips the check.
- The page CSP leaves out `upgrade-insecure-requests` when `AUTH_URL` is `http://` (`src/middleware.ts`).
  Safari's engine applies it even on localhost, so every script would be requested over https and the page would
  never hydrate. Every other directive is unchanged. The HSTS header is still sent; browsers ignore it over http.
- With no proxy in front, Next.js sets `X-Forwarded-For` to the connecting address. On this stack that is
  Docker's gateway, so all local traffic shares one rate-limit bucket. That is fine for one machine.

The demo workspace always runs Simulated, whatever keys are set (`isOrgSimulated` in `src/server/models`), so its
scheduled workers never spend a real key. Sign-up is open and the demo password is public, so do not expose this
stack as it is. To serve other people,
put it behind https and follow §3: an `https://` `AUTH_URL`, `SIGNUP_MODE=closed` or `invite`,
`DEMO_MODE=false`, and a managed database.

Day to day:

```bash
docker compose logs -f web worker        # what the app and the worker are doing
docker compose logs setup db             # why the one-shot setup (secrets, migrations, demo seed) failed
docker compose up -d                     # after editing .env: recreates the containers with the new values
docker compose run --rm --no-deps --entrypoint node web dist/smoke-live.cjs   # check your provider key(s)
git pull && docker compose up --build    # update to the latest version (migrations run in `setup`)
docker compose down                      # stop; your data stays in the volumes
docker compose down -v                   # stop and DELETE the database and the generated secrets
```

For development with Node instead, `docker compose up -d db` starts only the database, and
`npm run setup:local` writes a `.env` pointing at a separate `foreman_dev` database on it, reusing the stack's
generated secrets if it has run (see the README). Stop the app containers first (`docker compose stop web worker`):
both want port 3000.

### Vercel for web, worker elsewhere

The web tier deploys to Vercel unchanged. Two things to get right:

- Set `EXECUTOR_MODE=off`. Serverless functions freeze between requests, so runs must be executed by a worker deployed elsewhere
  mid-flight — and it is the production default anyway.
- Vercel cannot host the worker: it is a long-lived process. Run `dist/worker.cjs` on Fly.io, Render, Railway,
  ECS or any box with `systemd`, pointed at the same `DATABASE_URL`. Give it a SIGTERM grace period above
  `SHUTDOWN_GRACE_MS`, and set `SERVICE_NAME=worker`.
- Run `prisma migrate deploy` from a release command / pre-deploy hook, not from the build step.
- Set `SERVER_ACTIONS_ALLOWED_ORIGINS` to your public host, and set the same
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` on every instance — separately built instances otherwise fail to decrypt
  each other's Server Action payloads.

---

## 5. Database

### 5.1 Connection pooling

Each process opens a Prisma pool of `num_cpus × 2 + 1` connections unless you say otherwise, which is how a
modest fleet exhausts the default `max_connections = 100`.

- web: `connection_limit=5` … `10` per replica.
- worker: `connection_limit` ≥ `EXECUTOR_CONCURRENCY × 2 + 2` — a run holds its heartbeat, its slice writes and
  its usage increments at the same time.
- Keep `Σ (replicas × connection_limit)` under ~80 % of `max_connections`.

Example: `postgresql://app:…@host:5432/app?schema=public&connection_limit=10&pool_timeout=20&sslmode=require`

With PgBouncer in **transaction** mode, add `pgbouncer=true` to the pooled URL and give
`prisma migrate deploy` a direct URL instead. Interactive transactions and `SELECT … FOR UPDATE` work in
transaction mode; do not introduce session-level advisory locks, which do not.

### 5.2 Pin the clock to UTC

The app stores UTC and several queries compare stored timestamps against `now()`. `DATABASE_URL` carries
`options=-c%20TimeZone%3DUTC`, but PgBouncer in transaction mode does not forward startup parameters — it either
rejects the connection or, with `ignore_startup_parameters=options`, silently drops the pin. Set it on the
database instead, once:

```sql
ALTER DATABASE foreman SET timezone TO 'UTC';  -- your database's name
```

Also set `TZ=UTC` in the containers: worker cadence hours ("every weekday at 09:00") are evaluated in the
process's local timezone, so a host on another zone runs scheduled workers at the wrong hour.

### 5.3 TLS and least privilege

Require TLS: `sslmode=require`, or `sslmode=verify-full` with `sslrootcert=` pointed at your provider's CA —
`verify-full` is the only setting that actually prevents a man-in-the-middle.

Use two roles. `app_migrator` owns the schema and is used only by the migrate job. `app_runtime` is what web and
worker connect with and has no DDL rights:

```sql
GRANT CONNECT ON DATABASE foreman TO app_runtime;  -- your database's name
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
```

Add guardrails to the runtime URL's `options`: `-c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000`.
Never set `PRISMA_LOG=query` in production — it logs SQL with parameters.

### 5.4 Backups and restore

- Managed Postgres with PITR (7–30 days) plus a daily encrypted snapshot in a different account or region.
- **Rehearse the restore quarterly.** A backup you have never restored is a hypothesis.
- Restore drill: provision from the snapshot, point a scratch deploy at it, run `prisma migrate deploy`
  (it is idempotent), and check `/api/ready`.
- `CREDENTIAL_ENCRYPTION_KEY` is not in the database. Restoring a backup without it gives you every table and no
  readable customer credential. Store it separately and confirm it is in your escrow before you need it.

### 5.5 Zero-downtime migrations

Old and new code overlap during a rollout, so every migration must be readable by both. Expand, then contract:

1. Release A: add nullable columns / new tables / new indexes. Deploy code that writes both shapes.
2. Backfill in batches.
3. Release B: start reading the new shape.
4. Release C: drop the old column, add the `NOT NULL`.

Index a large table with `CREATE INDEX CONCURRENTLY` in a hand-written migration whose file contains only that
statement (Prisma wraps everything else in a transaction, and `CONCURRENTLY` cannot run inside one). Migrations
are forward-only: roll back by deploying the previous image, not by reversing the schema.

CI fails if `prisma/schema.prisma` has drifted from `prisma/migrations`, and if `src/generated/migrations.json`
is stale — that manifest is what `/api/ready` compares against the database.

---

## 6. Health checks

| Endpoint | Probe | Checks |
|---|---|---|
| `GET /api/health` | liveness | Process only — no database. Returns `{status, version, uptimeS}`. |
| `GET /api/ready` | readiness | `SELECT 1` within 2 s; `_prisma_migrations` has no unfinished or rolled-back rows; every migration this build expects is applied. 503 otherwise. |

Both are unauthenticated and `no-store`. `/api/ready` names *which* check failed but never why — the reason is in
the logs. It also reports executor liveness from `ExecutorHeartbeat` as information; it never fails on it,
because the web tier can serve perfectly well while no worker is running.

Suggested settings: liveness every 15 s with 3 failures before a restart; readiness every 5 s, and only
`/api/ready` gates load-balancer rotation.

The worker has no HTTP surface. Watch it through its `ExecutorHeartbeat` row (`seenAt` within ~5 minutes) and
through queue depth.

---

## 7. Scaling

**Multiple workers are safe by construction.** `claimNextRun` is a guarded `updateMany` on `status = QUEUED`, so
exactly one executor wins a row. Every subsequent write to that run is fenced on
`{ id, status: RUNNING, lockedBy }`, so an executor that has lost its lease cannot write anything. Stale-lease
recovery guards on the exact `heartbeatAt` it read, and the scheduler on the exact `nextRunAt` it read.

- Max parallel runs = `worker replicas × EXECUTOR_CONCURRENCY`. Raise replicas before concurrency: it gives you
  failure isolation as well as throughput.
- Scale the web tier for traffic; it has nothing to do with run capacity.
- **Keep the hosts' clocks in sync (NTP).** Lease staleness compares one host's `new Date()` against another
  host's `heartbeatAt`. Skew beyond ~30 s can re-queue a live run. The run is fenced, so nothing is corrupted,
  but it costs an attempt.
- `SHUTDOWN_GRACE_MS` below the platform's termination grace period. On SIGTERM the worker stops claiming, waits
  out the grace period, and hands every remaining lease back to the queue **without consuming a retry attempt**.
  A SIGKILL instead means waiting `EXECUTOR_STALE_LOCK_MS` for recovery *and* burning one of the run's two
  attempts — two deploys in a row would fail the run.

---

## 8. Observability

Logs are one JSON object per line on stdout (`src/server/log`), which is what a log shipper wants. Every record
carries `time`, `level`, `msg` and its bindings — `service`, `component`, `executorId`, `runId`, `orgId`.
Secrets are scrubbed on the way out and stack traces are omitted in production.

```json
{"time":"2026-09-22T19:35:09.9Z","level":"info","msg":"run.claimed","service":"worker","component":"executor","executorId":"host-1-g1-a1b2c3","runId":"run_x"}
```

`instrumentation.ts` logs every request error with its `digest` — the same digest the error page shows the user,
which is how you turn a user's screenshot into a log line.

Alert on:

| Signal | Query |
|---|---|
| Readiness failing | `/api/ready` ≠ 200 on any replica for > 1 min |
| No live executor | `max(seenAt)` in `ExecutorHeartbeat` older than 5 min while runs are `QUEUED` |
| Queue backing up | `count(Run where status='QUEUED' and availableAt < now() - 5 min)` |
| Run failure rate | `FAILED / (SUCCEEDED + FAILED)` over 1 h, per org |
| Spend | `OrgSpendMonth` approaching `Organization.monthlyBudgetUsd` |

---

## 9. Data retention

The worker sweeps at most every 10 minutes (idempotent, so several workers sweeping is harmless):

| Data | Policy |
|---|---|
| `ModelCall.request` / `.response` | Cleared after `RETENTION_TRACE_DAYS` (30). Tokens, cost, latency are kept. |
| `RunStep.input` / `.output` (finished runs) | Cleared after `RETENTION_TRACE_DAYS`. Titles and timings are kept, so the run timeline still renders. |
| `ActivityEvent`, `SecurityEvent` | Deleted after `RETENTION_EVENTS_DAYS` (365). |
| `RateLimitBucket` | Deleted once idle for 2 days. |
| `ExecutorHeartbeat` | Deleted once stale for 5 minutes. |
| `UsageRecord` | **Never deleted** — it is the billing ledger. |

Prompts and tool outputs contain whatever a customer asked a worker to read, which is why they are the part that
expires. Everything is batched (1,000 rows per statement) so a sweep never holds locks long enough to block a
run. Deleting an organization cascades to all of its tenant rows.

---

## 10. Demo deployments

`npm run db:seed:demo` rebuilds the Acme Robotics workspace, including an account whose password is published in
the README. It **refuses to run** when `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true`, and the workspace it
creates is flagged `isDemo` so the UI can badge it.

`npm run setup` is migrations only — the seed is deliberately not on any release path. Use `npm run setup:dev`
locally when you want both.

If you do run a public demo: understand that the password is known, keep it in its own database, and never set
`ALLOW_DEMO_SEED` on a deployment that has real customers.

---

## 11. Key rotation

Full procedures are in [`docs/SECURITY.md`](./SECURITY.md). In short:

- **`AUTH_SECRET`** — put the old value in `AUTH_SECRET_PREVIOUS`, deploy, wait out the session lifetime, then
  drop the previous value. Rotating without the overlap signs every user out.
- **`CREDENTIAL_ENCRYPTION_KEY`** — put the old value in `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` so existing rows
  stay readable while new writes use the new key. Rotating *without* the previous value makes every stored
  customer credential permanently unreadable; they would have to be re-entered by hand.
- Provider API keys — swap the environment variable and redeploy. Nothing is cached across processes.

Rotate immediately if a value ever reaches a log, a ticket or a laptop that is no longer trusted.
