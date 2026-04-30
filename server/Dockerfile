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

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "config.asgi:application"]
