"""Django settings for the Vita NPD platform."""

import os
from datetime import timedelta
from pathlib import Path

import dj_database_url
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# Load .env from the server directory if present. ``override=False`` so
# variables already set in the parent shell (e.g. via docker-compose,
# systemd unit, or CI env-block) still win — the file is a fallback for
# local dev, not an authoritative source in prod. No-op when the file
# is missing.
load_dotenv(BASE_DIR / ".env", override=False)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: list[str] | None = None) -> list[str]:
    raw = os.environ.get(name)
    if raw is None:
        return list(default or [])
    return [item.strip() for item in raw.split(",") if item.strip()]


# Security
#
# Every value below is environment-driven. The dev defaults keep
# ``runserver`` working out of the box (``DJANGO_DEBUG`` defaults to
# True); **production MUST set ``DJANGO_DEBUG=False`` and
# ``DJANGO_SECRET_KEY``** in App Service Configuration. With DEBUG
# off, a missing secret aborts boot rather than running with a known
# key — that is the safety net against a half-configured deploy.
DEBUG = _env_bool("DJANGO_DEBUG", default=True)

_DEV_SECRET_KEY = "django-insecure-paz2degn(!os0zf$fth7ag=kowl^4)ya@b7o=rh5bb)iiiz=&$"
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or (
    _DEV_SECRET_KEY if DEBUG else ""
)
if not SECRET_KEY:
    raise RuntimeError(
        "DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is False"
    )

ALLOWED_HOSTS: list[str] = _env_list(
    "DJANGO_ALLOWED_HOSTS",
    default=["localhost", "127.0.0.1", "192.168.1.170"] if DEBUG else [],
)

CSRF_TRUSTED_ORIGINS: list[str] = _env_list(
    "DJANGO_CSRF_TRUSTED_ORIGINS",
    default=[],
)

# Reverse-proxy TLS termination (Azure App Service / Front Door).
# When the upstream proxy speaks HTTPS to the client and HTTP to the
# container, Django needs to trust ``X-Forwarded-Proto`` to set
# ``request.is_secure()`` correctly — otherwise ``Secure`` cookies and
# the SSL redirect both misbehave.
if _env_bool("DJANGO_USE_X_FORWARDED_PROTO", default=False):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

SECURE_SSL_REDIRECT = _env_bool("DJANGO_SECURE_SSL_REDIRECT", default=False)
SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_SECURE_HSTS_SECONDS", "0"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = _env_bool(
    "DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS", default=False
)
SECURE_HSTS_PRELOAD = _env_bool("DJANGO_SECURE_HSTS_PRELOAD", default=False)
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"


# Production-signal safety net for ``DEBUG=True``. The default is True
# so local dev works out of the box (``runserver`` needs it), but a
# forgotten ``DJANGO_DEBUG=false`` on a prod deploy is a live incident:
# stack traces + SQL query previews leak to every 500 response, and
# the browsable DRF API is exposed to authenticated users. This check
# raises loud on any deploy that carries production signals
# (non-local ALLOWED_HOSTS, real SECRET_KEY, SSL redirect enabled)
# while ``DEBUG`` is still True — so the boot fails instead of the
# app silently running unsafe.
_LOCAL_HOST_ALLOWLIST = {"localhost", "127.0.0.1", "192.168.1.170", "0.0.0.0", "::1"}
if DEBUG:
    # SECRET_KEY isn't a prod signal — devs legitimately test with
    # real keys — so we key off configuration a dev machine never
    # sets: a real hostname in ALLOWED_HOSTS OR the SSL redirect
    # switch on.
    _has_non_local_host = any(
        host and host not in _LOCAL_HOST_ALLOWLIST for host in ALLOWED_HOSTS
    )
    if _has_non_local_host or SECURE_SSL_REDIRECT:
        raise RuntimeError(
            "DEBUG=True detected together with production signals ("
            f"non-local ALLOWED_HOSTS={_has_non_local_host}, "
            f"SECURE_SSL_REDIRECT={SECURE_SSL_REDIRECT}). "
            "Set DJANGO_DEBUG=false — otherwise every unhandled "
            "exception leaks stack traces + SQL previews to the "
            "browser and the DRF browsable API is exposed."
        )


