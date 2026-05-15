"""Celery application bootstrap.

The Celery integration is intentionally **optional**: when
``CELERY_BROKER_URL`` is not set in the environment, every task we
dispatch runs synchronously in the calling process (the
``CELERY_TASK_ALWAYS_EAGER`` setting). That keeps the test suite
deterministic and makes a fresh ``manage.py runserver`` work
without a Redis sidecar — developers only need a broker if they
want to exercise the async path.

In production, ``CELERY_BROKER_URL`` points at the shared Azure
Cache for Redis instance (DB 2 by convention; DB 1 is reserved
for Channels). A separate App Service runs ``celery -A config
worker`` so request workers never spend time on async-able work.

Why a single ``celery.py`` instead of one per app: Django's
``autodiscover_tasks`` walks every entry in ``INSTALLED_APPS`` and
imports a ``tasks.py`` module from each. New apps (proposals,
accounts, future MRPeasy push) just drop in a ``tasks.py`` and
their tasks are picked up automatically.
"""

from __future__ import annotations

import os

from celery import Celery

# Tell Celery where to find Django's settings module. ``manage.py``
# and ``wsgi.py`` set this the same way; we hard-code the default
# so a worker booted via ``celery -A config worker`` works without
# the operator having to also export ``DJANGO_SETTINGS_MODULE``.
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("vita_npd")

# ``CELERY_`` prefixed settings on Django's settings module are
# automatically picked up. Keeps all configuration in ``settings.py``
# so the Celery worker and the request workers see exactly the same
# values.
app.config_from_object("django.conf:settings", namespace="CELERY")

# Discover ``tasks.py`` modules in every installed app.
app.autodiscover_tasks()
