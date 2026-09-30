---
name: foreman-setup
description: Set up and run Foreman (the self-hosted staffing agency for AI workers) on this machine. Checks for Docker (or Node 22+ and Postgres), creates .env from .env.example, explains Simulated mode vs bringing your own Anthropic / OpenAI / Google Gemini / Tavily API key, starts the stack, waits for http://localhost:3000/api/ready, opens the app and shows how to confirm Live vs Simulated. Use when someone says "/foreman-setup", "set up Foreman", "install Foreman", "run Foreman locally", "get this running", "start the app", "docker compose up isn't working", "add my API key", "switch from Simulated to live", "why is it still Simulated", or reports port 3000 / 5433 conflicts or an invalid API key.
---

# Foreman setup

You're helping someone run Foreman on their own machine. Foreman is open source and self-hosted. With no API key it runs in a built-in, clearly badged **Simulated mode** that costs nothing. With their own key, usage is billed to *their* provider account. Get them to a working app at http://localhost:3000 as quickly as possible, then help them choose a mode.

Run commands from the repo root and quote paths, because the folder may contain spaces.

## Rules for API keys (non-negotiable)

- **Never ask for an API key in chat.** Never echo, print, `cat` or `grep` out a key's value, and never write a key into any file yourself.
- The person pastes their key into `.env` themselves, in their own editor. You may open `.env` in their editor for them (for example `open -e .env` on macOS or `code .env`).
- To check whether a key is set, count matching lines without showing values. For example, `grep -cE '^(ANTHROPIC|OPENAI|GOOGLE_GENERATIVE_AI)_API_KEY="?[A-Za-z0-9]' .env` prints how many model keys are set (`TAVILY_API_KEY` works the same way). Never run anything that shows the right-hand side.
- If they paste a key into the chat anyway, don't repeat it. Ask them to put it in `.env` themselves, and suggest rotating it in their provider's console, because it's now in a chat transcript.
- Don't read `.env` with the Read tool or `cat`. Use targeted `grep -c` checks like the one above.

## 1. Pick a path: Docker (preferred) or Node

Check Docker first:

```bash
docker --version && docker compose version && docker info --format '{{.ServerVersion}}'
```

- If all three succeed, check that `docker compose version` reports **v2.24 or newer**: the compose file's optional `.env` (`env_file` with `required: false`) needs it, and older versions fail with a parse error. If it's older, ask them to update Docker Desktop (or the `docker-compose-plugin` package on Linux).
- With a new enough Compose, use the **Docker path**. No Node or Postgres is needed on the host.
- If `docker` exists but `docker info` fails, the daemon isn't running. Ask them to start Docker Desktop (or `sudo systemctl start docker` on Linux) and re-check.
- If there's no Docker, check the **Node path**: `node --version` (needs v22 or later) and Postgres 14+ (`psql --version`, `pg_isready`). Without Postgres, suggest installing Docker just for the database (`docker compose up -d db`), or a local Postgres (`brew install postgresql@16` on macOS). If Node is older than 22, point them to https://nodejs.org or `nvm install 22`.

## 2. Create `.env`

```bash
test -f .env && echo ".env exists" || cp .env.example .env
```

Never overwrite an existing `.env`. On the Docker path `.env` is optional: `docker compose up` also works without it. `AUTH_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` are generated automatically on first boot and kept in a Docker volume. Anything set in `.env` wins. On the Node path, `npm run setup:local` (step 4) fills in `.env` and never overwrites existing values.

## 3. Choose Simulated or bring-your-own-key

Explain briefly, then ask which they want:

- **Simulated (no key, free).** Workers run on a deterministic mock model and simulated tools. Every screen works, including hiring, runs, deliverables, evaluations and Replace. Nothing is billed and nothing leaves the machine. Best for a first look.
- **Your own key (live).** Set **one** of these in `.env`, whichever provider they already use:
  - `ANTHROPIC_API_KEY` (Claude)
  - `OPENAI_API_KEY` (GPT-6 Luna / GPT-6.1 Sol)
  - `GOOGLE_GENERATIVE_AI_API_KEY` (Gemini 3.5 Flash-Lite / Gemini 3.8 Flash)

  Optionally also `TAVILY_API_KEY` for live web search (https://tavily.com). Usage is billed by that provider to their account. Foreman caps spend per run and per workspace (`PLATFORM_*` in `.env.example`; the default workspace budget is $25/month). Suggest they also set a limit in the provider's console. With several keys, each tier uses the first available provider in the order Anthropic → OpenAI → Google.

If they choose a key, tell them the exact variable name and to paste the key after the `=` in `.env` themselves, then save. Confirm with the count-only `grep -c` check from the rules above. The demo workspace always stays Simulated, even with a key; live work happens in a workspace they create.

On the Node path, a key exported in their shell wins over `.env`. Check without showing values: `env | grep -cE '^(ANTHROPIC|OPENAI|GOOGLE_GENERATIVE_AI)_API_KEY=.'` (and `npm run setup:local` reports which key it sees).

## 4. Start the stack

**Docker path:**

```bash
docker compose up -d
```

The first run builds the image, which takes a few minutes. Follow progress with `docker compose ps` and `docker compose logs -f web worker` (stop following when it's up). After changing `.env` later, run `docker compose up -d` again. Compose recreates the containers whose configuration changed.

**Node path:**

```bash
docker compose up -d db     # only if they have no Postgres of their own (published on localhost:5433)
npm install
npm run setup:local         # writes .env: secrets, DATABASE_URL for a foreman_dev db on the compose Postgres (:5433), local defaults
npm run setup:dev           # migrations + demo seed
npm run dev                 # web + worker; keep this running (run it in the background)
```

If they use their own Postgres, have them edit `DATABASE_URL` in `.env` before `npm run setup:dev`. If the Docker app is already running, stop it first with `docker compose stop web worker` (keep `db`): `npm run dev` refuses to start while port 3000 is taken. `setup:local` keeps the Node app in its own `foreman_dev` database and reuses the Docker stack's generated secrets, so the two don't break each other.

## 5. Wait until it's ready, then open it

Poll readiness. Allow up to about 10 minutes on a first Docker build and about 1 minute otherwise. The port is 3000 unless they changed it: on Docker read it with `grep -E '^WEB_PORT=' .env` (a port number, not a secret); on Node it's whatever they passed to `npm run dev -- -p`. Substitute it below:

```bash
PORT=3000; for i in $(seq 1 120); do curl -fsS "http://localhost:$PORT/api/ready" >/dev/null 2>&1 && echo READY && break; sleep 5; done
```

`/api/ready` returns 200 once the database is reachable and migrated. Then open `http://localhost:<port>` (`open` on macOS, `xdg-open` on Linux, `start` on Windows). Use `localhost`, not `127.0.0.1`: sign-in redirects to `localhost` and the session cookie isn't shared between the two. Tell them:

- **Explore the demo workspace** on the sign-in page opens *Acme Robotics*, a seeded workspace with three workers, run history, deliverables and a pending approval.
- Or **create an account** at `/sign-up` to get their own empty workspace, then click **Hire** and describe a job in a sentence.

## 6. Confirm Live vs Simulated

- **Simulated:** a **Simulated** chip appears in the top navigation, and runs and deliverables carry the same badge.
- **Settings → AI providers** lists each provider as *Live* or *Simulated* and shows which model serves each tier.
- The demo workspace is always Simulated, even with a key set (it never spends a key). Check Live mode in a workspace they created.
- If they set a key but still see Simulated in their own workspace: check the key line is uncommented and non-empty (count-only `grep -c`), check `FORCE_SIMULATED` isn't set (`grep -c '^FORCE_SIMULATED=true' .env`), then restart (`docker compose up -d` on Docker; stop and rerun `npm run dev` on Node).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `port is already allocated` / `EADDRINUSE` / "Port 3000 is already in use" on 3000 | Find the process with `lsof -i :3000` and stop it (often the other path: `docker compose stop web worker`). Or use another port: on Docker set `WEB_PORT=3001` in `.env` (and `AUTH_URL=http://localhost:3001` too if `.env` sets `AUTH_URL`); on Node run `npm run dev -- -p 3001`. Then poll and open that port. |
| Port 5433 in use | Another Postgres is on it. Set `POSTGRES_PORT=5434` in `.env` (on the Node path, update `DATABASE_URL` to match). |
| `Cannot connect to the Docker daemon` | Docker isn't running. Start Docker Desktop and retry. |
| `/api/ready` returns 503 | Database not reachable or not migrated. Check `docker compose ps` and `docker compose logs setup db` (`setup` is the one-shot job that generates the secrets, migrates and seeds). On Node, check `DATABASE_URL` and rerun `npm run setup:dev`. |
| Worker exits immediately (code 78) | Invalid configuration. The log line names the bad variable (`docker compose logs worker`, or the `npm run dev` output). Fix it in `.env`. |
| A provider or key error (in the app, a run, or chat) | The message names the fix (bad key, no credits, unknown model). Check the key with one tiny call per model it would serve: `npm run smoke:live` on Node, `docker compose run --rm --no-deps --entrypoint node web dist/smoke-live.cjs` on Docker. Logs: `docker compose logs web worker` (describing a job and chat run in `web`, runs in `worker`). A model id can be overridden with `MODEL_TIER_FAST` / `MODEL_TIER_STANDARD` / `MODEL_TIER_REASONING="<provider>:<model>"`. |
| Build fails on `npm install` inside Docker | Usually network or disk space. Retry `docker compose build` and check `docker system df`. |
| Want a clean slate | Docker: `docker compose down -v` deletes the database and the generated secrets. Confirm with them first, because it can't be undone. Node: `npm run db:reset` (also destructive, confirm first). |

Before exposing Foreman to anyone other than themselves, point them to the "Before you expose it beyond localhost" section of `README.md`.