# Applications
DJANGO_APPS = [
    # ``daphne`` takes the slot before ``django.contrib.staticfiles`` per
    # the Channels docs so ``runserver`` uses Daphne's ASGI server, which
    # is what lets WebSocket routes work in dev. The HTTP layer still
    # goes through Django's normal middleware stack — only the
    # ``websocket`` protocol branches into the Channels consumer layer.
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
]

THIRD_PARTY_APPS = [
    "channels",
    "corsheaders",
    "rest_framework",
    "rest_framework_simplejwt",
    # Persistent blacklist for rotated / logged-out refresh tokens. Ships
    # its own migration (``token_blacklist_*``) that must run once; from
    # then on ``BLACKLIST_AFTER_ROTATION=True`` will refuse to accept a
    # rotated-away refresh token and ``LogoutView`` can call
    # ``token.blacklist()`` so a stolen cookie can't outlive the session.
    "rest_framework_simplejwt.token_blacklist",
    "storages",
]

LOCAL_APPS = [
    "apps.accounts",
    "apps.organizations",
    "apps.catalogues",
    "apps.attributes",
    "apps.formulations",
    "apps.specifications",
    "apps.trial_batches",
    "apps.product_validation",
    "apps.proposals",
    "apps.customers",
    "apps.ai",
    "apps.audit",
    "apps.comments",
    "apps.cff_submissions",
    "apps.client_portal",
    "apps.label_design",
    "apps.payments",
    # PSP (Vita Manufacturing Systems' production platform) integration.
    # Owner-only settings surface + HTTP client + item picker read
    # endpoints. Config lives on ``Organization.psp_config``; this
    # app carries the client + service + API surface. Consumers
    # (formulation builder, proposal price hint) land in follow-up
    # PRs.
    "apps.psp",
    # Website (marketing site) integration. Bearer-token surface for
    # the Next.js marketing site to pull the published RTG catalogue
    # server-side. Owner-only mint / revoke through
    # ``/settings/integrations``; token verification lives in
    # ``apps.website.token_services``.
    "apps.website",
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS


# Authentication
AUTH_USER_MODEL = "accounts.User"

# Self-service staff registration is OFF by default — new staff accounts
# must come in via the invitation flow (``/api/invitations/<token>/accept/``).
# Flip ``STAFF_REGISTRATION_ENABLED=1`` in App Service Configuration to
# temporarily reopen the public ``/api/auth/register/`` endpoint without
# a redeploy. The customer-portal activation flows are unaffected.
STAFF_REGISTRATION_ENABLED = _env_bool(
    "STAFF_REGISTRATION_ENABLED", default=False
)


# Django REST Framework
# Secure-by-default: every endpoint is authenticated unless it explicitly opts
# out via ``permission_classes``. The browsable API renderer is only exposed
# while ``DEBUG`` is on so production responses are always JSON.
_DEFAULT_RENDERERS = ["rest_framework.renderers.JSONRenderer"]
if DEBUG:
    _DEFAULT_RENDERERS.append("rest_framework.renderers.BrowsableAPIRenderer")

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.accounts.auth.authentication.CookieJWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_RENDERER_CLASSES": _DEFAULT_RENDERERS,
    "DEFAULT_PARSER_CLASSES": [
        "rest_framework.parsers.JSONParser",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 25,
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
    "UNAUTHENTICATED_USER": "django.contrib.auth.models.AnonymousUser",
    "EXCEPTION_HANDLER": "config.exception_handler.codified_exception_handler",
}


# Logging
#
# Django's default ``django.request`` logger routes 5xx errors to
# :class:`django.utils.log.AdminEmailHandler`. With no ``ADMINS``
# set (and we don't set one — production alerts live in Azure, not
# in SMTP) those tracebacks land in /dev/null: uvicorn records the
# 500 in the access log, but the Python exception that caused it is
# completely invisible. That's how the second wave of 5xx after the
# X-Forwarded-For fix went undiagnosed for a full hour.
#
# Explicit console handler for ``django.request`` so every uncaught
# exception inside a request flows into the container's stdout, the
# same stream uvicorn writes to. Azure log-stream / log-download
# both pick it up.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": (
                "[%(asctime)s] %(levelname)s %(name)s "
                "(%(module)s:%(lineno)d) %(message)s"
            ),
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        },
    },
    "loggers": {
        "django.request": {
            "handlers": ["console"],
            "level": "ERROR",
            "propagate": False,
        },
        # Catch DB-level pool / cursor errors that surface outside
        # the request loop (e.g. when a connection in
        # ``InFailedSqlTransaction`` state returns to the pool and
        # the pool retry path swallows it).
        "django.db.backends": {
            "handlers": ["console"],
            "level": "WARNING",
            "propagate": False,
        },
    },
}


