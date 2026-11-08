import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, StateStore, type NewWorkItem } from "../src/state";
import { DEFAULT_POLICY, freshNode } from "../src/machine";
import { workflowSchema } from "../src/workflow";
import { dispatch, settleJobs, watchCi } from "../src/delivery";
import { tickItems } from "../src/sync";
import type { Cos } from "../src/context";

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
  { id: "ship", name: "Ship", type: "ship", action: "merge", onFail: "build" },
] });
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await settleJobs(); for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
function setup() {
  const host = createFakePluginHost({ pluginId: "test", sdk: { threads: { send: async () => ({ ok: true, delivery: "sent" }) as never } } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  const store = new StateStore(db);
  const repo = { owner: "a", repo: "b", maxConcurrent: 1 };
  const cos = { bb: host.bb, store, now: () => new Date(), config: async () => ({ policy: DEFAULT_POLICY, repos: [repo], values: { maxConcurrentTotal: 1, archiveThreadsOnDone: false } }), repo: async () => repo, safe: async (s: string) => s, invalidate: () => {}, notify: async () => {} } as unknown as Cos;
  function add(id: string, waiting = false) {
    return store.insertWorkItem({ id, repo: "a/b", status: waiting ? "ci" : "agent", issueTitle: id, issueNumber: null, branch: id, threadId: `thread-${id}`, environmentId: null, prNumber: waiting ? 7 : null, prUrl: null, providerId: null, model: null, lastError: null, source: "task", lastActivityAt: null, finishedAt: null, workflow, nodes: {
      build: { ...freshNode(), round: 1, status: waiting ? "done" : "running" },
      ship: { ...freshNode(), round: 1, status: waiting ? "running" : "pending", phase: waiting ? "ci" : null },
    } } satisfies NewWorkItem);
  }
  return { host, cos, store, add, db };
}

describe("shipping repair admission", () => {
  it("persists a queued CI repair, deduplicates polls, and resumes once after capacity is released", async () => {
    const { cos, store, add, host, db } = setup();
    add("a", true); add("b");
    await dispatch(cos, "a", { type: "ci_failing", log: "red check" }, "test");
    expect(store.getWorkItem("a")!.status).toBe("queued");
    expect(store.getWorkItem("a")!.queuedEvent).toEqual({ type: "ci_failing", log: "red check" });
    expect(store.countOccupied()).toBe(1);
    await dispatch(cos, "a", { type: "ci_failing", log: "duplicate" }, "test");
    await tickItems(cos, "test");
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    cos.store = new StateStore(db); // Reconstruct the store as on restart.
    cos.store.updateWorkItem("b", { status: "done" });
    await tickItems(cos, "test");
    await tickItems(cos, "test");
    expect(cos.store.getWorkItem("a")).toMatchObject({ status: "agent", queuedEvent: null, fixAttempts: 1 });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(JSON.stringify(host.harness.inspection.sdk.callsTo("threads.send"))).toContain("red check");
  });

  it("serializes capacity reservation across concurrent repairs", async () => {
    const { cos, store, add, host } = setup();
    add("a", true); add("b", true);
    await Promise.all(["a", "b"].map((id) => dispatch(cos, id, { type: "ci_failing", log: "failed" }, "test")));
    expect(store.countOccupied()).toBe(1);
    expect([store.getWorkItem("a")!.status, store.getWorkItem("b")!.status].sort()).toEqual(["agent", "queued"]);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });
  it("queues a successor after merge without skipping it", async () => {
    const { cos, store, add, host } = setup();
    const a = add("a", true); add("b");
    const extended = workflowSchema.parse({ ...workflow, steps: [
      workflow.steps[0], { ...workflow.steps[1], next: ["follow"] },
      { id: "follow", name: "Follow", type: "agent", writes: true },
    ] });
    store.updateWorkItem(a.id, { workflow: extended, nodes: { ...a.nodes, follow: freshNode() } });
    await dispatch(cos, a.id, { type: "pr_merged" }, "test");
    expect(store.getWorkItem(a.id)).toMatchObject({ status: "queued", queuedEvent: { type: "pr_merged" } });
    store.updateWorkItem("b", { status: "done" });
    await tickItems(cos, "test");
    expect(store.getWorkItem(a.id)).toMatchObject({ status: "agent", nodes: { ship: { status: "done" }, follow: { status: "running" } } });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    cos.github = async () => { throw new Error("Delivery is finished: do not poll its PR"); };
    await expect(watchCi(cos, "test")).resolves.toBeUndefined();
  });

  it("applies global capacity across repositories and gates operator reruns", async () => {
    const { cos, store, add, host } = setup();
    add("a", true); add("b");
    store.updateWorkItem("b", { repo: "other/repo" });
    const config = await cos.config();
    config.repos.push({ ...config.repos[0], owner: "other", repo: "repo" });
    cos.config = async () => config;
    await dispatch(cos, "a", { type: "rerun", step: "build", feedback: "retry manually" }, "test");
    expect(store.getWorkItem("a")!.status).toBe("queued");
    expect(store.countOccupied("a/b")).toBe(0);
    expect(store.countOccupied()).toBe(1);
    await dispatch(cos, "a", { type: "retry" }, "test");
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    store.updateWorkItem("b", { status: "failed" });
    await tickItems(cos, "test");
    expect(store.getWorkItem("a")!.status).toBe("agent");
    expect(JSON.stringify(host.harness.inspection.sdk.callsTo("threads.send"))).toContain("retry manually");
  });

  it("upgrades a database whose previous migrations were already applied", () => {
    const host = createFakePluginHost({ pluginId: "upgrade" }); hosts.push(host);
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS.filter((sql) => !sql.includes("ADD COLUMN queued_event_json")));
    expect(() => host.bb.storage.migrate(db, MIGRATIONS)).not.toThrow();
    expect(db.prepare("PRAGMA table_info(work_items)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "queued_event_json" })]));
  });

});
