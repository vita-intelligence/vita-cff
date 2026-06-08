#!/usr/bin/env bash
set -euo pipefail

# Read-only survey of duplicate Customer rows across every org in
# production. Prompts for the Postgres admin password, URL-encodes
# it, sets DATABASE_URL, and runs survey_customer_dupes.py against
# prod via ``manage.py shell``.
#
# Usage from the ``server/`` directory:
#
#     ./scripts/run-customer-survey.sh
#
# Mirrors the shape of run-import.sh so the prod-DB credential
# pattern is identical across operational scripts.

cd "$(dirname "$0")/.."

VENV_PY=".venv/bin/python"
VENV_PIP=".venv/bin/pip"

if [ ! -x "${VENV_PY}" ]; then
    echo "[error] no venv at .venv/ — run: python3 -m venv .venv" >&2
    exit 1
fi

echo "[step 1/3] syncing dependencies..."
"${VENV_PIP}" install -q -r requirements/base.txt

echo
echo "[step 2/3] paste your Postgres password (input is hidden):"
read -rs PG_PASSWORD
echo

ENCODED_PASSWORD=$("${VENV_PY}" -c \
    "import urllib.parse, sys; print(urllib.parse.quote(sys.stdin.read().rstrip('\n'), safe=''))" \
    <<<"${PG_PASSWORD}")

export DATABASE_URL="postgres://vitaadmin:${ENCODED_PASSWORD}@vita-npd-db.postgres.database.azure.com:5432/postgres?sslmode=require"

echo "[step 3/3] running survey_customer_dupes.py against production..."
"${VENV_PY}" manage.py shell <scripts/survey_customer_dupes.py
