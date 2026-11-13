// Refetch a dashboard view when Chief of Staff's state changes.
import { useEffect, useRef } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";

/** Quiet time after the last `cos-changed` event before the view refetches. */
export const LIVE_REFRESH_DEBOUNCE_MS = 500;

/**
 * Refetch on `cos-changed`, coalescing a burst of events (a workflow reports,
 * transitions and sweeps in quick succession) into one refetch, 500 ms after
 * the last one. Refetches after the user's own actions stay immediate.
 */
export function useLiveRefresh(refetch: () => Promise<void>): void {
  const latest = useRef(refetch);
  latest.current = refetch;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useRealtime("cos-changed", () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void latest.current();
    }, LIVE_REFRESH_DEBOUNCE_MS);
  });
}
