#!/bin/bash
# Runs once on an empty PostgreSQL data volume.
set -euo pipefail

: "${AWS_DB_PASSWORD:?AWS_DB_PASSWORD is required}"
: "${RENDER_DB_PASSWORD:?RENDER_DB_PASSWORD is required}"
: "${AWS_DB_NAME:?AWS_DB_NAME is required}"
: "${RENDER_DB_NAME:?RENDER_DB_NAME is required}"
: "${AWS_DB_USER:?AWS_DB_USER is required}"
: "${RENDER_DB_USER:?RENDER_DB_USER is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${AWS_DB_USER}') THEN
      CREATE ROLE ${AWS_DB_USER} LOGIN PASSWORD '${AWS_DB_PASSWORD}';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RENDER_DB_USER}') THEN
      CREATE ROLE ${RENDER_DB_USER} LOGIN PASSWORD '${RENDER_DB_PASSWORD}';
    END IF;
  END
  \$\$;
EOSQL

if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${AWS_DB_NAME}'" --username "$POSTGRES_USER" | grep -q 1; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "CREATE DATABASE ${AWS_DB_NAME} OWNER ${AWS_DB_USER};"
fi

if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${RENDER_DB_NAME}'" --username "$POSTGRES_USER" | grep -q 1; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -c "CREATE DATABASE ${RENDER_DB_NAME} OWNER ${RENDER_DB_USER};"
fi

# Create application objects as the application role. This keeps table and
# sequence ownership consistent with the credentials the services use.
PGPASSWORD="$AWS_DB_PASSWORD" psql -v ON_ERROR_STOP=1 --username "$AWS_DB_USER" --dbname "$AWS_DB_NAME" -f /schemas/aws-schema.sql
PGPASSWORD="$RENDER_DB_PASSWORD" psql -v ON_ERROR_STOP=1 --username "$RENDER_DB_USER" --dbname "$RENDER_DB_NAME" -f /schemas/render-schema.sql
PGPASSWORD="$AWS_DB_PASSWORD" psql -v ON_ERROR_STOP=1 --username "$AWS_DB_USER" --dbname "$AWS_DB_NAME" -f /schemas/aws-seed.sql
PGPASSWORD="$RENDER_DB_PASSWORD" psql -v ON_ERROR_STOP=1 --username "$RENDER_DB_USER" --dbname "$RENDER_DB_NAME" -f /schemas/render-seed.sql

echo "Databases initialized: ${AWS_DB_NAME}, ${RENDER_DB_NAME}"
