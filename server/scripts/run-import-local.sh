#!/usr/bin/env bash
set -euo pipefail

# Local mirror of the prod data set: raw materials + packaging +
# dropdown fixup, all targeted at your local SQLite. Defaults to the
# org name "Vita Dev Server" — pass ``--org "Other Name"`` to retarget.
#
# DOES NOT touch your production database. ``DATABASE_URL`` is
# explicitly unset so settings.py falls back to ``db.sqlite3``.
#
# Usage from the ``server/`` directory:
#
#     ./scripts/run-import-local.sh               # uses "Vita Dev Server"
#     ./scripts/run-import-local.sh --org "Foo"   # targets a different org

cd "$(dirname "$0")/.."

VENV_PY=".venv/bin/python"
VENV_PIP=".venv/bin/pip"

if [ ! -x "${VENV_PY}" ]; then
    echo "[error] no venv at .venv/ — run: python3 -m venv .venv" >&2
    exit 1
fi

ORG_NAME="Vita Dev Server"
if [ "${1:-}" = "--org" ] && [ -n "${2:-}" ]; then
    ORG_NAME="$2"
fi

echo "[step 0/4] target org: ${ORG_NAME}"
echo "[step 1/4] syncing dependencies..."
"${VENV_PIP}" install -q -r requirements/base.txt

# Belt-and-suspenders: clear DATABASE_URL so the local SQLite path
# in settings.py kicks in even if the caller's shell has a stray
# value left over from a prod import session.
unset DATABASE_URL

export VITA_IMPORT_ORG="${ORG_NAME}"
export DJANGO_DEBUG=True

echo "[step 2/4] importing raw materials into local SQLite..."
"${VENV_PY}" manage.py shell <scripts/import_raw_materials.py

echo
echo "[step 3/4] importing packaging into local SQLite..."
"${VENV_PY}" manage.py shell <scripts/import_packaging.py

echo
echo "[step 4/4] promoting dropdown attribute definitions..."
"${VENV_PY}" manage.py shell <scripts/fix_raw_material_dropdowns.py

echo
echo "============================================================"
echo "Local catalogue mirror complete for org: ${ORG_NAME}"
echo "Reload http://localhost:3000 — raw materials + packaging"
echo "should match production, with dropdowns rendered correctly."
