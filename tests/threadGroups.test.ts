import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { itemParent, archiveOrder, groupExistingThreads } from "../src/threadGroups";
import { MIGRATIONS, StateStore, type WorkItem } from "../src/state";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import type { Cos } from "../src/context";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose(); });
function setup() {
  const threads = new Map(["plan", "build", "review"].map((id) => [id, makeThreadResponse({ id })]));
  const host = createFakePluginHost({ sdk: { threads: {
    get: async ({ threadId }) => { const t = threads.get(threadId); if (!t) throw Object.assign(new Error("missing"), { status: 404 }); return t; },
    update: async ({ threadId, ...patch }) => { const t = { ...threads.get(threadId)!, ...patch }; threads.set(threadId, t); return t; },
  } } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  const store = new StateStore(db);
  const item = { id: "item", threadId: "build" } as WorkItem;
  for (const threadId of threads.keys()) store.upsertThread({ threadId, itemId: "item", role: "step", stepId: threadId, agent: 0, environmentId: null, round: 0, promptSentAt: null });
  const cos = { bb: host.bb, store, safe: async (s: string) => s } as Cos;
  return { cos, item, threads, host };
}
describe("parent thread grouping", () => {
  it("keeps the original parent through reloads and builder replacement", async () => {
    const { cos, item, threads } = setup();
    expect(await itemParent(cos, item)).toBe("plan");
    threads.get("build")!.parentThreadId = "plan";
    expect(await itemParent({ ...cos }, { ...item, threadId: "review" })).toBe("plan");
  });
  it("recovers an archived or deleted parent without cycles", async () => {
    const { cos, item, threads } = setup();
    expect(await itemParent(cos, item)).toBe("plan");
    threads.get("build")!.parentThreadId = "plan";
    threads.get("review")!.parentThreadId = "plan";
    threads.get("plan")!.archivedAt = 1;
    expect(await itemParent(cos, item)).toBe("build");
    expect(threads.get("build")!.parentThreadId).toBeNull();
    threads.delete("build");
    expect(await itemParent(cos, item)).toBe("review");
  });
  it("does not adopt externally parented threads", async () => {
    const { cos, item, threads } = setup();
    for (const t of threads.values()) t.parentThreadId = "external";
    expect(await itemParent(cos, item)).toBeUndefined();
  });
  it("archives descendants before their parent", async () => {
    const { cos, item, threads } = setup();
    await itemParent(cos, item);
    threads.get("build")!.parentThreadId = "plan";
    threads.get("review")!.parentThreadId = "build";
    expect(await archiveOrder(cos, item)).toEqual(["review", "build", "plan"]);
  });
  it("does not regroup anything while paused", async () => {
    const { cos, host } = setup();
    cos.store.setPaused(true);
    await groupExistingThreads(cos);
    expect(host.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });

  describe("sweeping only items whose threads changed", () => {
    function active(cos: Cos) {
      cos.store.insertWorkItem({ id: "item", repo: "a/b", status: "agent", issueTitle: "t", issueNumber: null, branch: null, threadId: "build", environmentId: null, prNumber: null, prUrl: null, providerId: null, model: null, lastError: null, source: "task", lastActivityAt: null, finishedAt: null, workflow: DEFAULT_WORKFLOW, nodes: {} });
    }
    const calls = (host: ReturnType<typeof setup>["host"]) => ({ get: host.harness.inspection.sdk.callsTo("threads.get").length, update: host.harness.inspection.sdk.callsTo("threads.update").length });

    it("makes no thread calls when the thread set is unchanged", async () => {
      const { cos, host, threads } = setup();
      active(cos);
      await groupExistingThreads(cos);
      expect(threads.get("build")!.parentThreadId).toBe("plan");
      expect(threads.get("review")!.parentThreadId).toBe("plan");
      const before = calls(host);
      await groupExistingThreads(cos);
      expect(calls(host)).toEqual(before);
    });

    it("groups again once a thread is added", async () => {
      const { cos, host, threads } = setup();
      active(cos);
      await groupExistingThreads(cos);
      threads.set("fix", makeThreadResponse({ id: "fix" }));
      cos.store.upsertThread({ threadId: "fix", itemId: "item", role: "step", stepId: "fix", agent: 0, environmentId: null, round: 0, promptSentAt: null });
      const before = calls(host);
      await groupExistingThreads(cos);
      expect(calls(host).update).toBe(before.update + 1);
      expect(threads.get("fix")!.parentThreadId).toBe("plan");
    });

    it("retries on the next sweep when an update failed", async () => {
      const { cos, host, threads } = setup();
      active(cos);
      const update = async ({ threadId, ...patch }: { threadId: string }) => { const t = { ...threads.get(threadId)!, ...patch }; threads.set(threadId, t); return t; };
      host.harness.inspection.sdk.stub("threads.update", async () => { throw new Error("transient"); });
      await groupExistingThreads(cos);
      expect(await cos.bb.storage.kv.get("thread-group:item")).toBeUndefined();
      host.harness.inspection.sdk.stub("threads.update", update as never);
      await groupExistingThreads(cos);
      expect(threads.get("build")!.parentThreadId).toBe("plan");
      expect(await cos.bb.storage.kv.get("thread-group:item")).toBeDefined();
    });
  });
});
