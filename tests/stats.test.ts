import { describe, expect, it } from "vitest";
import { computeStats } from "../src/stats";
import type { WorkItem } from "../src/state";
import { DEFAULT_WORKFLOW } from "../src/workflow";

const now = new Date("2026-11-05T12:00:00Z");
function item(over: Partial<WorkItem>): WorkItem {
  return {
    waitingKind: null, jobStartedAt: null, taskBody: null, workflow: DEFAULT_WORKFLOW, nodes: {},
    id: Math.random().toString(36).slice(2), repo: "o/r", issueNumber: 1, issueTitle: "t", threadId: null, environmentId: null,
    branch: null, prNumber: null, prUrl: null, status: "agent", providerId: null, model: null, fixAttempts: 0, retryCount: 0,
    lastError: null, source: "intake", createdAt: "2026-11-04T10:00:00Z", updatedAt: "2026-11-04T10:00:00Z",
    lastActivityAt: null, finishedAt: null, waitingReason: null, prState: null, ...over,
  };
}

describe("computeStats", () => {
  it("counts active statuses, windows terminal ones, and buckets by day", () => {
    const items = [
      item({ status: "agent" }),
      item({ status: "ci" }),
      item({ status: "done", createdAt: "2026-11-03T10:00:00Z", finishedAt: "2026-11-03T12:00:00Z" }),
      item({ status: "done", createdAt: "2026-11-04T10:00:00Z", finishedAt: "2026-11-04T14:00:00Z" }),
      item({ status: "failed", finishedAt: "2026-11-05T09:00:00Z" }),
      item({ status: "done", createdAt: "2026-09-01T00:00:00Z", finishedAt: "2026-09-02T00:00:00Z" }), // outside window
    ];
    const s = computeStats(items, now, 14);
    expect(s.daily).toHaveLength(14);
    expect(s.daily.at(-1)!.date).toBe("2026-11-05");
    expect(s.byStatus.agent).toBe(1);
    expect(s.byStatus.ci).toBe(1);
    expect(s.doneInWindow).toBe(2);
    expect(s.failedInWindow).toBe(1);
    expect(s.medianCycleMinutes).toBe(180);
    expect(s.daily.find((d) => d.date === "2026-11-03")!.done).toBe(1);
    expect(s.daily.at(-1)!.failed).toBe(1);
  });
});

describe("usage in stats", () => {
  const usage = (totalTokens: number | null, cost: { amount: number; currency: string } | null = null) => ({ inputTokens: null, outputTokens: null, totalTokens, cost, threads: 3, reportedThreads: totalTokens == null && !cost ? 0 : 2 });
  const finished = (status: "done" | "failed", finishedAt: string, taskUsage: ReturnType<typeof usage> | null, createdAt = "2026-10-01T00:00:00Z") => item({ status, createdAt, finishedAt, taskUsage });

  it("totals finished tasks' tokens for the window and per day, by the day they finished", () => {
    const s = computeStats([
      finished("done", "2026-11-03T12:00:00Z", usage(1_000, { amount: 0.25, currency: "USD" })),
      finished("done", "2026-11-03T18:00:00Z", usage(3_000, { amount: 0.5, currency: "USD" })),
      // Failed runs count towards the total, not the median.
      finished("failed", "2026-11-05T09:00:00Z", usage(10_000, { amount: 2, currency: "EUR" })),
      finished("done", "2026-11-04T09:00:00Z", usage(2_000)),
      // Outside the window, and active: neither counts.
      finished("done", "2026-09-02T00:00:00Z", usage(99_000)),
      item({ status: "agent", taskUsage: usage(77_000) }),
    ], now, 14);
    expect(s.usage).toEqual({ totalTokens: 16_000, cost: [{ amount: 2, currency: "EUR" }, { amount: 0.75, currency: "USD" }], counted: 4, unreported: 0, pending: 0, medianTokensPerDone: 2_000 });
    expect(s.daily.find((d) => d.date === "2026-11-03")!.tokens).toBe(4_000);
    expect(s.daily.find((d) => d.date === "2026-11-04")!.tokens).toBe(2_000);
    expect(s.daily.find((d) => d.date === "2026-11-05")!.tokens).toBe(10_000);
  });

  it("counts tasks with no reported usage and tasks not counted yet, never adding them as 0", () => {
    const s = computeStats([
      finished("done", "2026-11-03T12:00:00Z", usage(null)),
      finished("done", "2026-11-04T12:00:00Z", null),
      finished("failed", "2026-11-04T13:00:00Z", null),
    ], now, 14);
    expect(s.usage).toEqual({ totalTokens: null, cost: [], counted: 0, unreported: 1, pending: 2, medianTokensPerDone: null });
    expect(s.daily.every((d) => d.tokens === null)).toBe(true);
  });

  it("keeps a real 0 apart from no report, and the median covers done tasks with tokens only", () => {
    const s = computeStats([
      finished("done", "2026-11-03T12:00:00Z", usage(0)),
      finished("done", "2026-11-03T13:00:00Z", usage(null)),
      finished("done", "2026-11-04T12:00:00Z", usage(400)),
      finished("failed", "2026-11-04T12:00:00Z", usage(1_000_000)),
    ], now, 14);
    expect(s.usage).toMatchObject({ totalTokens: 1_000_400, counted: 3, unreported: 1, pending: 0, medianTokensPerDone: 200 });
    expect(s.daily.find((d) => d.date === "2026-11-03")!.tokens).toBe(0);
    expect(s.daily.find((d) => d.date === "2026-11-02")!.tokens).toBeNull();
  });

  it("treats rows without a usage field (not counted) as pending", () => {
    const s = computeStats([{ status: "done", createdAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z" }], now, 14);
    expect(s.usage.pending).toBe(1);
    expect(s.usage.totalTokens).toBeNull();
  });
});