# simplejwt
#
# ``ACCESS_TOKEN_LIFETIME`` is deliberately long: every navigation
# from a near-expired access cookie triggers a refresh round-trip
# through the proxy + backend. With multiple users on the same
# external IP (shared WiFi) those refreshes pile up and saturate
# the single-process Daphne worker. A 60-minute window cuts refresh
# frequency 4× without weakening the security posture — the cookies
# stay httpOnly + secure, the refresh token still rotates per use,
# and every authenticated request still re-validates against the
# backend.
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=60),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    # Blacklist rotated refresh tokens so a stolen cookie stops working
    # the moment the legitimate client next refreshes. Requires the
    # ``rest_framework_simplejwt.token_blacklist`` app in
    # ``INSTALLED_APPS`` (already added above) — the ``blacklist`` +
    # ``blacklisted_token`` tables land on the next migration run.
    "BLACKLIST_AFTER_ROTATION": True,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": SECRET_KEY,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
    "AUTH_TOKEN_CLASSES": ("rest_framework_simplejwt.tokens.AccessToken",),
    "TOKEN_TYPE_CLAIM": "token_type",
}


# Cookie-based auth configuration. The frontend stores access and refresh
# tokens in httpOnly cookies; see ``apps/accounts/auth/cookies.py`` for the
# set/clear helpers that read these names.
AUTH_COOKIE_ACCESS_NAME = "vita_access"
AUTH_COOKIE_REFRESH_NAME = "vita_refresh"
# Portal (customer-facing) cookies are deliberately disjoint from
# the staff ones so the two sessions can coexist in the same
# browser without trampling each other (e.g. an operator logged
# into staff app + previewing the portal in another tab).
PORTAL_AUTH_COOKIE_ACCESS_NAME = "vita_portal_access"
PORTAL_AUTH_COOKIE_REFRESH_NAME = "vita_portal_refresh"

# Portal self-registration tenant target. Production is single-tenant
# (one active ``Organization`` row) so the resolver falls through to
# the "exactly one active org" auto-pick. Dev environments frequently
# carry multiple test tenants — set one of these env vars to tell
# self-registration which one owns new customers:
#   PORTAL_DEFAULT_ORG_ID   : preferred, immune to renames (UUID)
#   PORTAL_DEFAULT_ORG_NAME : fallback, matches on name
# The resolver in ``apps.client_portal.registration_services`` reads
# these when a customer signs up via /portal on the website.
PORTAL_DEFAULT_ORG_ID = os.environ.get("PORTAL_DEFAULT_ORG_ID") or None
PORTAL_DEFAULT_ORG_NAME = os.environ.get("PORTAL_DEFAULT_ORG_NAME") or None
AUTH_COOKIE_DOMAIN: str | None = os.environ.get("AUTH_COOKIE_DOMAIN") or None
AUTH_COOKIE_PATH = "/"
AUTH_COOKIE_SECURE = _env_bool("AUTH_COOKIE_SECURE", default=not DEBUG)
AUTH_COOKIE_HTTPONLY = True
AUTH_COOKIE_SAMESITE = os.environ.get("AUTH_COOKIE_SAMESITE", "Lax")


# CORS — cookie credentials require an explicit origin list, not a wildcard.
CORS_ALLOWED_ORIGINS = _env_list(
    "DJANGO_CORS_ALLOWED_ORIGINS",
    default=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://192.168.1.170:3000",
    ]
    if DEBUG
    else [],
)
CORS_ALLOW_CREDENTIALS = True


MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # WhiteNoise serves collected static files directly from the
    # container without needing nginx / Azure Blob in front. Sits
    # immediately after SecurityMiddleware per the WhiteNoise docs.
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # Misclick guard — must be AFTER AuthenticationMiddleware so the
    # fingerprint can include the user id (not just the IP). Catches
    # double-clicks on POST/PUT/PATCH by replaying the first
    # response for 10 s. Mirror of PSP's ``MisclickGuard`` plug so
    # behaviour is symmetric across the two services. See
    # ``config.middleware`` for the reasoning.
    "config.middleware.MisclickGuardMiddleware",
]

# Django's default is ``DENY`` which blocks ALL ``<iframe>`` /
# ``<object>`` embedding of any Django-served response — including
# inline PDF previews of artwork uploads on the labelling
# workspace. ``SAMEORIGIN`` still blocks clickjacking from foreign
# origins but lets the FE (same origin via Next's ``/api`` and
# ``/media`` rewrites) render PDF artwork inline. In prod the
# artwork comes back from Azure Blob storage so this header
# doesn't apply there anyway.
X_FRAME_OPTIONS = "SAMEORIGIN"

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
#: Channels discovers the ASGI app via ``ASGI_APPLICATION``. Our
#: ``config.asgi.application`` is a ``ProtocolTypeRouter`` that branches
#: ``http`` → Django's :class:`ASGIStaticFilesHandler` and ``websocket``
#: → the comments consumer with JWT-cookie auth middleware.
ASGI_APPLICATION = "config.asgi.application"


# Channels — WebSocket transport + inter-consumer message bus.
#
# Dev default: ``channels.layers.InMemoryChannelLayer``. Fine for
# single-process ``runserver`` and the test suite. **Production
# MUST set ``CHANNEL_LAYER_URL``** to a Redis DSN so consumers
# across multiple uvicorn workers can broadcast to each other via
# ``channels_redis`` — without it, the second uvicorn worker on
# the same instance silently ignores cross-worker WebSocket
# broadcasts (commit-feed updates, presence pings, kiosk comment
# fanout) and clients connected to the "wrong" worker only see
# events when they refetch on focus.
#
# The DSN points at DB 1 of the shared Vita Performance Redis;
# DB 0 belongs to ``vita-performance-api``, DB 2 is reserved for
# Celery's broker, DB 3 for any future Celery result backend.
CHANNEL_LAYER_URL = os.environ.get("CHANNEL_LAYER_URL")
if CHANNEL_LAYER_URL:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [CHANNEL_LAYER_URL]},
        }
    }
else:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels.layers.InMemoryChannelLayer",
        }
    }


# Django cache — shared across uvicorn workers.
#
# Without an explicit ``CACHES`` setting Django falls back to a
# per-process ``LocMemCache``, which means worker A's cache writes
# are invisible to worker B. On a 2-worker box every cached lookup
# has a ~50% miss rate, defeating the point of caching.
#
# In prod we point Django's cache at DB 4 of the shared Redis (DB 0
# is the sibling API, DB 1 Channels, DB 2 Celery broker, DB 3 the
# reserved Celery result backend). Override via ``CACHE_URL`` if a
# specific environment needs its own Redis. When neither
# ``CACHE_URL`` nor ``CHANNEL_LAYER_URL`` is set (dev / test) we
# fall back to LocMem so the test suite stays self-contained.
_CACHE_URL = os.environ.get("CACHE_URL")
if not _CACHE_URL and CHANNEL_LAYER_URL:
    # Reuse the same Redis instance, swap to DB 4 — cheap default
    # that "just works" once CHANNEL_LAYER_URL is configured.
    import re as _re_cache
    _CACHE_URL = _re_cache.sub(r"/\d+(\?|$)", r"/4\1", CHANNEL_LAYER_URL)
    if _CACHE_URL == CHANNEL_LAYER_URL:
        # URL had no explicit DB segment — append /4.
        _CACHE_URL = CHANNEL_LAYER_URL.rstrip("/") + "/4"

if _CACHE_URL:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": _CACHE_URL,
            # Per-key TTL ceiling. Individual ``cache.set(..., timeout=)``
            # calls still override; this is the safety net for any
            # cached value that forgets to set one.
            "TIMEOUT": 300,
            "KEY_PREFIX": "vita-cff",
        }
    }
else:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "vita-cff-locmem",
        }
    }


# Celery — async task queue for work that must not block a request
# (PDF rendering, email send, future MRPeasy push, etc.).
#
# Optional in dev: when ``CELERY_BROKER_URL`` is unset, every
# ``.delay()`` falls through to a synchronous in-process call via
# ``CELERY_TASK_ALWAYS_EAGER``. That keeps the test suite + a
# fresh ``runserver`` working without a Redis broker. Production
# points ``CELERY_BROKER_URL`` at DB 2 of the shared Redis (DB 1
# is Channels above) and runs a dedicated worker container with
# ``celery -A config worker``.
#
# ``CELERY_TASK_EAGER_PROPAGATES`` ensures exceptions raised inside
# an eager task surface to the caller exactly as they would on a
# real worker — otherwise tests that exercise the failure path
# would silently green-pass.
CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "")
CELERY_TASK_ALWAYS_EAGER = not CELERY_BROKER_URL
CELERY_TASK_EAGER_PROPAGATES = True
# Result backend is intentionally **not** configured. None of the
# current task surfaces (email send, future MRPeasy push as
# fire-and-forget) need to inspect a return value; persisting
# results would only add DB writes for no caller. Switch this on
# (e.g. ``redis://…/3``) once a workflow needs ``AsyncResult.get()``.
CELERY_RESULT_BACKEND = os.environ.get("CELERY_RESULT_BACKEND", "")
# JSON is the only serializer we expect — explicitly reject pickle
# so a future task author can't accidentally ship a Django model
# instance through the broker (which would also create an arbitrary
# code execution surface on the worker).
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
# Long but finite default time limit so a stuck task can never pin a
# worker forever. Tasks that legitimately take longer override per
# task via ``@shared_task(time_limit=...)``.
CELERY_TASK_TIME_LIMIT = 60 * 5  # 5 minutes hard kill
CELERY_TASK_SOFT_TIME_LIMIT = 60 * 4  # 4 minutes soft (raises SoftTimeLimitExceeded)
# Helpful operational defaults: when a worker restarts, retry
# connection to the broker without spamming logs forever.
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_BROKER_CONNECTION_MAX_RETRIES = 10

# Periodic schedule for the ``celery beat`` process. The worker
# autodiscovers ``tasks.py`` in every installed app; beat just needs
# to know which of those tasks to fire on a cadence. Empty in dev
# (``CELERY_TASK_ALWAYS_EAGER`` mode never runs beat anyway) and
# the production beat container picks the schedule up via
# ``django.conf:settings`` config_from_object on boot.
CELERY_BEAT_SCHEDULE: dict[str, dict[str, object]] = {
    "cff-submissions-poll": {
        "task": "apps.cff_submissions.tasks.poll_cff_submissions",
        # Five-minute cadence: fast enough that a newly-submitted
        # CFF lands in the workspace within one coffee, slow enough
        # that we never hit Wix's per-tenant rate limits even with
        # a 100-page form.
        "schedule": 300.0,
    },
}


# Templates
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]


