// Refetch a dashboard view when Chief of Staff's state changes.
import { useEffect, useRef } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";

/** Quiet time after the last `cos-changed` event before the view refetches. */
export const LIVE_REFRESH_DEBOUNCE_MS = 500;
/** Longest a burst of events delays the refetch after its first event. */
export const LIVE_REFRESH_MAX_WAIT_MS = 2_000;

/**
 * Refetch on `cos-changed`, coalescing a burst of events (a workflow reports,
 * transitions and sweeps in quick succession) into one refetch, 500 ms after
 * the last one, or 2 s after the first while events keep coming. Refetches
 * after the user's own actions stay immediate.
 */
export function useLiveRefresh(refetch: () => Promise<void>): void {
  const latest = useRef(refetch);
  latest.current = refetch;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the pending burst's first event arrived. */
  const burstStart = useRef(0);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useRealtime("cos-changed", () => {
    const now = Date.now();
    if (timer.current) clearTimeout(timer.current);
    else burstStart.current = now;
    const delay = Math.max(0, Math.min(LIVE_REFRESH_DEBOUNCE_MS, burstStart.current + LIVE_REFRESH_MAX_WAIT_MS - now));
    timer.current = setTimeout(() => {
      timer.current = null;
      void latest.current();
    }, delay);
  });
}
