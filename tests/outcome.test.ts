import { describe, expect, it } from "vitest";
import { freshNode, type Nodes } from "../src/machine";
import { describeOutcome, endSummary, finishedOutcome, MARKED_DONE, MARKED_FAILED, OUTCOME_META, OUTCOMES, PR_CLOSED_ERROR } from "../src/outcome";
import { describeActivity } from "../src/roster";
import { outcomeSchema } from "../rpcContract";
import type { WorkItem } from "../src/state";
import { workflowSchema, type Workflow } from "../src/workflow";

const wf = (action: "pr" | "merge" | "push" | null): Workflow => workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, ...(action ? { next: ["ship"] } : {}) },
  ...(action ? [{ id: "ship", name: "Ship", type: "ship", action }] : []),
] });

const FINISHED = "2026-11-12T10:00:00.000Z";
const done = (over: Partial<NodeStatusMap> = {}): Nodes => {
  const status: NodeStatusMap = { build: "done", ship: "done", ...over };
  return Object.fromEntries(Object.entries(status).map(([id, s]) => [id, { ...freshNode(), status: s }]));
};
type NodeStatusMap = Record<string, Nodes[string]["status"]>;

function item(over: Partial<WorkItem> = {}): Pick<WorkItem, "status" | "lastError" | "prNumber" | "finishedAt" | "workflow" | "nodes"> {
  return { status: "done", lastError: null, prNumber: null, finishedAt: FINISHED, workflow: wf("pr"), nodes: done(), ...over };
}
const marker = (message: string, secondsBefore = 0) => ({ message, at: new Date(Date.parse(FINISHED) - secondsBefore * 1000).toISOString() });

describe("finishedOutcome", () => {
  // The engine stores these on a close, and logs the "marked …" row only after finishedAt is set.
  it("reads a hand-closed task from its stored error, without a log row", () => {
    expect(finishedOutcome(item({ prNumber: 7, lastError: MARKED_DONE }), null)).toBe("marked_done");
    expect(finishedOutcome(item({ status: "failed", lastError: MARKED_FAILED }), null)).toBe("marked_failed");
    expect(finishedOutcome(item({ status: "failed", lastError: MARKED_FAILED }), marker("marked failed", -1))).toBe("marked_failed");
  });

  it("reads a delivered PR as PR opened, whatever stale error it holds", () => {
    expect(finishedOutcome(item({ prNumber: 7, lastError: "Cannot read properties of undefined (reading 'length')" }), null)).toBe("pr_opened");
  });

  it("reads Merged only when a merge ship step completed", () => {
    expect(finishedOutcome(item({ prNumber: 7, workflow: wf("merge") }), null)).toBe("merged");
  });

  it("does not read Merged when a refused ship step was approved past with no PR", () => {
    expect(finishedOutcome(item({ prNumber: null, workflow: wf("merge") }), null)).toBe("completed");
  });

  it("reads push-only and ship-less workflows as Completed", () => {
    expect(finishedOutcome(item({ workflow: wf("push") }), null)).toBe("completed");
    expect(finishedOutcome(item({ workflow: wf(null), nodes: { build: { ...freshNode(), status: "done" } } }), null)).toBe("completed");
  });

  it("reads a hand-marked task as Marked done, with or without its log marker", () => {
    const waiting = item({ nodes: done({ ship: "waiting" }) });
    expect(finishedOutcome(waiting, marker("marked done", 1))).toBe("marked_done");
    expect(finishedOutcome(waiting, null)).toBe("marked_done");
    expect(finishedOutcome(item({ prNumber: 7 }), marker("marked done"))).toBe("marked_done");
  });

  it("does not read legacy rows without step state as hand-marked", () => {
    expect(finishedOutcome(item({ nodes: {} }), null)).toBe("completed");
  });

  it("ignores a marker left from before the task was reopened", () => {
    expect(finishedOutcome(item({ prNumber: 7 }), marker("marked done", 3600))).toBe("pr_opened");
    expect(finishedOutcome(item({ status: "failed", lastError: "thread archived" }), marker("marked failed", 3600))).toBe("failed");
  });

  it("ignores a marker dated after the finish", () => {
    expect(finishedOutcome(item({ prNumber: 7 }), marker("marked done", -5))).toBe("pr_opened");
  });

  it("reads a task marked failed and then marked done as Marked done", () => {
    expect(finishedOutcome(item({ prNumber: 7 }), marker("marked done"))).toBe("marked_done");
  });

  it("falls back to Failed for a hand-failed task once its log row is pruned", () => {
    // Not wrong (the task did fail), just less specific.
    expect(finishedOutcome(item({ status: "failed", lastError: "push rejected" }), null)).toBe("failed");
  });

  it("tells the failure outcomes apart", () => {
    expect(finishedOutcome(item({ status: "failed", lastError: "thread archived" }), null)).toBe("failed");
    expect(finishedOutcome(item({ status: "failed", lastError: PR_CLOSED_ERROR, prNumber: 7 }), null)).toBe("pr_closed");
    expect(finishedOutcome(item({ status: "failed", lastError: "thread archived" }), marker("marked failed", 2))).toBe("marked_failed");
    expect(finishedOutcome(item({ status: "failed", lastError: null }), null)).toBe("marked_failed");
  });

  it("is null on active items", () => {
    for (const status of ["queued", "agent", "ci", "waiting_on_human"] as const) expect(finishedOutcome(item({ status }), null)).toBeNull();
  });
});

