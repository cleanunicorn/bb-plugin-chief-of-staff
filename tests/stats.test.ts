import { describe, expect, it } from "vitest";
import { computeStats } from "../src/stats";
import type { RoutineRun, WorkItem } from "../src/state";

const now = new Date("2026-11-05T12:00:00Z");
function item(over: Partial<WorkItem>): WorkItem {
  return {
    id: Math.random().toString(36).slice(2), repo: "o/r", issueNumber: 1, issueTitle: "t", threadId: null, environmentId: null,
    branch: null, prNumber: null, prUrl: null, status: "running", providerId: null, model: null, fixAttempts: 0, retryCount: 0,
    lastError: null, checkOutput: null, source: "intake", createdAt: "2026-11-04T10:00:00Z", updatedAt: "2026-11-04T10:00:00Z",
    lastActivityAt: null, finishedAt: null, ...over,
  };
}

describe("computeStats", () => {
  it("counts active statuses, windows terminal ones, and buckets by day", () => {
    const items = [
      item({ status: "running" }),
      item({ status: "pr_open" }),
      item({ status: "done", createdAt: "2026-11-03T10:00:00Z", finishedAt: "2026-11-03T12:00:00Z" }),
      item({ status: "done", createdAt: "2026-11-04T10:00:00Z", finishedAt: "2026-11-04T14:00:00Z" }),
      item({ status: "failed", finishedAt: "2026-11-05T09:00:00Z" }),
      item({ status: "done", createdAt: "2026-09-01T00:00:00Z", finishedAt: "2026-09-02T00:00:00Z" }), // outside window
    ];
    const runs: RoutineRun[] = [
      { id: "a", routine: "r", repo: "o/r", triggeredBy: "schedule", dryRun: true, status: "succeeded", startedAt: "2026-11-04T00:00:00Z", finishedAt: null, steps: [] },
      { id: "b", routine: "r", repo: "o/r", triggeredBy: "schedule", dryRun: true, status: "failed", startedAt: "2026-08-01T00:00:00Z", finishedAt: null, steps: [] },
    ];
    const s = computeStats(items, runs, now, 14);
    expect(s.daily).toHaveLength(14);
    expect(s.daily.at(-1)!.date).toBe("2026-11-05");
    expect(s.byStatus.running).toBe(1);
    expect(s.byStatus.pr_open).toBe(1);
    expect(s.doneInWindow).toBe(2);
    expect(s.failedInWindow).toBe(1);
    expect(s.medianCycleMinutes).toBe(180);
    expect(s.daily.find((d) => d.date === "2026-11-03")!.done).toBe(1);
    expect(s.daily.at(-1)!.failed).toBe(1);
    expect(s.runs).toEqual({ succeeded: 1, failed: 0, partial: 0, running: 0 });
  });
});