# Database
#
# Production sets ``DATABASE_URL`` (Postgres). Dev falls back to a
# local SQLite file so a fresh checkout boots without a server.
#
# Connection pooling — required, not optional:
#
# Azure Postgres Flexible Server caps the total number of non-superuser
# connections at ``max_connections - superuser_reserved_connections``.
# On the Burstable plans we run, that ceiling is in the low double
# digits. Without pooling, every request opens a fresh connection and
# closes it, and bursty traffic (multiple users on the same WiFi
# refreshing dashboards) blows the ceiling within seconds. The
# observed prod failure mode was a 500 with::
#
#   FATAL: remaining connection slots are reserved for roles
#   with the SUPERUSER attribute
#
# psycopg3's native ``ConnectionPool`` (shipped via the ``[pool]``
# extra) keeps a bounded set of live connections per worker process
# and hands them out per request. Each uvicorn worker gets its own
# pool, so the total open connection count is
# ``WEB_CONCURRENCY * DB_POOL_MAX_SIZE``. We size the pool to keep
# that product comfortably below the Postgres ceiling even under
# burst: ``DB_POOL_MAX_SIZE=5`` × ``WEB_CONCURRENCY=2`` = 10 max,
# leaving headroom for the management container (migrate /
# collectstatic) and any psql-from-portal admin sessions.
#
# ``conn_max_age`` is irrelevant once ``pool`` is set -- the pool
# manages connection lifetime itself.
_DATABASE_URL = os.environ.get("DATABASE_URL")
if _DATABASE_URL:
    _db_config = dj_database_url.parse(
        _DATABASE_URL,
        conn_health_checks=True,
        ssl_require=_env_bool("DATABASE_SSL_REQUIRE", default=True),
    )
    _pool_min = int(os.environ.get("DB_POOL_MIN_SIZE", "1"))
    _pool_max = int(os.environ.get("DB_POOL_MAX_SIZE", "7"))
    _db_config.setdefault("OPTIONS", {})
    # Django's PostgreSQL backend wires
    # ``check=ConnectionPool.check_connection`` into the pool itself
    # whenever this ``pool`` dict is present — so every connection
    # pulled from the pool already gets validated (cheap ``SELECT 1``
    # + rollback) before reaching a worker. We do NOT pass ``check``
    # here ourselves: doing so triggers
    # ``TypeError: got multiple values for keyword argument 'check'``
    # because Django merges its own value on top of this dict.
    _db_config["OPTIONS"]["pool"] = {
        "min_size": _pool_min,
        "max_size": _pool_max,
        # Wait at most this long for a free connection before raising
        # rather than queueing forever; surfaces saturation as a
        # bounded 503 instead of a stuck request.
        "timeout": float(os.environ.get("DB_POOL_TIMEOUT", "3")),
    }
    DATABASES = {"default": _db_config}
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }


# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]


# Internationalization
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True


# Static + media files
#
# Static (admin CSS, DRF browsable API assets) is collected into
# ``STATIC_ROOT`` at image-build time and served by WhiteNoise from
# inside the container — no external dependency required.
#
# Media (user-uploaded PDFs, signature images, generated proposal
# kiosk artefacts) lives in Azure Blob Storage in production so it
# survives container restarts. When the Azure account name is unset
# (dev), media falls back to local disk under ``BASE_DIR/media``.
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

AZURE_ACCOUNT_NAME = os.environ.get("AZURE_STORAGE_ACCOUNT_NAME")
AZURE_ACCOUNT_KEY = os.environ.get("AZURE_STORAGE_ACCOUNT_KEY")
AZURE_MEDIA_CONTAINER = os.environ.get(
    "AZURE_STORAGE_MEDIA_CONTAINER", "media"
)
#: Lifetime (seconds) of SAS tokens minted onto every
#: ``FileField.url`` in production. The ``media`` container is
#: private, so without a token the URL 403s. One hour balances
#: "long enough to download a 25 MB template / open a PDF preview"
#: against "short enough that a leaked link expires fast". Override
#: via env when a specific deployment needs different semantics.
AZURE_STORAGE_URL_EXPIRY_SECONDS = int(
    os.environ.get("AZURE_STORAGE_URL_EXPIRY_SECONDS", "3600")
)

if AZURE_ACCOUNT_NAME and AZURE_ACCOUNT_KEY:
    STORAGES = {
        "default": {
            "BACKEND": "storages.backends.azure_storage.AzureStorage",
            "OPTIONS": {
                "account_name": AZURE_ACCOUNT_NAME,
                "account_key": AZURE_ACCOUNT_KEY,
                "azure_container": AZURE_MEDIA_CONTAINER,
                # SAS-token TTL on every URL. ``None`` returned
                # unsigned URLs which 403'd on the private
                # container — switching to a real value flips
                # FileField.url to a signed download link.
                "expiration_secs": AZURE_STORAGE_URL_EXPIRY_SECONDS,
            },
        },
        "staticfiles": {
            "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
        },
    }
    MEDIA_URL = (
        f"https://{AZURE_ACCOUNT_NAME}.blob.core.windows.net/"
        f"{AZURE_MEDIA_CONTAINER}/"
    )
