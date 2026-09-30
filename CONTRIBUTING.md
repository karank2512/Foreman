# Contributing to Foreman

Thanks for helping. Foreman is a self-hosted, Apache-2.0-licensed app: people run it on their own machines with their own AI provider keys, or with none in Simulated mode. Keep that in mind with every change. It has to work with zero keys, and it must never spend someone's tokens without metering and a cap.

The rules the code follows (tenancy scoping, server-side permissions, immutable worker versions, the model gateway, Simulated mode) are in [CLAUDE.md](CLAUDE.md). Read it even if you don't use Claude Code.

## Development setup

You need Node 22+ and Postgres 14+. If you don't have Postgres, the compose file can run just the database for you, published on `localhost:5433`.

```bash
git clone https://github.com/karank2512/Foreman.git && cd Foreman
docker compose up -d db     # skip if you have your own Postgres
npm install
npm run setup:local         # writes .env: secrets, DATABASE_URL for a foreman_dev db on the compose Postgres (:5433), local defaults
npm run setup:dev           # migrations + demo seed
npm run dev                 # web + worker on http://localhost:3000
```

- `npm run setup:local` never overwrites a value that's already in `.env`. If you use your own Postgres, edit `DATABASE_URL` afterwards. If you've run the Docker stack on this machine, it copies that stack's generated secrets instead of making new ones, and its `foreman_dev` database keeps your dev data apart from the Docker app's.
- `npm run dev` starts the Next.js server and the run worker together (`scripts/dev.mjs`). Runs are always executed by the worker; the web server only enqueues them. Use `npm run dev:web` or `npm run worker` to start one half.
- `npm run dev` listens on `localhost` only and stops if port 3000 is taken (for example by the Docker stack: `docker compose stop web worker`). `npm run dev -- -p 3001` picks another port, and `AUTH_URL` follows it. To reach it from another device, bind all interfaces and name the address people will use, since a plain-http app only answers the host in `AUTH_URL` or localhost: `AUTH_URL=http://<your-lan-ip>:3000 npm run dev -- -H 0.0.0.0`. Sign-up is open and the demo password is public, so only do that on a network you trust.
- With `DEMO_MODE=true`, the sign-in page offers *Explore the demo workspace*. `npm run db:seed:demo` rebuilds it.
- Leave the provider keys empty to work in Simulated mode, which is how you'll do most development. To check a real provider, add your key to `.env` and run `npm run smoke:live` (one tiny call per model the key would serve, up to three). A key exported in your shell wins over `.env`.

## Tests

Tests run against a separate database whose name must contain `_test`. The suite refuses to run otherwise. Migrations are applied automatically at the start of each run, provider keys are cleared and rate limits are off, so tests are hermetic and always run in Simulated mode.

One-time setup:

```bash
# create the test database: with the compose db…
docker compose exec db createdb -U app foreman_test
# …or with a local Postgres
createdb foreman_test

cp .env.test.example .env.test
# then edit DATABASE_URL in .env.test to point at foreman_test, e.g. for the compose db:
# postgresql://app:app@localhost:5433/foreman_test?schema=public&options=-c%20TimeZone%3DUTC
```

Then:

```bash
npm test                          # the whole suite
npx vitest run tests/runtime      # one area
npm run typecheck && npm run lint
```

Writing tests:

- Isolate every test in its own organization with `createTestOrg()` from `tests/helpers/factory.ts`, and call `cleanup()` when you're done. `tests/helpers/fixtures.ts` has `makeJobSpec`, `makeBlueprint` and `createHiredWorker`.
- Don't assert on global table counts, because other suites share the database.
- Call engine functions directly (`executeRun(runId)`) instead of waiting on a background executor, and pass `organizationId` to `claimNextRun`, `tickScheduler` and `recoverStaleRuns`.
- New behaviour needs a Simulated-mode test. A feature that only works with a real key isn't finished.

## Code style

- TypeScript strict mode, named exports, `@/` imports. Default exports only for Next.js pages, layouts and route files.
- Server code lives in `src/server/<module>/` and exposes its API from `index.ts`. Follow the dependency direction in [docs/CONTRACTS.md](docs/CONTRACTS.md).
- Server actions return `ActionResult<T>` and never throw to the client. Read-side queries live in `src/server/queries/`, take `organizationId` first and return plain JSON.
- UI follows [docs/DESIGN.md](docs/DESIGN.md) and [src/components/README.md](src/components/README.md). User-facing text reads like managing a contractor ("Hire", "Replace", "Alex searched the web for…").
- Comment the *why*. Keep files under roughly 400 lines.
- Schema changes need a committed migration: edit `prisma/schema.prisma` and run `npx prisma migrate dev --name <change>` against your own dev database.
- New environment variables go in `.env.example` (annotated) and `src/server/env.ts` (validated), with a default that works locally with no keys.

## Proposing a change

1. **Open an issue first** for anything larger than a bug fix, so we can agree on the approach before you write it.
2. **Branch from `main`** and keep the PR to one concern.
3. **Before you push:** `npm run typecheck`, `npm run lint` and `npm test` all pass, and you've tried the change in the app (`npm run dev`) in Simulated mode.
4. **In the PR description,** say what changed and why, how you tested it, and whether it touches a shared contract (`src/server/domain`, `*/types.ts`, the Prisma schema) or adds an environment variable or dependency. Add screenshots for UI changes.
5. CI runs migrations, typecheck, lint, tests, both production builds and the dependency audit on every PR, then validates `docker-compose.yml` and builds the Docker image.

Never commit `.env`, real API keys or generated secrets. **Security issues** go through a private security advisory on GitHub, not a public issue (see [docs/SECURITY.md](docs/SECURITY.md#5-reporting-a-vulnerability)).

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), as described in its section 5.
