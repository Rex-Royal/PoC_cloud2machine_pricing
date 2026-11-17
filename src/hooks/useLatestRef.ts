'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps a ref synchronized with the latest value after each commit,
 * avoiding repeated state-to-ref boilerplate across hooks.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef<T>(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
