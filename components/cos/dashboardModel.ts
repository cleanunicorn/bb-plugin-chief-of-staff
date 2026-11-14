import { stageOf, type StageKey } from "./stages";

type TaskState = { detail: string; waitingKind: string | null; stalled: boolean };
export type TaskFilter = StageKey | "all" | "failures" | "stalled" | "input";

/** Terminal failed runs are history. Only active failure decisions need action. */
export function attentionKind(entry: TaskState): "failures" | "stalled" | "human" | null {
  if (entry.detail === "done" || entry.detail === "failed") return null;
  if (entry.stalled || entry.detail === "blocked" || (entry.detail === "waiting_on_human" && entry.waitingKind === "stalled")) return "stalled";
  if (entry.detail !== "waiting_on_human") return null;
  return ["escalation", "cos_error", "no_report"].includes(entry.waitingKind ?? "") ? "failures" : "human";
}

export function matchesTaskFilter(entry: TaskState, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  if (filter === "input") return attentionKind(entry) === "human";
  if (filter === "failures" || filter === "stalled") return attentionKind(entry) === filter;
  return stageOf(entry)?.key === filter;
}

/** How an activity row names its task: "#7 Fix login", "#7", a standalone task's title, or "Untitled task". Null when the row has no task, or its task is gone. */
export function taskLabel(row: { workItemId: string | null; issueNumber?: number | null; issueTitle?: string | null }): string | null {
  const number = row.issueNumber ?? null;
  const title = row.issueTitle ?? null;
  if (!row.workItemId || (number === null && title === null)) return null;
  if (number !== null) return title ? `#${number} ${title}` : `#${number}`;
  return title || "Untitled task";
}

const THREAD_ID = /\bthr_[A-Za-z0-9]+/g;

/** Text with each BB thread id (`thr_…`) split out, so it can be linked. Joining the parts gives the text back. */
export function splitThreadIds(text: string): (string | { thread: string })[] {
  const parts: (string | { thread: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(THREAD_ID)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ thread: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** A task the Activity feed can be narrowed to. */
export type ActivityTask = { id: string; label: string };

/** Tasks named in `rows` (newest first), then those seen `before` that are not among them, at most `max`. */
export function recentTasks(rows: readonly { workItemId: string | null; issueNumber?: number | null; issueTitle?: string | null }[], before: readonly ActivityTask[] = [], max = 20): ActivityTask[] {
  const tasks = new Map<string, ActivityTask>();
  for (const row of rows) {
    const label = taskLabel(row);
    if (label && row.workItemId && !tasks.has(row.workItemId)) tasks.set(row.workItemId, { id: row.workItemId, label });
  }
  for (const task of before) if (!tasks.has(task.id)) tasks.set(task.id, task);
  return [...tasks.values()].slice(0, max);
}
