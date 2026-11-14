// The Finished section of the Pipeline tab (#105): finished tasks as compact rows, newest first, grouped by
// the day they finished. Pure helpers, so ordering, grouping and paging are tested without rendering.
import type { Outcome } from "../../src/outcome";
import { duration, relative } from "./viz";

/** Rows shown at first, and how many more each "Show 20 more" adds. */
export const FINISHED_FIRST = 10;
export const FINISHED_STEP = 20;

export type OutcomeGroup = "shipped" | "marked_done" | "failed";

const GROUP_OF: Record<Outcome, OutcomeGroup> = {
  merged: "shipped",
  pr_opened: "shipped",
  completed: "shipped",
  marked_done: "marked_done",
  failed: "failed",
  marked_failed: "failed",
  pr_closed: "failed",
};

/** Shipped, Marked done or Failed. Without an outcome, the status decides. Null for an active task. */
export function outcomeGroup(entry: { outcome: Outcome | null; detail: string }): OutcomeGroup | null {
  if (entry.outcome) return GROUP_OF[entry.outcome];
  if (entry.detail === "done") return "shipped";
  if (entry.detail === "failed") return "failed";
  return null;
}

/**
 * The UTC day (YYYY-MM-DD) a task finished, or null when its finish time is unknown (some legacy rows).
 * UTC, like Throughput's days (src/stats.ts), so a bar's count and the rows under that day agree. Near
 * midnight a task can therefore sit under a different day than the viewer's local date.
 */
export function finishDay(entry: { finishedAt: string | null }): string | null {
  if (!entry.finishedAt) return null;
  const ms = Date.parse(entry.finishedAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** "Nov 8", the format of Throughput's days. */
export function fmtDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A day's heading: "Today" and "Yesterday" by the UTC date at `now`, otherwise "Nov 8". */
export function dayLabel(day: string, now: number): string {
  const today = new Date(now).toISOString().slice(0, 10);
  if (day === today) return "Today";
  if (day === new Date(now - 86_400_000).toISOString().slice(0, 10)) return "Yesterday";
  return fmtDay(day);
}

export type DayGroup<T> = { key: string; label: string; entries: T[] };

/** Rows grouped by finish day, days in the order first seen (newest first from the server), rows keeping their order. Rows without a finish time go last, under "Earlier". */
export function groupByDay<T extends { finishedAt: string | null }>(entries: readonly T[], now: number): DayGroup<T>[] {
  const days = new Map<string, T[]>();
  const earlier: T[] = [];
  for (const entry of entries) {
    const day = finishDay(entry);
    if (!day) earlier.push(entry);
    else days.set(day, [...(days.get(day) ?? []), entry]);
  }
  const groups = Array.from(days, ([key, rows]) => ({ key, label: dayLabel(key, now), entries: rows }));
  if (earlier.length) groups.push({ key: "earlier", label: "Earlier", entries: earlier });
  return groups;
}

/** The first `shown` rows, and whether more are loaded beyond them. */
export function visibleSlice<T>(list: readonly T[], shown: number): { rows: T[]; more: boolean } {
  return { rows: list.slice(0, shown), more: list.length > shown };
}

const isFinished = (e: { detail: string }) => e.detail === "done" || e.detail === "failed";

/**
 * The finished tasks of the first roster page, then those of older pages not on it. A task active anywhere
 * (`activeIds`, or active on the first page) is left out: a retried task is active again, while an older page
 * may still hold its finished copy.
 */
export function mergePages<T extends { id: string; detail: string }>(first: readonly T[], older: readonly T[], activeIds: ReadonlySet<string>): T[] {
  const skip = new Set(activeIds);
  for (const e of first) if (!isFinished(e)) skip.add(e.id);
  const out: T[] = [];
  for (const e of [...first, ...older]) {
    if (!isFinished(e) || skip.has(e.id)) continue;
    skip.add(e.id);
    out.push(e);
  }
  return out;
}

/** "Finished 2h ago · took 1.2h"; a legacy row without a finish time says only when it started. */
export function finishedTimer(entry: { startedAt: string; finishedAt: string | null }, now: number): { text: string; label: string; title: string } {
  const started = new Date(entry.startedAt).toLocaleString();
  if (!entry.finishedAt) {
    const text = `Started ${relative(entry.startedAt, now)}`;
    return { text, label: text, title: `Task started ${started}` };
  }
  const ago = relative(entry.finishedAt, now);
  const took = duration((Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)) / 60_000);
  return { text: `Finished ${ago} · took ${took}`, label: `Finished ${ago}, took ${took}`, title: `Finished ${new Date(entry.finishedAt).toLocaleString()} · started ${started}` };
}

/** What the Finished section shows. No outcome picked means every outcome. */
export type FinishedFilter = { outcomes: readonly OutcomeGroup[]; repo: string | null; query: string };
export const NO_FILTER: FinishedFilter = { outcomes: [], repo: null, query: "" };

export const isFiltering = (f: FinishedFilter) => f.outcomes.length > 0 || f.repo !== null || f.query.trim() !== "";

type Filterable = { outcome: Outcome | null; detail: string; repo: string; issueTitle: string; threadTitle: string | null; issueNumber: number | null; prNumber: number | null };

/** Outcome, repository and search all match. The search finds the title, and "12" or "#12" the issue or PR number too. */
export function matchesFinishedFilter(entry: Filterable, f: FinishedFilter): boolean {
  if (f.outcomes.length) {
    const group = outcomeGroup(entry);
    if (!group || !f.outcomes.includes(group)) return false;
  }
  if (f.repo !== null && entry.repo !== f.repo) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  if ((entry.issueTitle || entry.threadTitle || "").toLowerCase().includes(q)) return true;
  const number = /^#?(\d+)$/.exec(q);
  return number !== null && (entry.issueNumber === Number(number[1]) || entry.prNumber === Number(number[1]));
}
