import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, StateStore, type NewWorkItem } from "../src/state";
import { DEFAULT_POLICY, freshNode } from "../src/machine";
import { workflowSchema } from "../src/workflow";
import { settleJobs } from "../src/delivery";
import { syncThreads, tickItems } from "../src/sync";
import { buildRoster, detectStalls } from "../src/roster";
import type { Cos } from "../src/context";

// The engine loops (sync, tick, stall detection) must reach every active item,
// not only the 200 newest that the roster shows.

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
  { id: "ship", name: "Ship", type: "ship", action: "merge", onFail: "build" },
] });
const DAY = 24 * 60 * 60_000;
const LOOKBACK = 3 * DAY;

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await settleJobs(); for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function setup() {
  /** Thread statuses BB knows; any other thread id is gone. */
  const threads = new Map<string, string>();
  const host = createFakePluginHost({ pluginId: "test", sdk: { threads: {
    list: async (args?: { threadIds?: readonly string[] }) => (args?.threadIds ?? []).filter((id) => threads.has(id))
      .map((id) => ({ id, status: threads.get(id)!, updatedAt: 0, runtime: { displayStatus: threads.get(id)! }, hasPendingInteraction: false })) as never,
    get: async (args: { threadId: string }) => {
      const status = threads.get(args.threadId);
      if (!status) throw new Error("thread not found");
      return { id: args.threadId, status, updatedAt: 0, runtime: { displayStatus: status } } as never;
    },
    send: async () => ({ ok: true, delivery: "sent" }) as never,
  } } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  let clock = Date.parse("2026-11-01T10:00:00Z");
  const now = () => new Date(clock);
  const store = new StateStore(db, now);
  const repo = { owner: "a", repo: "b", maxConcurrent: 10_000 };
  const values = { maxConcurrentTotal: 10_000, archiveThreadsOnDone: false, stallThresholdMinutes: 30 };
  const cos = { bb: host.bb, store, now, config: async () => ({ policy: DEFAULT_POLICY, repos: [repo], values }), repo: async () => repo, safe: async (s: string) => s, invalidate: () => {}, notify: async () => {} } as unknown as Cos;
  /** An item, created one second after the previous one. */
  function add(id: string, kind: "agent" | "ci" = "agent", over: Partial<NewWorkItem> = {}) {
    clock += 1000;
    const ci = kind === "ci";
    return store.insertWorkItem({ id, repo: "a/b", status: kind, issueTitle: id, issueNumber: null, branch: id, threadId: `thread-${id}`, environmentId: null, prNumber: null, prUrl: null, providerId: null, model: null, lastError: null, source: "task", lastActivityAt: null, finishedAt: null, workflow, nodes: {
      build: { ...freshNode(), round: 1, status: ci ? "done" : "running" },
      ship: { ...freshNode(), round: ci ? 1 : 0, status: ci ? "running" : "pending", phase: ci ? "ci" : null },
    }, ...over } satisfies NewWorkItem);
  }
  /** `count` newer items waiting on CI, each with an idle thread: nothing for sync to do. */
  function fill(count: number) {
    for (let i = 0; i < count; i++) {
      add(`new-${i}`, "ci");
      threads.set(`thread-new-${i}`, "idle");
    }
  }
  const advance = (ms: number) => { clock += ms; };
  const nowIso = () => new Date(clock).toISOString();
  return { host, cos, store, db, add, fill, threads, advance, nowIso };
}

describe("thread sync beyond the 200 newest items", () => {
  it("syncs an active item older than the 200 newest", async () => {
    const { cos, store, add, fill } = setup();
    add("old"); // its builder thread was deleted
    fill(201);
    const result = await syncThreads(cos, "test");
    expect(result.checked).toBe(202);
    expect(store.getWorkItem("old")!.status).toBe("failed");
  });

  it("revives an old failed item inside the lookback when its thread resumes", async () => {
    const { cos, store, add, fill, threads, advance, nowIso } = setup();
    add("old");
    store.updateWorkItem("old", { status: "failed", finishedAt: nowIso(), lastError: "provider crashed" });
    threads.set("thread-old", "active");
    fill(201);
    advance(DAY);
    await syncThreads(cos, "test");
    expect(store.getWorkItem("old")).toMatchObject({ status: "agent", finishedAt: null, lastError: null });
  });

  it("skips done items, failed items past the lookback and failed items with no finish time", async () => {
    const { cos, store, host, add, threads, advance, nowIso, db } = setup();
    for (const id of ["done", "expired", "edge", "unfinished", "live"]) {
      add(id);
      threads.set(`thread-${id}`, "active");
    }
    advance(1000);
    const finished = nowIso();
    store.updateWorkItem("done", { status: "done", finishedAt: finished });
    store.updateWorkItem("expired", { status: "failed", finishedAt: new Date(Date.parse(finished) - 1).toISOString() });
    store.updateWorkItem("edge", { status: "failed", finishedAt: finished });
    store.updateWorkItem("unfinished", { status: "failed" });
    db.prepare("UPDATE work_items SET finished_at = NULL WHERE id = 'unfinished'").run();
    advance(LOOKBACK);
    const result = await syncThreads(cos, "test");
    // "live" and "edge" (exactly at the lookback) are synced; the rest are not.
    expect(result.checked).toBe(2);
    const read = [...host.harness.inspection.sdk.callsTo("threads.list").flatMap(([args]) => (args as { threadIds: string[] }).threadIds),
      ...host.harness.inspection.sdk.callsTo("threads.get").map(([args]) => (args as { threadId: string }).threadId)];
    expect(new Set(read)).toEqual(new Set(["thread-live", "thread-edge"]));
    expect(store.getWorkItem("edge")!.status).not.toBe("failed");
    expect(store.getWorkItem("expired")!.status).toBe("failed");
    expect(store.getWorkItem("unfinished")!.status).toBe("failed");
  });

  it("reads more than 200 threads in batches of at most 200", async () => {
    const { cos, host, fill } = setup();
    fill(450);
    await syncThreads(cos, "test");
    const batches = host.harness.inspection.sdk.callsTo("threads.list").map(([args]) => (args as { threadIds: string[] }).threadIds);
    for (const ids of batches) expect(ids.length).toBeLessThanOrEqual(200);
    expect(new Set(batches.flat()).size).toBe(450);
    expect(host.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
  });
});

describe("engine loops beyond the 200 newest items", () => {
  it("restarts a lost job of an item older than the 200 newest", async () => {
    const { cos, store, add, fill, advance, nowIso } = setup();
    add("old");
    store.updateWorkItem("old", { jobStartedAt: nowIso() });
    fill(201);
    advance(60 * 60_000);
    await tickItems(cos, "test");
    expect(store.listLog({ workItemId: "old" }).some((e) => e.kind === "job" && /not running/.test(e.message))).toBe(true);
  });

  it("flags a stalled item older than the 200 newest", async () => {
    const { cos, add, fill, advance } = setup();
    add("old");
    advance(60 * 60_000);
    fill(201);
    expect(await detectStalls(cos, "test")).toEqual(["old"]);
  });

  it("keeps the roster at 200 entries", async () => {
    const { cos, fill } = setup();
    fill(250);
    expect(await buildRoster(cos)).toHaveLength(200);
  });
});
