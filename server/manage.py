#!/usr/bin/env python
"""Django's command-line utility for administrative tasks."""
import os
import sys


def main():
    """Run administrative tasks."""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    # WeasyPrint (content-block PDF/PNG renderer) loads Pango + Cairo
    # via cffi at import time. On Apple Silicon + Homebrew the libs
    # live in ``/opt/homebrew/lib`` but that dir isn't in the default
    # dyld search path, so the import 500s unless the env var is set
    # before Python starts resolving symbols. Setting it here is
    # a no-op on Linux/CI where the libs are on the standard path.
    if sys.platform == "darwin":
        os.environ.setdefault(
            "DYLD_FALLBACK_LIBRARY_PATH", "/opt/homebrew/lib"
        )
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed and "
            "available on your PYTHONPATH environment variable? Did you "
            "forget to activate a virtual environment?"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == '__main__':
    main()