else:
    STORAGES = {
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
        },
        "staticfiles": {
            "BACKEND": (
                "whitenoise.storage.CompressedManifestStaticFilesStorage"
                if not DEBUG
                else "django.contrib.staticfiles.storage.StaticFilesStorage"
            ),
        },
    }
    MEDIA_URL = "/media/"
    MEDIA_ROOT = BASE_DIR / "media"


# Defaults
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"


# AI providers. The free/default path uses Ollama running locally;
# paid providers (OpenAI, Anthropic) plug in as new adapters under
# :mod:`apps.ai.providers` in a future commit.
AI_OLLAMA_URL = os.environ.get("AI_OLLAMA_URL", "http://127.0.0.1:11434")
AI_OLLAMA_MODEL = os.environ.get("AI_OLLAMA_MODEL", "llama3.2:3b")
# Hard ceiling on how long a single provider call can block a
# request. The 3B default lands in a few seconds on a warm model;
# 120 s leaves plenty of headroom for cold-start and larger optional
# models without us keeping a worker thread forever.
AI_PROVIDER_TIMEOUT_SECONDS = int(
    os.environ.get("AI_PROVIDER_TIMEOUT_SECONDS", "120")
)


# Email. Dev uses the console backend so ``send_mail`` writes to stdout
# — no SMTP credentials required to exercise the comments-notification
# flow locally. Production points at a real SMTP relay (currently Azure
# Communication Services Email) — every variable below is read
# explicitly from the environment because Django's default settings
# leave ``EMAIL_HOST`` etc. at ``'localhost'`` unless settings.py
# overrides them.
EMAIL_BACKEND = os.environ.get(
    "EMAIL_BACKEND",
    "django.core.mail.backends.console.EmailBackend"
    if DEBUG
    else "django.core.mail.backends.smtp.EmailBackend",
)
EMAIL_HOST = os.environ.get("EMAIL_HOST", "localhost")
EMAIL_PORT = int(os.environ.get("EMAIL_PORT", "25"))
EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD", "")
# Env vars arrive as strings; Django expects booleans for the
# transport-security flags. ``"True"`` / ``"true"`` / ``"1"`` all
# resolve to ``True``; anything else (incl. unset) is ``False``.
EMAIL_USE_TLS = os.environ.get("EMAIL_USE_TLS", "False").strip().lower() in {
    "true",
    "1",
    "yes",
}
EMAIL_USE_SSL = os.environ.get("EMAIL_USE_SSL", "False").strip().lower() in {
    "true",
    "1",
    "yes",
}
# SMTP connection timeout in seconds. Without this, a stalled SMTP
# handshake would block the request thread indefinitely — long enough
# to look like a hang under modest load.
EMAIL_TIMEOUT = int(os.environ.get("EMAIL_TIMEOUT", "20"))
# Customer-facing emails ("review your proposal", invite codes,
# password reset) need a display name the recipient instantly
# recognises as the company they're working with. Anything starting
# with "DoNotReply" — or even just a bare ``no-reply@…`` with no
# friendly prefix — reads as automated junk and gets ignored. The
# default carries the parent-company brand because that's what
# customers know; the in-app ``Vita NPD`` identity is staff-facing
# and stays inside the product.
#
# Override on App Service via the ``DEFAULT_FROM_EMAIL`` env var if
# the inbox should display a different sender (e.g. transactional
# emails routed through a third-party domain). Keep the full
# ``Display Name <address@domain>`` shape — bare addresses surface
# as their local part in most inboxes.
DEFAULT_FROM_EMAIL = os.environ.get(
    "DEFAULT_FROM_EMAIL", "Vita Manufacture <no-reply@vita.npd>"
)
# Base URL the notification templates embed in deep links back to the
# app. Defaults to the dev frontend origin so the console email still
# carries a clickable URL; override in production to the real host.
APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:3000")

# Shared bearer token that PSP presents to reach NPD-side integration
# endpoints (currently the "R&D in development" project list on PSP's
# ``/projects`` page). Kept out of the standard JWT chain because PSP
# is a server-to-server caller, not a logged-in user. Empty in dev
# means "PSP integration disabled" — the endpoint returns 401.
PSP_INTEGRATION_TOKEN = os.environ.get("PSP_INTEGRATION_TOKEN", "")

