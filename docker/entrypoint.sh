#!/bin/sh
# Entrypoint for the self-hosted Docker stack (docker-compose.yml) — what makes `docker compose up` zero-config.
#
# The first container to start generates AUTH_SECRET and CREDENTIAL_ENCRYPTION_KEY into the secrets volume;
# every later start reuses them, so sessions and the credentials vault survive restarts and rebuilds. A value
# set in .env or the environment always wins over the generated one.
#
# It only acts when FOREMAN_SECRETS_FILE is set (docker-compose.yml sets it), so the image behaves exactly as
# before anywhere else: a real deployment gets its secrets from the platform, and nothing is generated.
set -eu

if [ -n "${FOREMAN_SECRETS_FILE:-}" ]; then
  if [ ! -e "$FOREMAN_SECRETS_FILE" ]; then
    umask 077
    tmp="$FOREMAN_SECRETS_FILE.$$.tmp"
    node -e '
      const { randomBytes } = require("node:crypto");
      const key = () => randomBytes(32).toString("base64");
      process.stdout.write(`AUTH_SECRET=${key()}\nCREDENTIAL_ENCRYPTION_KEY=${key()}\n`);
    ' > "$tmp"
    # A hard link fails if the file already exists, so if two containers race exactly one set of keys survives.
    if ln "$tmp" "$FOREMAN_SECRETS_FILE" 2>/dev/null; then
      echo "foreman: generated AUTH_SECRET and CREDENTIAL_ENCRYPTION_KEY (stored in the secrets volume)"
    fi
    rm -f "$tmp"
  fi

  # Parsed, never sourced: only the two known keys are read, and only when the caller has not set them.
  while IFS= read -r line || [ -n "$line" ]; do
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      AUTH_SECRET)
        if [ -z "${AUTH_SECRET:-}" ]; then export AUTH_SECRET="$value"; fi
        ;;
      CREDENTIAL_ENCRYPTION_KEY)
        if [ -z "${CREDENTIAL_ENCRYPTION_KEY:-}" ]; then export CREDENTIAL_ENCRYPTION_KEY="$value"; fi
        ;;
    esac
  done < "$FOREMAN_SECRETS_FILE"
fi

exec "$@"
