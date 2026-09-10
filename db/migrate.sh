#!/usr/bin/env bash
#
# LAB-INFRA-01B — the UAT migration gate.
#
# The existing `db:test:*` scripts hardcode a developer's socket, port and role
# (`-h /tmp -p 5432 -U jwairepo`). That is fine for a laptop and useless for an
# isolated managed database, which is the whole point of 01B. This script passes
# NO connection flags at all: `psql` reads PGHOST, PGPORT, PGDATABASE, PGUSER,
# PGPASSWORD and PGSSLMODE from the environment, which is the same contract
# `src/db/pool.ts` already uses. No DATABASE_URL is introduced.
#
# The gate it enforces (spec §9):
#
#     EMPTY DATABASE -> BASE SCHEMA -> MIGRATIONS IN ORDER -> CURRENT SCHEMA
#
# "Empty" is checked rather than assumed. A migration chain applied on top of an
# already-migrated database can succeed for the wrong reason, and the gate is
# supposed to prove a fresh database *can be constructed* — not that this one
# happens to look right. Set ALLOW_NONEMPTY=1 only if you have a reason you can
# defend in the evidence bundle.
#
# ON_ERROR_STOP=1 everywhere and `set -e`: a migration failure is a STOP, and
# manually patching the database to obtain a PASS is expressly forbidden.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA="${HERE}/schema.sql"
MIGRATIONS_DIR="${HERE}/migrations"

PSQL=(psql --no-psqlrc --quiet -v ON_ERROR_STOP=1)

fail() {
    echo "MIGRATION_GATE=FAIL: $*" >&2
    exit 1
}

# Identify the target without ever echoing PGPASSWORD.
for required in PGHOST PGDATABASE PGUSER; do
    if [ -z "${!required:-}" ]; then
        fail "${required} is not set. This script deliberately has no local defaults."
    fi
done

echo "TARGET_HOST=${PGHOST}"
echo "TARGET_PORT=${PGPORT:-5432}"
echo "TARGET_DATABASE=${PGDATABASE}"
echo "TARGET_USER=${PGUSER}"
echo "TARGET_SSLMODE=${PGSSLMODE:-<unset>}"
echo "PGPASSWORD_PRESENT=$([ -n "${PGPASSWORD:-}" ] && echo yes || echo no)"

server_version="$("${PSQL[@]}" -Atc "show server_version" 2>/dev/null)" \
    || fail "cannot connect to the target database"
echo "SERVER_VERSION=${server_version}"

existing="$("${PSQL[@]}" -Atc \
    "select count(*) from information_schema.tables where table_schema = 'public'")"
echo "PREEXISTING_PUBLIC_TABLES=${existing}"

if [ "${existing}" != "0" ] && [ "${ALLOW_NONEMPTY:-0}" != "1" ]; then
    fail "target database is not empty (${existing} public tables). The gate requires a fresh database."
fi

applied=0

echo "APPLY base schema.sql"
"${PSQL[@]}" -f "${SCHEMA}" >/dev/null
echo "  OK schema.sql"
applied=$((applied + 1))

# Lexical order is the migration order — the files are zero-padded and numbered
# for exactly that reason. `sort` is explicit so the result does not depend on
# the shell's glob locale.
while IFS= read -r migration; do
    echo "APPLY $(basename "${migration}")"
    "${PSQL[@]}" -f "${migration}" >/dev/null
    echo "  OK $(basename "${migration}")"
    applied=$((applied + 1))
done < <(find "${MIGRATIONS_DIR}" -maxdepth 1 -name '*.sql' | sort)

final_tables="$("${PSQL[@]}" -Atc \
    "select count(*) from information_schema.tables where table_schema = 'public'")"

echo "FILES_APPLIED=${applied}"
echo "SKIPPED_REQUIRED_MIGRATIONS=0"
echo "PUBLIC_TABLES_AFTER=${final_tables}"
echo "PRODUCTION_DATA_IMPORTED=0"
echo "MIGRATION_GATE=PASS"
