// Aggregates for the dashboard: pipeline counts by stage, daily throughput,
// cycle time, and the token usage of tasks finished in the window.
// Pure over the stored scalar columns so it is cheap to test.
import { WORK_STATUSES, type WorkItem, type WorkStatus } from "./state";

export interface DailyPoint {
  date: string; // YYYY-MM-DD (UTC)
  started: number;
  done: number;
  failed: number;
  /** Tokens of the tasks that finished that day; null when none of them reported tokens. */
  tokens: number | null;
}

/**
 * Token usage of the done and failed tasks that finished in the window, each
 * summed over all its agent threads. Tasks without reported tokens are
 * counted, never added as 0.
 */
export interface UsageStats {
  /** Null when no task in the window reported tokens. */
  totalTokens: number | null;
  /** Summed per currency, for tasks whose provider reports cost. */
  cost: { amount: number; currency: string }[];
  /** Tasks counted with reported tokens. */
  counted: number;
  /** Tasks counted whose threads reported no tokens. */
  unreported: number;
  /** Tasks whose usage is not counted yet. */
  pending: number;
  /** Median tokens of a done task, over done tasks with reported tokens. */
  medianTokensPerDone: number | null;
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
  usage: UsageStats;
}

/** The columns stats are computed from (see StateStore.statsRows). */
export type StatsItem = Pick<WorkItem, "status" | "createdAt" | "finishedAt" | "updatedAt" | "taskUsage">;

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
};

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
    const point: DailyPoint = { date: d, started: 0, done: 0, failed: 0, tokens: null };
    daily.push(point);
    index.set(d, point);
  }
  const cycles: number[] = [];
  let startedInWindow = 0;
  let doneInWindow = 0;
  let failedInWindow = 0;
  const usage: UsageStats = { totalTokens: null, cost: [], counted: 0, unreported: 0, pending: 0, medianTokensPerDone: null };
  const costs = new Map<string, number>();
  const doneTokens: number[] = [];
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
      const tokens = item.taskUsage?.totalTokens;
      if (!item.taskUsage) usage.pending++;
      else if (tokens == null) usage.unreported++;
      else {
        usage.counted++;
        usage.totalTokens = (usage.totalTokens ?? 0) + tokens;
        if (p) p.tokens = (p.tokens ?? 0) + tokens;
        if (item.status === "done") doneTokens.push(tokens);
      }
      const cost = item.taskUsage?.cost;
      if (cost) costs.set(cost.currency, (costs.get(cost.currency) ?? 0) + cost.amount);
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
  usage.cost = [...costs].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ amount, currency }));
  usage.medianTokensPerDone = median(doneTokens);
  return { byStatus, daily, windowDays, startedInWindow, doneInWindow, failedInWindow, medianCycleMinutes: median(cycles), totalTracked, usage };
}
