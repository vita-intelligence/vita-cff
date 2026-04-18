"use client";

import { useEffect, useState } from "react";


/**
 * Trailing-edge debounce — returns ``value`` updated at most every
 * ``delayMs`` milliseconds.
 *
 * Stable, no external deps. Useful for search inputs and anything else
 * where we want to delay propagation until the user stops typing.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
