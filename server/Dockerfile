# ============================================================
# Stage 1 — build Python wheels with toolchain available
# ============================================================
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY requirements/base.txt .
RUN pip wheel --wheel-dir=/wheels -r base.txt

# ============================================================
# Stage 2 — slim runtime image
# ============================================================
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    DJANGO_SETTINGS_MODULE=config.settings

# Runtime libraries only:
#   libpq5                — PostgreSQL client used by psycopg
#   libpango / harfbuzz   — required by WeasyPrint to render PDFs
#   curl                  — used by the container HEALTHCHECK
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libharfbuzz-subset0 \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home --shell /bin/bash app

WORKDIR /app

COPY --from=builder /wheels /wheels
COPY requirements/base.txt requirements/base.txt
RUN pip install --no-index --find-links=/wheels -r requirements/base.txt \
    && rm -rf /wheels

COPY --chown=app:app . .

# Pre-create the directories the entrypoint writes to (collectstatic
# output, uploaded media fallback) and hand the entire app root to the
# unprivileged user. Without this chown the ``app`` user can read its
# files (they were copied with --chown above) but can't ``mkdir`` new
# children of ``/app`` because ``/app`` itself remains root-owned.
RUN chmod +x /app/docker/entrypoint.sh \
    && mkdir -p /app/staticfiles /app/media \
    && chown -R app:app /app

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/healthz/" || exit 1

# ``WEB_CONCURRENCY`` defaults to 2 in-image. The hard cap on how high
# this can go is the Azure Postgres connection budget: each worker
# opens its own psycopg connection pool of size ``DB_POOL_MAX_SIZE``
# (default 5, see settings.py). Total live connections =
# WEB_CONCURRENCY * DB_POOL_MAX_SIZE; 2 * 5 = 10 stays well under the
# Burstable-plan ceiling (~48 non-superuser slots). Bump both env
# vars together when moving to a larger plan.
#
# Multi-worker uvicorn replaces single-process daphne so a slow PDF
# render or blocking DB query on one request no longer stalls every
# other user behind it -- but the actual prod failure was Postgres
# slot exhaustion, not Daphne saturation. The pool is the load-
# bearing fix; multi-worker is the secondary improvement.
#
# Notes:
# - ``--proxy-headers`` + ``--forwarded-allow-ips=*`` honour Azure's
#   front-door X-Forwarded-For so request.META carries the real client
#   IP (the audit log, CSRF, JWT cookie scoping all depend on this).
# - ``--lifespan off`` skips ASGI lifespan events; Django doesn't
#   implement them and uvicorn defaults to ``auto`` which warns.
# - WebSocket fan-out across workers needs ``CHANNEL_LAYER_URL`` set
#   to a Redis DSN (already wired in settings.py). Without it each
#   worker has its own ``InMemoryChannelLayer`` and broadcasts only
#   reach clients on the same worker -- harmless for HTTP, degraded
#   for the comments live channel.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["sh", "-c", "exec uvicorn config.asgi:application --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-2} --proxy-headers --forwarded-allow-ips=* --lifespan off"]
