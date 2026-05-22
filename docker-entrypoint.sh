#!/bin/sh
set -e

echo "[entrypoint] starting RelayOS container at $(date -u +%FT%TZ)"
echo "[entrypoint] NODE_ENV=$NODE_ENV BOOT_MODE=${BOOT_MODE:-all}"

# Run migrations (knex retries connection internally; still tolerate transient DNS failures)
echo "[entrypoint] running database migrations..."
MIGRATION_ATTEMPTS=0
MAX_MIGRATION_ATTEMPTS=5
until node node_modules/.bin/knex migrate:latest --knexfile knexfile.js --env production; do
  MIGRATION_ATTEMPTS=$((MIGRATION_ATTEMPTS + 1))
  if [ "$MIGRATION_ATTEMPTS" -ge "$MAX_MIGRATION_ATTEMPTS" ]; then
    echo "[entrypoint] migrations failed after $MAX_MIGRATION_ATTEMPTS attempts — starting app anyway"
    break
  fi
  echo "[entrypoint] migration attempt $MIGRATION_ATTEMPTS failed; retrying in 5s..."
  sleep 5
done

echo "[entrypoint] migrations complete; starting app..."
exec node dist/index.js
