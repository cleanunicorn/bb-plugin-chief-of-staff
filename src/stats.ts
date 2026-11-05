// Aggregates for the dashboard: pipeline counts by stage, daily throughput, cycle time and routine outcomes.
// Pure over the stored rows so it is cheap to test.
import { WORK_STATUSES, type RoutineRun, type WorkItem, type WorkStatus } from "./state";

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
  runs: { succeeded: number; failed: number; partial: number; running: number };
}

const day = (iso: string) => iso.slice(0, 10);

export function computeStats(items: WorkItem[], runs: RoutineRun[], now: Date, windowDays = 14): Stats {
  const byStatus = Object.fromEntries(WORK_STATUSES.map((s) => [s, 0])) as Record<WorkStatus, number>;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (windowDays - 1)));
  const daily: DailyPoint[] = [];
  const index = new Map<string, DailyPoint>();
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const point = { date: d, started: 0, done: 0, failed: 0 };
    daily.push(point);
    index.set(d, point);
  }
  const startIso = start.toISOString();
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
  const runCounts = { succeeded: 0, failed: 0, partial: 0, running: 0 };
  for (const run of runs) if (run.startedAt >= startIso) runCounts[run.status]++;
  return { byStatus, daily, windowDays, startedInWindow, doneInWindow, failedInWindow, medianCycleMinutes, totalTracked: items.length, runs: runCounts };
}
