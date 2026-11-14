// How a finished task ended, derived when the roster is read. Nothing here is
// stored: the signals are the item's status, step states and PR fields (which
// survive retention), with the newest manual log row as a tiebreaker (it can
// be pruned, so every fallback reads true without it). Pure; the dashboard
// imports the labels and icons too.
import type { WorkItem } from "./state";
import { finalSteps } from "./workflow";

/** Why a task failed when its pull request was closed without merging (set by the engine on pr_closed). */
export const PR_CLOSED_ERROR = "PR closed without merge";

/** lastError of a task closed by hand: tells it apart from a thread failure or a shipped task. */
export const MARKED_DONE = "Marked done";
export const MARKED_FAILED = "Marked failed";

export const OUTCOMES = ["merged", "pr_opened", "completed", "marked_done", "failed", "marked_failed", "pr_closed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Outcomes that did not deliver: their cards show why the task ended. */
export const FAILED_OUTCOMES: readonly Outcome[] = ["failed", "marked_failed", "pr_closed"];

/**
 * Why a task ended, for one that did not deliver: its stored error. A delivered task's stale error is not a reason,
 * and MARKED_FAILED only repeats the outcome label. The task card and the "since you were here" header (#110) share it.
 */
export function endReason(outcome: Outcome | null, lastError: string | null): string | null {
  return outcome && FAILED_OUTCOMES.includes(outcome) && lastError !== MARKED_FAILED ? lastError : null;
}

/** Label, icon and tone per outcome. Text and icon differ for every outcome, so none is told apart by colour alone. */
export const OUTCOME_META: Record<Outcome, { label: string; icon: string; tone: "good" | "neutral" }> = {
  merged: { label: "Merged", icon: "GitMerge", tone: "good" },
  pr_opened: { label: "PR opened", icon: "GitPullRequest", tone: "good" },
  completed: { label: "Completed", icon: "CircleCheck", tone: "good" },
  marked_done: { label: "Marked done", icon: "UserCheck", tone: "neutral" },
  failed: { label: "Failed", icon: "CircleX", tone: "neutral" },
  marked_failed: { label: "Marked failed", icon: "UserX", tone: "neutral" },
  pr_closed: { label: "PR closed", icon: "GitPullRequestClosed", tone: "neutral" },
};

/** The newest manual action logged for an item ("marked done", "marked failed"). */
export type ManualMarker = { message: string; at: string };

/** `mark_*` logs its row, then sets finishedAt in the same call: the row lands just before the finish. */
const MARKER_WINDOW_MS = 60_000;

function markerFor(item: Pick<WorkItem, "finishedAt">, manual: ManualMarker | null): string | null {
  if (!manual || !item.finishedAt) return null;
  const gap = Date.parse(item.finishedAt) - Date.parse(manual.at);
  // A marker from before the task was reopened does not explain a later finish.
  return gap >= 0 && gap <= MARKER_WINDOW_MS ? manual.message : null;
}

export function finishedOutcome(item: Pick<WorkItem, "status" | "lastError" | "prNumber" | "finishedAt" | "workflow" | "nodes">, manual: ManualMarker | null): Outcome | null {
  const marked = markerFor(item, manual);
  if (item.status === "done") {
    // The engine writes MARKED_DONE on a close; the log row is the fallback for rows closed before it did.
    if (item.lastError === MARKED_DONE || marked === "marked done") return "marked_done";
    // The engine finishes only when every final step is done; mark_done is the
    // only other writer of "done". Legacy rows without step state are skipped.
    if (Object.keys(item.nodes).length && finalSteps(item.workflow).some((id) => item.nodes[id]?.status !== "done")) return "marked_done";
    // A merge step completes on pr_merged; approved past a refusal it has no PR.
    if (item.prNumber && item.workflow.steps.some((s) => s.type === "ship" && s.action === "merge" && item.nodes[s.id]?.status === "done")) return "merged";
    // Known limit: a PR-action workflow finishes when the PR opens, and a merge
    // seen later leaves no durable trace (complete() clears the phase), so it
    // reads "PR opened". Live PR state is #114's.
    if (item.prNumber) return "pr_opened";
    return "completed";
  }
  if (item.status === "failed") {
    if (item.lastError === PR_CLOSED_ERROR) return "pr_closed";
    if (item.lastError === MARKED_FAILED || marked === "marked failed") return "marked_failed";
    // Every engine failure (a dead builder thread, a closed PR) sets lastError.
    if (item.lastError === null) return "marked_failed";
    return "failed";
  }
  return null;
}
