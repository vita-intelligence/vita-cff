#!/usr/bin/env bash
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*"; }

if [ -n "${DATABASE_URL:-}" ]; then
    log "Waiting for database to accept connections..."
    python - <<'PYEOF'
import os
import sys
import time

try:
    import psycopg  # psycopg3
except ImportError:
    print("[entrypoint] psycopg not installed; skipping DB wait")
    sys.exit(0)

url = os.environ["DATABASE_URL"]
deadline = time.time() + 60
last_err = None
while time.time() < deadline:
    try:
        with psycopg.connect(url, connect_timeout=3):
            print("[entrypoint] Database is up")
            sys.exit(0)
    except Exception as exc:
        last_err = exc
        time.sleep(2)
print(f"[entrypoint] Timed out waiting for database: {last_err}")
sys.exit(1)
PYEOF
fi

log "Applying migrations..."
python manage.py migrate --noinput

log "Collecting static files..."
python manage.py collectstatic --noinput --clear || \
    log "collectstatic skipped (STATIC_ROOT not configured yet — non-fatal)"

log "Starting: $*"
exec "$@"