describe("OUTCOME_META", () => {
  it("gives every outcome its own label and icon", () => {
    const labels = OUTCOMES.map((o) => OUTCOME_META[o].label);
    const icons = OUTCOMES.map((o) => OUTCOME_META[o].icon);
    expect(new Set(labels).size).toBe(OUTCOMES.length);
    expect(new Set(icons).size).toBe(OUTCOMES.length);
  });
});

describe("describeActivity on finished items", () => {
  const full = (over: Partial<WorkItem>): WorkItem => ({ ...item(over), id: "x", repo: "a/b", issueNumber: 1, issueTitle: "x", threadId: null, environmentId: null, branch: null, prUrl: null, providerId: null, model: null, fixAttempts: 0, retryCount: 0, source: "task", createdAt: FINISHED, updatedAt: FINISHED, lastActivityAt: null, waitingReason: null, waitingKind: null, jobStartedAt: null, taskBody: null, ...over } as WorkItem);

  it("says how the task ended, never a stale error on a delivered one", () => {
    expect(describeActivity(full({ prNumber: 7, lastError: "Cannot read properties of undefined (reading 'length')" }))).toBe("PR opened");
  });

  it("adds why on the failure outcomes", () => {
    expect(describeActivity(full({ status: "failed", lastError: "thread archived" }))).toBe("Failed: thread archived");
    expect(describeActivity(full({ status: "failed", lastError: PR_CLOSED_ERROR }))).toBe(PR_CLOSED_ERROR);
    expect(describeActivity(full({ status: "failed", lastError: null }))).toBe("Marked failed");
    // A person ended it: a stored error is only the last one seen, not the cause.
    expect(describeOutcome("marked_failed", "Cannot read properties of undefined (reading 'length')")).toBe("Marked failed (last error: Cannot read properties of undefined (reading 'length'))");
  });
});

describe("endSummary", () => {
  it("gives the label and, when it did not deliver, why", () => {
    expect(endSummary("failed", "thread archived")).toEqual({ headline: "Failed", reason: { lead: "Why it ended", text: "thread archived" } });
    expect(endSummary("merged", "flaky CI")).toEqual({ headline: "Merged", reason: null });
    expect(endSummary("failed", null)).toEqual({ headline: "Failed", reason: null });
  });

  it("calls an older error on a task failed by hand the last error, and drops the marker", () => {
    expect(endSummary("marked_failed", "push rejected")).toEqual({ headline: "Marked failed", reason: { lead: "Last error", text: "push rejected" } });
    expect(endSummary("marked_failed", MARKED_FAILED)).toEqual({ headline: "Marked failed", reason: null });
  });

  it("does not repeat a reason that already says the label", () => {
    expect(endSummary("pr_closed", PR_CLOSED_ERROR)).toEqual({ headline: PR_CLOSED_ERROR, reason: null });
  });

  it("keeps the label on a failure whose error happens to start with it", () => {
    expect(endSummary("failed", "Failed to push branch")).toEqual({ headline: "Failed", reason: { lead: "Why it ended", text: "Failed to push branch" } });
    expect(describeOutcome("failed", "failed to push branch")).toBe("Failed: failed to push branch");
  });
});

describe("the RPC contract's outcomes", () => {
  it("match OUTCOMES", () => {
    expect(outcomeSchema.options).toEqual([...OUTCOMES]);
  });
});
