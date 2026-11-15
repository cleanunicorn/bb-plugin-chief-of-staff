// "Since you were here" (#110): what finished after a time, and why the failures ended.
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, StateStore, type NewWorkItem } from "../src/state";
import { freshNode } from "../src/machine";
import { workflowSchema } from "../src/workflow";
import { endReason, MARKED_FAILED, PR_CLOSED_ERROR } from "../src/outcome";
import { sinceSummary, SINCE_FAILURES } from "../src/since";

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [{ id: "build", name: "Build", type: "agent", writes: true }] });

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function setup() {
  const host = createFakePluginHost({ pluginId: "since" });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  let clock = Date.parse("2026-11-14T10:00:00Z");
  const store = new StateStore(db, () => new Date(clock));
  let n = 0;
  /** A task that finished at `at` (ISO), done or failed with `lastError`. */
  const finished = (status: "done" | "failed", at: string, over: Partial<NewWorkItem> = {}) => {
    const id = `w${++n}`;
    store.insertWorkItem({
      id, repo: "acme/app", status, issueTitle: `Task ${id}`, issueNumber: n, branch: id, threadId: null, environmentId: null, prNumber: null, prUrl: null,
      providerId: null, model: null, lastError: status === "failed" ? "Thread archived" : null, source: "issue", lastActivityAt: null, finishedAt: at, workflow,
      nodes: { build: { ...freshNode(), status: "done" } }, ...over,
    });
    return id;
  };
  const log = (workItemId: string, message: string, at: string) => {
    clock = Date.parse(at);
    store.log({ level: "info", kind: "manual", repo: "acme/app", workItemId, message, actor: "test" });
  };
  return { db, store, finished, log };
}

const SINCE = "2026-11-14T08:00:00.000Z";

describe("store.finishedSince", () => {
  it("counts done and failed tasks finished after the time, and none before or at it", () => {
    const { store, finished } = setup();
    finished("done", "2026-11-14T07:59:59.000Z");
    finished("done", SINCE);
    finished("failed", "2026-11-13T09:00:00.000Z");
    finished("done", "2026-11-14T08:00:01.000Z");
    finished("done", "2026-11-14T09:30:00.000Z");
    finished("failed", "2026-11-14T09:00:00.000Z");
    store.insertWorkItem({ id: "active", repo: "acme/app", status: "agent", issueTitle: "Active", issueNumber: 99, branch: "a", threadId: null, environmentId: null, prNumber: null, prUrl: null, providerId: null, model: null, lastError: null, source: "issue", lastActivityAt: null, finishedAt: null, workflow, nodes: { build: freshNode() } });
    const result = store.finishedSince(SINCE, 3);
    expect(result.shipped).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures.map((i) => i.id)).toEqual(["w6"]);
  });

  it("uses the update time of a legacy row without a finish time", () => {
    const { db, store, finished } = setup();
    const id = finished("done", "2026-11-14T09:00:00.000Z");
    db.prepare("UPDATE work_items SET finished_at = NULL, updated_at = ? WHERE id = ?").run("2026-11-14T09:00:00.000Z", id);
    expect(store.finishedSince(SINCE, 3).shipped).toBe(1);
    expect(store.finishedSince("2026-11-14T09:00:00.000Z", 3).shipped).toBe(0);
  });

  it("lists failures newest first, at most `limit`, while counting them all", () => {
    const { store, finished } = setup();
    for (const at of ["09:00", "09:10", "09:20", "09:30", "09:40"]) finished("failed", `2026-11-14T${at}:00.000Z`);
    const result = store.finishedSince(SINCE, 3);
    expect(result.failed).toBe(5);
    expect(result.failures.map((i) => i.finishedAt)).toEqual(["2026-11-14T09:40:00.000Z", "2026-11-14T09:30:00.000Z", "2026-11-14T09:20:00.000Z"]);
  });

  it("is empty when nothing finished", () => {
    const { store } = setup();
    expect(store.finishedSince(SINCE, 3)).toEqual({ shipped: 0, failed: 0, failures: [] });
  });
});

describe("endReason", () => {
  it("is the stored error of a task that did not deliver, except the marked failed label", () => {
    expect(endReason("failed", "Thread archived")).toBe("Thread archived");
    expect(endReason("pr_closed", PR_CLOSED_ERROR)).toBe(PR_CLOSED_ERROR);
    expect(endReason("marked_failed", MARKED_FAILED)).toBeNull();
    expect(endReason("marked_failed", "old error")).toBe("old error");
    expect(endReason("merged", "stale error")).toBeNull();
    expect(endReason(null, "error")).toBeNull();
    expect(endReason("failed", null)).toBeNull();
  });
});

describe("sinceSummary", () => {
  it("names each failure with how it ended and why", () => {
    const { store, finished, log } = setup();
    finished("done", "2026-11-14T08:30:00.000Z");
    const archived = finished("failed", "2026-11-14T09:00:00.000Z");
    const closed = finished("failed", "2026-11-14T09:10:00.000Z", { lastError: PR_CLOSED_ERROR, prNumber: 4 });
    const marked = finished("failed", "2026-11-14T09:20:00.000Z", { lastError: MARKED_FAILED });
    // An older task marked failed before MARKED_FAILED was stored: the manual log row says so.
    const legacy = finished("failed", "2026-11-14T09:30:00.000Z", { lastError: "Build broke once" });
    log(legacy, "marked failed", "2026-11-14T09:29:50.000Z");
    const summary = sinceSummary(store, SINCE);
    expect(summary.shipped).toBe(1);
    expect(summary.failed).toBe(4);
    expect(summary.failures).toHaveLength(SINCE_FAILURES);
    expect(summary.failures).toEqual([
      { id: legacy, repo: "acme/app", issueNumber: 4 + 1, issueTitle: `Task ${legacy}`, outcome: "marked_failed", reason: "Build broke once" },
      { id: marked, repo: "acme/app", issueNumber: 4, issueTitle: `Task ${marked}`, outcome: "marked_failed", reason: null },
      { id: closed, repo: "acme/app", issueNumber: 3, issueTitle: `Task ${closed}`, outcome: "pr_closed", reason: PR_CLOSED_ERROR },
    ]);
    expect(summary.failures.map((f) => f.id)).not.toContain(archived);
  });

  it("gives the reason of a failed thread", () => {
    const { store, finished } = setup();
    finished("failed", "2026-11-14T09:00:00.000Z");
    expect(sinceSummary(store, SINCE).failures).toEqual([expect.objectContaining({ outcome: "failed", reason: "Thread archived" })]);
  });

  it("compares any offset as an instant", () => {
    const { store, finished } = setup();
    finished("done", "2026-11-14T08:30:00.000Z");
    // 10:00 at +02:00 is 08:00Z: the task finished after it.
    expect(sinceSummary(store, "2026-11-14T10:00:00+02:00").shipped).toBe(1);
    expect(sinceSummary(store, "2026-11-14T10:31:00+02:00").shipped).toBe(0);
  });
});
