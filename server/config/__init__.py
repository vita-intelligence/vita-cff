# Expose the Celery app at the package level so workers booted with
# ``celery -A config worker`` (or ``celery -A config beat``) can find
# it. Also imported at process start by Django so the ``@shared_task``
# decorator binds tasks to this app instead of silently waiting for a
# missing default.
from .celery import app as celery_app

__all__ = ("celery_app",)
