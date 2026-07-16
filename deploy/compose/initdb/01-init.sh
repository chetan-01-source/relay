#!/bin/bash
# Runs once on first Postgres boot (empty data dir). Creates:
#   - the logto database (relay DB is created by POSTGRES_DB)
#   - relay_app: non-superuser app role the gateway connects as (RLS applies to it)
#   - relay_admin: platform-admin role (RLS platform_admin_access policy)
# pgvector extension is enabled in the relay DB.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  -- separate database for Logto
  SELECT 'CREATE DATABASE logto'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'logto')\gexec

  -- app + admin roles (passwords from env)
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'relay_app') THEN
      CREATE ROLE relay_app LOGIN PASSWORD '${RELAY_APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'relay_admin') THEN
      CREATE ROLE relay_admin LOGIN PASSWORD '${RELAY_APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE relay TO relay_app, relay_admin;

  -- pgvector in the relay DB
  CREATE EXTENSION IF NOT EXISTS vector;

  -- default privileges so migrations (run as postgres) grant table access to the app role
  GRANT USAGE ON SCHEMA public TO relay_app, relay_admin;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relay_app, relay_admin;
SQL

echo "[initdb] relay + logto databases, relay_app/relay_admin roles, pgvector ready."
