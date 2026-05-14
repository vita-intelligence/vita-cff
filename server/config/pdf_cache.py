"""Process-local PDF cache + render serialization.

Wraps WeasyPrint renders (spec sheets, proposals) with two
defensive measures against the OOM-loop that took the backend
down earlier:

1. **In-memory cache, TTL keyed on ``(doc_id, updated_at)``.**
   First Download click renders + caches the bytes; every
   subsequent click within ``ttl`` seconds gets the cached bytes
   without re-running WeasyPrint. Editing a doc bumps ``updated_at``
   which invalidates the entry naturally — no manual eviction
   needed on the write side.

2. **Process-wide render lock.** WeasyPrint holds ~150-300 MB of
   transient memory per render. On the ``Basic B1`` App Service
   tier (1.75 GB total, two uvicorn workers), three concurrent
   renders on the same worker would OOM. The lock caps per-worker
   concurrency to one render at a time; concurrent Download
   clicks queue up instead of blowing memory.

Caveats:

* Both structures are per-process. With ``--workers 2`` the max
  simultaneous renders across the box is two, not one. Still a
  hard ceiling, just doubled — fine for the current memory budget.
* No cross-process invalidation (this is in-memory). For
  immediately-after-edit downloads, the worker that handled the
  edit may have a stale cache entry from before the edit. The
  ``updated_at`` digest makes this self-correcting on the very
  next call.
* No size cap on the cache map. The ``_evict_stale`` sweep on
  every miss keeps it bounded by ``ttl`` * activity rate — a
  busy hour at 10 downloads/min × 60s TTL × 300 KB ≈ 3 MB. If
  this ever becomes load-bearing, replace with ``cachetools.TTLCache``.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, TypeVar


_T = TypeVar("_T")


_CACHE: dict[str, tuple[object, float]] = {}
_CACHE_LOCK = threading.Lock()
_RENDER_LOCK = threading.Lock()


def cached_render(
    key: str,
    renderer: Callable[[], _T],
    *,
    ttl: float = 60.0,
) -> _T:
    """Return ``renderer()`` output, cached by ``key`` for ``ttl`` seconds.

    Two-phase locking:

    * Fast path acquires only ``_CACHE_LOCK`` to read the cache
      map. No render lock contention when there's a cache hit, so
      a hot doc serves hundreds of downloads per second without
      blocking the WeasyPrint slot.
    * Slow path acquires ``_RENDER_LOCK`` to serialize the actual
      render across the whole process, then re-checks the cache
      (double-checked-locking) in case another waiter just filled
      it before us. Only one WeasyPrint call is in flight per
      worker process at any moment.
    """

    now = time.monotonic()

    # Fast path — cache hit.
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
        if entry is not None and entry[1] > now:
            return entry[0]  # type: ignore[return-value]

    # Slow path — only one render at a time per worker. Other
    # waiters will see the cached value on the re-check below.
    with _RENDER_LOCK:
        now = time.monotonic()
        with _CACHE_LOCK:
            entry = _CACHE.get(key)
            if entry is not None and entry[1] > now:
                return entry[0]  # type: ignore[return-value]

        # The actual render — releases the cache lock first so a
        # parallel fast-path read isn't blocked behind the heavy
        # WeasyPrint call. Other render-misses still queue behind
        # ``_RENDER_LOCK``.
        result = renderer()

        with _CACHE_LOCK:
            _CACHE[key] = (result, now + ttl)
            _evict_stale(now)
        return result


def _evict_stale(now: float) -> None:
    """Drop entries whose TTL has expired. Caller holds ``_CACHE_LOCK``."""

    stale_keys = [k for k, (_, exp) in _CACHE.items() if exp <= now]
    for k in stale_keys:
        _CACHE.pop(k, None)


def invalidate(key: str) -> None:
    """Drop a specific cache entry (e.g. on doc delete)."""

    with _CACHE_LOCK:
        _CACHE.pop(key, None)


def clear() -> None:
    """Wipe every cached entry. Test-only by convention — pollutes
    every other caller in the same process."""

    with _CACHE_LOCK:
        _CACHE.clear()
