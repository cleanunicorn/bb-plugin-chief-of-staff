// Aggregates for the dashboard: pipeline counts by stage, daily throughput, and cycle time.
// Pure over the stored scalar columns so it is cheap to test.
import { WORK_STATUSES, type WorkItem, type WorkStatus } from "./state";

export interface DailyPoint {
  date: string; // YYYY-MM-DD (UTC)
  started: number;
  done: number;
  failed: number;
}

export interface Stats {
  byStatus: Record<WorkStatus, number>; // active statuses: current count; done/failed: within the window
  daily: DailyPoint[];
  windowDays: number;
  startedInWindow: number;
  doneInWindow: number;
  failedInWindow: number;
  medianCycleMinutes: number | null; // created -> finished for items done in the window
  totalTracked: number;
}

/** The columns stats are computed from (see StateStore.statsRows). */
export type StatsItem = Pick<WorkItem, "status" | "createdAt" | "finishedAt" | "updatedAt">;

const day = (iso: string) => iso.slice(0, 10);

/** Start of the stats window: UTC midnight `windowDays - 1` days before `now`. */
export function statsWindowStart(now: Date, windowDays = 14): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (windowDays - 1))).toISOString();
}

/**
 * `items` must hold every active item and every item started or finished
 * since statsWindowStart; `totalTracked` is the number of stored items.
 */
export function computeStats(items: StatsItem[], now: Date, windowDays = 14, totalTracked = items.length): Stats {
  const byStatus = Object.fromEntries(WORK_STATUSES.map((s) => [s, 0])) as Record<WorkStatus, number>;
  const startIso = statsWindowStart(now, windowDays);
  const start = new Date(startIso);
  const daily: DailyPoint[] = [];
  const index = new Map<string, DailyPoint>();
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const point = { date: d, started: 0, done: 0, failed: 0 };
    daily.push(point);
    index.set(d, point);
  }
  const cycles: number[] = [];
  let startedInWindow = 0;
  let doneInWindow = 0;
  let failedInWindow = 0;
  for (const item of items) {
    if (item.createdAt >= startIso) {
      startedInWindow++;
      const p = index.get(day(item.createdAt));
      if (p) p.started++;
    }
    if (item.status === "done" || item.status === "failed") {
      const finished = item.finishedAt ?? item.updatedAt;
      if (finished < startIso) continue;
      byStatus[item.status]++;
      const p = index.get(day(finished));
      if (item.status === "done") {
        doneInWindow++;
        if (p) p.done++;
        const minutes = (Date.parse(finished) - Date.parse(item.createdAt)) / 60_000;
        if (Number.isFinite(minutes) && minutes >= 0) cycles.push(minutes);
      } else {
        failedInWindow++;
        if (p) p.failed++;
      }
    } else {
      byStatus[item.status]++;
    }
  }
  cycles.sort((a, b) => a - b);
  const mid = cycles.length >> 1;
  const medianCycleMinutes = cycles.length ? Math.round(cycles.length % 2 ? cycles[mid]! : (cycles[mid - 1]! + cycles[mid]!) / 2) : null;
  return { byStatus, daily, windowDays, startedInWindow, doneInWindow, failedInWindow, medianCycleMinutes, totalTracked };
}
