#!/usr/bin/env bash
set -euo pipefail

# Role-split deployments restore global role definitions and run an explicit
# owner migrator. Never assign the runtime username database/schema ownership
# on an empty replacement volume merely because it appears in the service env.
case "${REPLYNEST_DB_RUNTIME_SPLIT_ENABLED:-false}" in
  true) printf 'application_databases=explicit_role_restore_or_owner_migration_required\n'; exit 0 ;;
  false) ;;
  *) echo 'ERROR: invalid REPLYNEST_DB_RUNTIME_SPLIT_ENABLED' >&2; exit 1 ;;
esac

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${CHATWOOT_POSTGRES_DATABASE:?CHATWOOT_POSTGRES_DATABASE is required}"
: "${CHATWOOT_POSTGRES_USERNAME:?CHATWOOT_POSTGRES_USERNAME is required}"
: "${CHATWOOT_POSTGRES_PASSWORD:?CHATWOOT_POSTGRES_PASSWORD is required}"
: "${REPLYNEST_POSTGRES_DATABASE:?REPLYNEST_POSTGRES_DATABASE is required}"
: "${REPLYNEST_POSTGRES_USERNAME:?REPLYNEST_POSTGRES_USERNAME is required}"
: "${REPLYNEST_POSTGRES_PASSWORD:?REPLYNEST_POSTGRES_PASSWORD is required}"

psql --username "$POSTGRES_USER" --dbname postgres \
  --set=chatwoot_user="$CHATWOOT_POSTGRES_USERNAME" \
  --set=chatwoot_password="$CHATWOOT_POSTGRES_PASSWORD" \
  --set=chatwoot_database="$CHATWOOT_POSTGRES_DATABASE" \
  --set=replynest_user="$REPLYNEST_POSTGRES_USERNAME" \
  --set=replynest_password="$REPLYNEST_POSTGRES_PASSWORD" \
  --set=replynest_database="$REPLYNEST_POSTGRES_DATABASE" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'chatwoot_user', :'chatwoot_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'chatwoot_user') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'replynest_user', :'replynest_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'replynest_user') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'chatwoot_database', :'chatwoot_user') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'replynest_database', :'replynest_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'replynest_database') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'chatwoot_database') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'replynest_database') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'chatwoot_database', :'chatwoot_user') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'replynest_database', :'replynest_user') \gexec
SQL

for database in "$CHATWOOT_POSTGRES_DATABASE" "$REPLYNEST_POSTGRES_DATABASE"; do
  owner="$CHATWOOT_POSTGRES_USERNAME"
  [[ "$database" == "$REPLYNEST_POSTGRES_DATABASE" ]] && owner="$REPLYNEST_POSTGRES_USERNAME"
  psql --username "$POSTGRES_USER" --dbname "$database" --set=owner="$owner" <<'SQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'owner') \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'owner') \gexec
SQL
done

printf 'application_databases=initialized chatwoot=%s replynest=%s\n' \
  "$CHATWOOT_POSTGRES_DATABASE" "$REPLYNEST_POSTGRES_DATABASE"
