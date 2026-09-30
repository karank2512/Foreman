# syntax=docker/dockerfile:1.7
#
# One image, three roles (docs/DEPLOYMENT.md):
#   web      → node server.js            (default CMD; Next.js standalone server)
#   worker   → node dist/worker.cjs      (the run executor)
#   migrate  → npx prisma migrate deploy (one-shot release job, run before rolling web/worker)
#
# docker-compose.yml (self-hosting on your own machine) additionally uses docker/entrypoint.sh, which generates the
# app secrets on first boot, and dist/seed-demo.cjs, which seeds the demo workspace once. Neither runs unless the
# compose file asks for it. dist/smoke-live.cjs is `npm run smoke:live` for people without Node on the host:
#   docker compose run --rm --no-deps --entrypoint node web dist/smoke-live.cjs
#
# Debian slim rather than Alpine: Prisma's query engine ships a glibc/OpenSSL 3 binary, so this avoids adding a
# musl binaryTarget to the frozen schema.

# ── base ────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── deps: full dependency tree for building ─────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm npm ci

# ── build: next build + the worker bundle ───────────────────────────────────────
FROM deps AS build
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY . .
# The migration manifest (npm prebuild) is what /api/ready compares against the database.
RUN npx prisma generate \
 && npm run build \
 && npm run build:worker \
 && npx esbuild docker/seed-demo.ts --bundle --platform=node --target=node22 --format=cjs --packages=external \
      --tsconfig=tsconfig.json --outfile=dist/seed-demo.cjs \
 && npx esbuild scripts/smoke-live.ts --bundle --platform=node --target=node22 --format=cjs --packages=external \
      --tsconfig=tsconfig.json --outfile=dist/smoke-live.cjs

# ── prod-deps: runtime dependency tree (no devDependencies) ─────────────────────
# The worker bundle and the prisma CLI both resolve from here; the standalone server overlays its traced copies.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
 && npx prisma generate

# ── runner ──────────────────────────────────────────────────────────────────────
FROM base AS runner
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=UTC \
    SERVICE_NAME=web \
    EXECUTOR_MODE=off

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/.next/standalone ./
COPY --from=build     --chown=node:node /app/.next/static ./.next/static
COPY --from=build     --chown=node:node /app/public ./public
COPY --from=build     --chown=node:node /app/dist ./dist
# schema + migrations for the release job
COPY --from=build     --chown=node:node /app/prisma ./prisma
COPY --from=build     --chown=node:node /app/docker/entrypoint.sh ./docker/entrypoint.sh

# Next writes its ISR/image cache here. /var/lib/foreman is where the compose stack keeps its generated secrets:
# a fresh named volume inherits this directory's owner, so the non-root user can write it. The entrypoint is
# normalised in case a Windows checkout gave it CRLF line endings.
RUN mkdir -p .next/cache /var/lib/foreman \
 && chown -R node:node .next /var/lib/foreman \
 && chmod 700 /var/lib/foreman \
 && sed -i 's/\r$//' docker/entrypoint.sh

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM

# Liveness only: /api/health touches no database, so a probe never queues behind a slow query.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
