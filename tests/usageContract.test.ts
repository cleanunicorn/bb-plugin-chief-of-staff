// Usage fields survive the RPC contract: zod strips keys it does not declare,
// and the UI tests mock the RPC, so they would not notice.
import { expect, it } from "vitest";
import { rpcContract } from "../rpcContract";
import { entry } from "./helpers/roster";

it("keeps a roster entry's usage, with its thread counts and whether it is counted", () => {
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: { amount: 0.5, currency: "USD" }, threads: 5, reportedThreads: 4, counted: false };
  const parsed = rpcContract.cos_roster.output.parse({ entries: [entry({ usage })], nextBefore: null, finishedTokens: null });
  expect(parsed.entries[0]!.usage).toEqual(usage);
});

it("keeps the stats' usage and tokens per day", () => {
  const usage = { totalTokens: 10, cost: [{ amount: 1, currency: "USD" }], counted: 1, unreported: 2, pending: 3, medianTokensPerDone: 10 };
  const daily = [{ date: "2026-11-01", started: 1, done: 1, failed: 0, tokens: 10 }, { date: "2026-11-02", started: 0, done: 0, failed: 0, tokens: null }];
  const parsed = rpcContract.cos_stats.output.parse({ byStatus: {}, daily, windowDays: 2, startedInWindow: 1, doneInWindow: 1, failedInWindow: 0, medianCycleMinutes: null, totalTracked: 1, usage });
  expect(parsed.usage).toEqual(usage);
  expect(parsed.daily).toEqual(daily);
});

it("orders finished tasks recently finished first by default, and keeps the finished tokens", () => {
  expect(rpcContract.cos_roster.input.parse({}).finishedOrder).toBe("recent");
  expect(rpcContract.cos_roster.input.parse({ finishedOrder: "tokens" }).finishedOrder).toBe("tokens");
  expect(() => rpcContract.cos_roster.input.parse({ finishedOrder: "cost" })).toThrow();
  expect(rpcContract.cos_roster.output.parse({ entries: [], nextBefore: null, finishedTokens: 42 }).finishedTokens).toBe(42);
});

it("keeps a task's usage in the workflow view and in cos_item_usage", () => {
  const usage = { inputTokens: null, outputTokens: null, totalTokens: 7, cost: null, threads: 2, reportedThreads: 1, counted: true };
  const task = { repo: "a/b", issueNumber: null, issueUrl: null, body: null, status: "done", branch: null, prNumber: null, prUrl: null, threadId: null, waitingReason: null, lastError: null, createdAt: "x", lastActivityAt: null, finishedAt: "y", usage };
  expect(rpcContract.cos_item_workflow.output.parse({ title: "t", workflow: {}, live: {}, task }).task!.usage).toEqual(usage);
  expect(rpcContract.cos_item_usage.output.parse({ usage })).toEqual({ usage });
  expect(rpcContract.cos_item_usage.output.parse({ usage: null })).toEqual({ usage: null });
});
