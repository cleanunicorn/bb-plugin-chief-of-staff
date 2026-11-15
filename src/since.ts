// "Since you were here" (#110): what finished after the browser's last visit. The visit time
// lives in the browser; this only reads the stored items, and stores nothing.
import type { StateStore } from "./state";
import { endReason, finishedOutcome, type Outcome } from "./outcome";

/** Failures named in the header; the rest are counted. */
export const SINCE_FAILURES = 3;

export interface SinceFailure {
  id: string;
  repo: string;
  issueNumber: number | null;
  issueTitle: string;
  outcome: Outcome;
  /** The card's "Why it ended"; null when the outcome says it all (marked failed by hand). */
  reason: string | null;
}

export interface SinceSummary {
  shipped: number;
  failed: number;
  /** The newest failures, at most SINCE_FAILURES. */
  failures: SinceFailure[];
}

/** Tasks finished after `since` (any ISO offset): done and failed counts, and the newest failures with why they ended. */
export function sinceSummary(store: StateStore, since: string): SinceSummary {
  const found = store.finishedSince(new Date(since).toISOString(), SINCE_FAILURES);
  const manual = store.latestManualActions(found.failures.map((item) => item.id));
  return {
    shipped: found.shipped,
    failed: found.failed,
    failures: found.failures.map((item) => {
      // Every failed item has an outcome; "failed" only guards the type.
      const outcome = finishedOutcome(item, manual.get(item.id) ?? null) ?? "failed";
      return { id: item.id, repo: item.repo, issueNumber: item.issueNumber, issueTitle: item.issueTitle, outcome, reason: endReason(outcome, item.lastError) };
    }),
  };
}
