"""Tests for the process-local PDF cache + render lock.

Three guarantees worth pinning so a future refactor of
``cached_render`` can't quietly drop them:

1. Cache hits skip the renderer entirely (the perf win).
2. Cache misses serialize on the render lock so peak memory is
   bounded to ``one WeasyPrint call at a time per worker`` (the
   OOM defense).
3. ``ttl`` invalidation is real — a stale entry doesn't poison
   the cache forever.
"""

from __future__ import annotations

import threading
import time

from config import pdf_cache
from config.pdf_cache import cached_render, clear, invalidate


class TestCachedRender:
    def setup_method(self) -> None:
        # Each test starts with a clean cache so they don't bleed
        # into each other. Module-global state, so order matters
        # without this.
        clear()

    def test_cache_hit_skips_renderer(self) -> None:
        # First call renders; second call within ``ttl`` returns
        # the cached bytes without invoking the renderer.
        calls = {"n": 0}

        def renderer() -> bytes:
            calls["n"] += 1
            return b"rendered"

        assert cached_render("k1", renderer) == b"rendered"
        assert cached_render("k1", renderer) == b"rendered"
        assert calls["n"] == 1

    def test_different_keys_render_independently(self) -> None:
        # The cache map keys on the full string, so two docs don't
        # share an entry.
        seen: list[str] = []

        def make(value: bytes):
            def renderer() -> bytes:
                seen.append(value.decode())
                return value
            return renderer

        assert cached_render("doc-a", make(b"A")) == b"A"
        assert cached_render("doc-b", make(b"B")) == b"B"
        assert seen == ["A", "B"]

    def test_ttl_expires_and_re_renders(self) -> None:
        # When the TTL elapses, the next call must re-invoke the
        # renderer. Sub-second TTL keeps the test fast.
        calls = {"n": 0}

        def renderer() -> bytes:
            calls["n"] += 1
            return f"v{calls['n']}".encode()

        assert cached_render("ttl-key", renderer, ttl=0.05) == b"v1"
        time.sleep(0.1)
        assert cached_render("ttl-key", renderer, ttl=0.05) == b"v2"
        assert calls["n"] == 2

    def test_concurrent_misses_serialize(self) -> None:
        # The render lock is the OOM defense — concurrent cache
        # misses on different keys must NOT run in parallel. The
        # renderer captures how many concurrent invocations were
        # in flight; with a working lock, the peak is always 1.
        active = {"n": 0}
        peak = {"n": 0}
        lock = threading.Lock()

        def renderer(value: bytes):
            def r() -> bytes:
                with lock:
                    active["n"] += 1
                    if active["n"] > peak["n"]:
                        peak["n"] = active["n"]
                # Hold long enough that overlapping threads would
                # increment ``active`` if the lock weren't doing
                # its job.
                time.sleep(0.05)
                with lock:
                    active["n"] -= 1
                return value
            return r

        threads = [
            threading.Thread(
                target=cached_render,
                args=(f"k-{i}", renderer(f"v{i}".encode())),
            )
            for i in range(5)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert peak["n"] == 1

    def test_concurrent_same_key_renders_once(self) -> None:
        # Double-checked locking — when many threads ask for the
        # same key simultaneously, only one actually renders; the
        # rest pick up the cached value.
        calls = {"n": 0}
        call_lock = threading.Lock()

        def renderer() -> bytes:
            with call_lock:
                calls["n"] += 1
            time.sleep(0.05)
            return b"single"

        threads = [
            threading.Thread(
                target=cached_render,
                args=("hot-key", renderer),
            )
            for _ in range(8)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        # Exactly one render even with 8 concurrent waiters.
        assert calls["n"] == 1

    def test_invalidate_drops_specific_entry(self) -> None:
        calls = {"n": 0}

        def renderer() -> bytes:
            calls["n"] += 1
            return b"v"

        cached_render("doomed", renderer)
        cached_render("safe", renderer)
        invalidate("doomed")
        # Re-renders the invalidated key.
        cached_render("doomed", renderer)
        # ``safe`` stayed cached, no re-render.
        cached_render("safe", renderer)
        assert calls["n"] == 3  # 2 initial + 1 re-render

    def test_stale_entries_get_evicted_on_write(self) -> None:
        # The eviction sweep keeps the cache map from growing
        # unbounded across long-running processes. Pin the
        # invariant: after a ``cached_render`` miss, expired
        # entries are gone from the internal map.
        cached_render("expired", lambda: b"x", ttl=0.01)
        time.sleep(0.05)
        cached_render("fresh", lambda: b"y", ttl=60.0)
        # ``_CACHE`` is private but we touch it deliberately —
        # this is the only test that needs to assert internal state.
        assert "expired" not in pdf_cache._CACHE
        assert "fresh" in pdf_cache._CACHE
