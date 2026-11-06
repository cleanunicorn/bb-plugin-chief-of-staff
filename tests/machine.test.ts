import { describe, expect, it } from "vitest";
import { transition, rosterStatus, type MachinePolicy } from "../src/machine";
import type { WorkItem } from "../src/state";

const base: WorkItem = {
  id: "w1",
  repo: "acme/app",
  issueNumber: 12,
  issueTitle: "Fix login",
  threadId: "thr_1",
  environmentId: "env_1",
  branch: "cos/issue-12-fix-login",
  prNumber: null,
  prUrl: null,
  status: "running",
  providerId: "claude-code",
  model: null,
  fixAttempts: 0,
  retryCount: 0,
  lastError: null,
  checkOutput: null,
  source: "intake",
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  lastActivityAt: null,
  finishedAt: null,
  waitingReason: null,
};
const policy: MachinePolicy = { maxFixRetries: 1, autoRetryStalled: false, maxAutoRetries: 1 };

describe("issue → thread → PR state machine", () => {
  it("walks the happy path: spawn → idle → checks → PR → CI green → merged", () => {
    let item: WorkItem = { ...base, status: "queued", threadId: null };
    let t = transition(item, { type: "thread_spawned", threadId: "thr_1", environmentId: "env_1" }, policy);
    expect(t.status).toBe("running");
    item = { ...item, ...t.patch, status: t.status } as WorkItem;

    t = transition(item, { type: "thread_idle" }, policy);
    expect(t.status).toBe("checking");
    expect(t.effects).toEqual([{ type: "run_checks" }]);
    item = { ...item, status: t.status };

    t = transition(item, { type: "checks_passed" }, policy);
    expect(t.effects).toEqual([{ type: "open_pr" }]);

    t = transition(item, { type: "pr_opened", prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" }, policy);
    expect(t.status).toBe("pr_open");
    item = { ...item, ...t.patch, status: t.status } as WorkItem;

    t = transition(item, { type: "ci_passing" }, policy);
    expect(t.status).toBe("pr_open");
    t = transition(item, { type: "pr_merged" }, policy);
    expect(t.status).toBe("done");
    expect(rosterStatus({ ...item, status: "done" })).toBe("done");
  });

  it("feeds a failing check back once, then escalates to a human", () => {
    const checking = { ...base, status: "checking" as const };
    const first = transition(checking, { type: "checks_failed", output: "boom" }, policy);
    expect(first.status).toBe("fixing");
    expect(first.patch.fixAttempts).toBe(1);
    expect(first.effects[0]).toMatchObject({ type: "send_fix_prompt", reason: "checks" });

    const again = transition({ ...checking, fixAttempts: 1 }, { type: "checks_failed", output: "boom" }, policy);
    expect(again.status).toBe("waiting_on_human");
    expect(again.effects[0].type).toBe("notify");
    expect(rosterStatus({ ...checking, status: "waiting_on_human" })).toBe("waiting on human");
  });

  it("re-runs checks after a fix cycle and pushes to the existing PR", () => {
    const fixing = { ...base, status: "fixing" as const, prNumber: 7, fixAttempts: 1 };
    const idle = transition(fixing, { type: "thread_idle" }, policy);
    expect(idle.status).toBe("checking");
    const passed = transition({ ...fixing, status: "checking" }, { type: "checks_passed" }, policy);
    expect(passed.status).toBe("pr_open");
    expect(passed.effects).toEqual([{ type: "watch_ci" }]);
  });

  it("handles CI failure with the configured retry budget", () => {
    const open = { ...base, status: "pr_open" as const, prNumber: 7 };
    const fix = transition(open, { type: "ci_failing", log: "test failed" }, { ...policy, maxFixRetries: 2 });
    expect(fix.status).toBe("fixing");
    const exhausted = transition({ ...open, fixAttempts: 2 }, { type: "ci_failing", log: "test failed" }, { ...policy, maxFixRetries: 2 });
    expect(exhausted.status).toBe("waiting_on_human");
  });

  it("ignores CI events for items that are not watching a PR", () => {
    const running = { ...base };
    expect(transition(running, { type: "ci_failing", log: "x" }, policy).status).toBe("running");
    expect(transition(running, { type: "ci_passing" }, policy).status).toBe("running");
  });

  it("blocks stalled threads, or respawns once when auto-retry is on", () => {
    const blocked = transition(base, { type: "stalled" }, policy);
    expect(blocked.status).toBe("blocked");
    expect(blocked.effects.some((e) => e.type === "notify")).toBe(true);

    const retry = transition(base, { type: "stalled" }, { ...policy, autoRetryStalled: true });
    expect(retry.status).toBe("queued");
    expect(retry.patch.retryCount).toBe(1);
    expect(retry.effects.some((e) => e.type === "respawn")).toBe(true);

    const noMore = transition({ ...base, retryCount: 1 }, { type: "stalled" }, { ...policy, autoRetryStalled: true });
    expect(noMore.status).toBe("blocked");
  });

  it("marks failed threads and notifies; done items are immutable", () => {
    const failed = transition(base, { type: "thread_failed", error: "provider crashed" }, policy);
    expect(failed.status).toBe("failed");
    expect(failed.patch.lastError).toBe("provider crashed");
    const done = { ...base, status: "done" as const };
    expect(transition(done, { type: "thread_failed", error: "x" }, policy).status).toBe("done");
    expect(transition(done, { type: "thread_waiting_on_human" }, policy).status).toBe("done");
  });

  it("human resume returns to PR watching when a PR exists", () => {
    const waiting = { ...base, status: "waiting_on_human" as const, prNumber: 7, fixAttempts: 1 };
    const resumed = transition(waiting, { type: "human_resume" }, policy);
    expect(resumed.status).toBe("pr_open");
    expect(resumed.patch.fixAttempts).toBe(0);
    const noPr = transition({ ...waiting, prNumber: null }, { type: "human_resume" }, policy);
    expect(noPr.status).toBe("running");
  });

  it("resumes parked items when the thread becomes active again", () => {
    for (const status of ["waiting_on_human", "blocked", "failed"] as const) {
      const parked = { ...base, status, fixAttempts: 1, lastError: "stalled", finishedAt: status === "failed" ? "2026-11-05T01:00:00Z" : null };
      const next = transition(parked, { type: "thread_active" }, policy);
      expect(next.status).toBe("running");
      expect(next.patch).toMatchObject({ fixAttempts: 0, lastError: null, finishedAt: null });
    }
    // More work on an open PR: back to running so the next idle re-checks and pushes.
    expect(transition({ ...base, status: "pr_open", prNumber: 7 }, { type: "thread_active" }, policy).status).toBe("running");
    // Our own fix prompt or an in-flight check does not change state.
    expect(transition({ ...base, status: "fixing" }, { type: "thread_active" }, policy).status).toBe("fixing");
    expect(transition({ ...base, status: "checking" }, { type: "thread_active" }, policy).status).toBe("checking");
    expect(transition({ ...base, status: "done" }, { type: "thread_active" }, policy).status).toBe("done");
  });

  it("records the question the agent is waiting on and notifies once per question", () => {
    const asked = transition(base, { type: "thread_waiting_on_human", reason: "Question: Which DB?" }, policy);
    expect(asked.status).toBe("waiting_on_human");
    expect(asked.patch.waitingReason).toBe("Question: Which DB?");
    expect(asked.effects[0]).toMatchObject({ type: "notify", body: "Question: Which DB?" });
    const waiting = { ...base, status: "waiting_on_human" as const, waitingReason: "Question: Which DB?" };
    expect(transition(waiting, { type: "thread_waiting_on_human", reason: "Question: Which DB?" }, policy).effects).toEqual([]);
    expect(transition(waiting, { type: "thread_waiting_on_human" }, policy).effects).toEqual([]);
    expect(transition(waiting, { type: "thread_waiting_on_human", reason: "Approval needed for command" }, policy).effects).toHaveLength(1);
  });
});
