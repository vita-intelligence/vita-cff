"""Django settings for the Vita NPD platform."""

import os
from datetime import timedelta
from pathlib import Path

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent


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
]

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS


# Authentication
AUTH_USER_MODEL = "accounts.User"


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


# simplejwt
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": False,
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
]

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
# single-process ``runserver`` and the test suite. Production
# overrides ``CHANNEL_LAYER_URL`` to a Redis DSN so consumers across
# multiple worker processes can broadcast to each other via
# ``channels_redis`` — the same Redis we will also use for Celery
# when commit 3's payload lands in production.
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


# Templates
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
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
# ``conn_max_age`` recycles connections every 60s, which suits
# App Service's container model where idle workers may be reaped.
_DATABASE_URL = os.environ.get("DATABASE_URL")
if _DATABASE_URL:
    DATABASES = {
        "default": dj_database_url.parse(
            _DATABASE_URL,
            conn_max_age=60,
            conn_health_checks=True,
            ssl_require=_env_bool("DATABASE_SSL_REQUIRE", default=True),
        ),
    }
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

if AZURE_ACCOUNT_NAME and AZURE_ACCOUNT_KEY:
    STORAGES = {
        "default": {
            "BACKEND": "storages.backends.azure_storage.AzureStorage",
            "OPTIONS": {
                "account_name": AZURE_ACCOUNT_NAME,
                "account_key": AZURE_ACCOUNT_KEY,
                "azure_container": AZURE_MEDIA_CONTAINER,
                "expiration_secs": None,
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
# flow locally. Production points at a real SMTP relay via environment
# variables; Django auto-picks up ``EMAIL_HOST`` / ``EMAIL_PORT`` /
# ``EMAIL_HOST_USER`` / ``EMAIL_HOST_PASSWORD`` / ``EMAIL_USE_TLS``.
EMAIL_BACKEND = os.environ.get(
    "EMAIL_BACKEND",
    "django.core.mail.backends.console.EmailBackend"
    if DEBUG
    else "django.core.mail.backends.smtp.EmailBackend",
)
DEFAULT_FROM_EMAIL = os.environ.get(
    "DEFAULT_FROM_EMAIL", "Vita NPD <no-reply@vita.npd>"
)
# Base URL the notification templates embed in deep links back to the
# app. Defaults to the dev frontend origin so the console email still
# carries a clickable URL; override in production to the real host.
APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:3000")

