// "Since you were here" (#110): when this browser last saw the dashboard, and the
// baseline this browser tab counts changes from. Both stay in the browser; the
// server stores nothing about visits.
//
// Two keys, because the Pipeline tab unmounts on every dashboard tab switch:
// - localStorage `cos.lastVisit`: when this browser last left the dashboard
//   (pagehide, the page hidden, or the Pipeline tab unmounted).
// - sessionStorage `cos.visitBaseline`: this browser tab's baseline, copied from
//   `cos.lastVisit` when a visit starts ("none" on a first visit). Live refetches,
//   StrictMode remounts, reloads and tab switches within a visit read it back unchanged.
// A visit ends when the Pipeline tab was out of sight for NEW_VISIT_AFTER_MS: BB stays
// open for days, so a browser tab's life alone would never start a new one. "Out of
// sight" counts time on another dashboard tab too, and `cos.lastVisit` is shared by the
// browser's windows: another BB window hiding the dashboard can end this one's visit.
import { useEffect, useState } from "react";

export const LAST_VISIT_KEY = "cos.lastVisit";
export const BASELINE_KEY = "cos.visitBaseline";
/** Away from the dashboard this long, coming back starts a new visit. */
export const NEW_VISIT_AFTER_MS = 30 * 60_000;
/** The baseline of a first visit: nothing to count from. */
const NONE = "none";

/** Storage that is blocked (privacy settings, sandboxed frames) reads as null. */
function storage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function read(store: Storage | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: Storage | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Full or blocked: the next visit starts as a first visit.
  }
}

/** The time as a full ISO datetime (what cos_since accepts), or null for anything that is not a time. */
function time(value: string | null): string | null {
  return value !== null && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/**
 * The baseline for this browser tab at `now`: the ISO time of the previous visit, or null on a first visit.
 * Within a visit it returns the stored baseline; a new visit starts from `cos.lastVisit` and stores it.
 * Storage that throws reads as a first visit.
 */
export function visitBaseline(now: number): string | null {
  const local = storage("localStorage");
  const session = storage("sessionStorage");
  const last = time(read(local, LAST_VISIT_KEY));
  const stored = read(session, BASELINE_KEY);
  const sameVisit = stored !== null && (last === null || now - Date.parse(last) < NEW_VISIT_AFTER_MS);
  if (sameVisit) return stored === NONE ? null : time(stored);
  write(session, BASELINE_KEY, last ?? NONE);
  return last;
}

/** Record that this browser left the dashboard at `now`. */
export function markLeft(now: number): void {
  write(storage("localStorage"), LAST_VISIT_KEY, new Date(now).toISOString());
}

/**
 * This tab's baseline, kept current: leaving (pagehide, the page hidden, unmount) records the last visit, and the
 * page coming back after NEW_VISIT_AFTER_MS starts a new visit.
 */
export function useVisitBaseline(): string | null {
  const [baseline, setBaseline] = useState(() => visitBaseline(Date.now()));
  useEffect(() => {
    const leave = () => markLeft(Date.now());
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave();
      else setBaseline(visitBaseline(Date.now()));
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", onVisibility);
      leave();
    };
  }, []);
  return baseline;
}
