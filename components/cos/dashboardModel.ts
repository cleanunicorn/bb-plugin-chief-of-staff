import { stageOf, type StageKey } from "./stages";

type TaskState = { detail: string; waitingKind: string | null; stalled: boolean };
export type TaskFilter = StageKey | "all" | "failures" | "stalled";

/** Terminal failed runs are history. Only active failure decisions need action. */
export function attentionKind(entry: TaskState): "failures" | "stalled" | "human" | null {
  if (entry.detail === "done" || entry.detail === "failed") return null;
  if (entry.stalled || entry.detail === "blocked" || (entry.detail === "waiting_on_human" && entry.waitingKind === "stalled")) return "stalled";
  if (entry.detail !== "waiting_on_human") return null;
  return ["escalation", "cos_error", "no_report"].includes(entry.waitingKind ?? "") ? "failures" : "human";
}

export function matchesTaskFilter(entry: TaskState, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  if (filter === "failures" || filter === "stalled") return attentionKind(entry) === filter;
  return stageOf(entry)?.key === filter;
}
