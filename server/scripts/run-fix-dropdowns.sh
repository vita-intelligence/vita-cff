#!/usr/bin/env bash
set -euo pipefail

# One-shot dropdown fixup runner. Same prompt-and-go flow as
# run-import.sh — promotes raw-material attribute definitions that
# should be dropdowns (``type``, ``use_as``, compliance flags etc.)
# from TEXT → SINGLE_SELECT in-place. Item data is untouched.
#
# Usage from the ``server/`` directory:
#
#     ./scripts/run-fix-dropdowns.sh

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

echo "[step 3/3] promoting dropdown attribute definitions..."
"${VENV_PY}" manage.py shell <scripts/fix_raw_material_dropdowns.py
