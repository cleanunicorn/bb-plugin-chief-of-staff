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

/** A task the Activity feed can name, open and filter by. */
export type TaskRef = { id: string; label: string };

/**
 * The label for a log row's task: "#109 Title" for an issue, the title alone for a standalone task, the short id
 * for a task with no title. Null when the row has no task or its task was not found (`issueTitle` is null only then).
 */
export function taskLabel(row: { workItemId: string | null; issueNumber: number | null; issueTitle: string | null }): TaskRef | null {
  if (!row.workItemId || row.issueTitle === null) return null;
  const label = row.issueNumber ? `#${row.issueNumber}${row.issueTitle ? ` ${row.issueTitle}` : ""}` : row.issueTitle || row.workItemId.slice(0, 8);
  return { id: row.workItemId, label };
}

/** A run of plain text, or a BB thread id. */
export type TextPart = { text: string } | { thread: string };

// `\b` keeps ids that start a word: "tool:thr_x" and "thr_a, thr_b" match, "mythr_x" does not.
const THREAD_ID = /\bthr_[A-Za-z0-9]+/g;

/** Splits text around thread ids, so they can be linked. Joining the parts gives the text back unchanged. */
export function splitThreadIds(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(THREAD_ID)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ thread: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
  return parts;
}
