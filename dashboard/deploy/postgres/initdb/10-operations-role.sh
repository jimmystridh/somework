#!/bin/sh
# Runs once, when the data directory is empty: the role Operations signs in with (no superuser, owns its database only).
set -eu
password="$(cat /run/secrets/operations-db-password)"
psql -v ON_ERROR_STOP=1 -v app_password="$password" --username postgres --dbname postgres <<'SQL'
CREATE ROLE operations LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE operations OWNER operations;
REVOKE ALL ON DATABASE operations FROM PUBLIC;
SQL
