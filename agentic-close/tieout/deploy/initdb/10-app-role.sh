#!/bin/sh
# Runs once when the Postgres volume is created: an ordinary login role for the application.
# It owns the schema objects it migrates; FORCE ROW LEVEL SECURITY (migration 0003) still applies to it.
set -eu
psql -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE tieout_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_password';
GRANT CONNECT ON DATABASE tieout TO tieout_app;
GRANT USAGE, CREATE ON SCHEMA public TO tieout_app;
EOSQL
