#!/usr/bin/env bash
set -euo pipefail

# One-shot packaging import runner. Same prompt-and-go flow as
# run-import.sh, just driving the packaging Excel sheet into the
# ``packaging`` catalogue of the production org.
#
# Usage from the ``server/`` directory:
#
#     ./scripts/run-import-packaging.sh

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

echo "[step 3/3] running import_packaging.py against production..."
"${VENV_PY}" manage.py shell <scripts/import_packaging.py
