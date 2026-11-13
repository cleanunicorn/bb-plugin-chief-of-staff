import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, occupiesCapacity, StateStore, type NewWorkItem, type WorkItem } from "../src/state";
import { freshNode, type Nodes } from "../src/machine";
import { normalizeWorkflow, workflowSchema } from "../src/workflow";
import { computeStats, statsWindowStart } from "../src/stats";

// Count normalizations done through state.ts's reads.
vi.mock("../src/workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workflow")>();
  return { ...actual, normalizeWorkflow: vi.fn(actual.normalizeWorkflow) };
});

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
  { id: "ship", name: "Ship", type: "ship", action: "merge", onFail: "build" },
] });

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function storeSetup(options?: ConstructorParameters<typeof StateStore>[2]) {
  const host = createFakePluginHost({ pluginId: "state" });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  let clock = Date.parse("2026-11-12T10:00:00Z");
  const store = new StateStore(db, () => new Date(clock), options);
  const add = (id: string, over: Partial<NewWorkItem> = {}) => store.insertWorkItem({
    id, repo: "a/b", status: "queued", issueTitle: id, issueNumber: null, branch: id, threadId: null, environmentId: null, prNumber: null, prUrl: null,
    providerId: null, model: null, lastError: null, source: "task", lastActivityAt: null, finishedAt: null, workflow,
    nodes: { build: freshNode(), ship: freshNode() }, ...over,
  });
  return { host, db, store, add, setClock: (iso: string) => { clock = Date.parse(iso); } };
}

const nodes = (build: Partial<Nodes[string]>, ship: Partial<Nodes[string]> = {}): Nodes => ({ build: { ...freshNode(), ...build }, ship: { ...freshNode(), ...ship } });

describe("capacity reservations counted in SQL", () => {
  function jsCount(store: StateStore, repo?: string, excludeId?: string) {
    return store.listWorkItems({ limit: 1e6 }).filter((i) => (!repo || i.repo === repo) && i.id !== excludeId && occupiesCapacity(i)).length;
  }
  function expectSame(store: StateStore) {
    for (const [repo, exclude] of [[undefined, undefined], ["a/b", undefined], ["c/d", undefined], [undefined, "x"], ["a/b", "x"]] as const) {
      expect(store.countOccupied(repo, exclude)).toBe(jsCount(store, repo, exclude));
    }
  }

  it("matches the JS count through every state of an item", () => {
    const { store, add } = storeSetup();
    add("x");
    add("other", { repo: "c/d", status: "agent", nodes: nodes({ status: "running" }) });
    const steps: Partial<WorkItem>[] = [
      { status: "queued" },
      { status: "agent", nodes: nodes({ status: "running" }) },
      { status: "queued", queuedEvent: { type: "ci_failing", log: "red" } },
      { status: "cos", queuedEvent: null, nodes: nodes({ status: "done" }, { status: "running", phase: "pushing" }) },
      { status: "ci", nodes: nodes({ status: "done" }, { status: "running", phase: "ci" }) },
      { status: "done", nodes: nodes({ status: "done" }, { status: "done" }) },
    ];
    const seen: number[] = [];
    for (const patch of steps) {
      store.updateWorkItem("x", patch);
      expectSame(store);
      seen.push(store.countOccupied("a/b"));
    }
    expect(seen).toEqual([1, 1, 0, 1, 0, 0]);
  });

  it("heals rows written before the column existed without over-admitting", () => {
    const { store, add, db } = storeSetup();
    add("running", { status: "agent", nodes: nodes({ status: "running" }) });
    add("waiting-ci", { status: "ci", nodes: nodes({ status: "done" }, { status: "running", phase: "ci" }) });
    add("legacy", { status: "agent", workflow: { id: "none", name: "None", steps: [] }, nodes: {} });
    add("finished", { status: "done" });
    db.prepare("UPDATE work_items SET occupies_capacity = NULL WHERE status <> 'done'").run();
    expect(store.countOccupied()).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE occupies_capacity IS NULL AND status <> 'done'").get()).toEqual({ n: 0 });
    expectSame(store);
  });
});

describe("workflow snapshots normalized once", () => {
  it("normalizes each distinct snapshot once and hands out fresh objects", () => {
    const { store, add, db } = storeSetup();
    add("one");
    add("two");
    // An old snapshot: no `chooses` on the agent step, no `mode` on the model step.
    const old = JSON.stringify({ id: "old", name: "Old", steps: [
      { id: "pick", name: "Pick", type: "model", model: "opus", next: ["build"] },
      { id: "build", name: "Build", type: "agent", writes: true, next: [] },
    ] });
    db.prepare("UPDATE work_items SET workflow_json = ? WHERE id = 'two'").run(old);
    const spy = vi.mocked(normalizeWorkflow);
    spy.mockClear();
    const a1 = store.getWorkItem("one")!;
    const a2 = store.getWorkItem("one")!;
    const b1 = store.getWorkItem("two")!;
    store.listWorkItems();
    store.getWorkItem("two");
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(a2.workflow).toStrictEqual(a1.workflow);
    expect(a2.workflow).not.toBe(a1.workflow);
    expect(a2.workflow.steps[0]).not.toBe(a1.workflow.steps[0]);
    expect(a1.workflow).toStrictEqual(normalizeWorkflow(workflow));
    expect(b1.workflow.steps[0]).toMatchObject({ type: "model", mode: "fixed" });
    expect(b1.workflow.steps[1]).toMatchObject({ type: "agent", chooses: [] });
    expect(b1.workflow).toStrictEqual(normalizeWorkflow(JSON.parse(old)));
  });
});

describe("stats from scalar columns", () => {
  it("gives the same stats as computing over every stored item", () => {
    const { store, add, db, setClock } = storeSetup();
    const at = (id: string, created: string, status: WorkItem["status"], finished: string | null, updated = finished ?? created) => {
      setClock(created);
      add(id, { status, finishedAt: finished });
      db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(updated, id);
    };
    at("active-old", "2026-01-01T00:00:00.000Z", "agent", null);
    at("active-new", "2026-11-11T00:00:00.000Z", "ci", null);
    at("done-in", "2026-11-05T10:00:00.000Z", "done", "2026-11-05T13:00:00.000Z");
    at("done-no-finish", "2026-10-01T10:00:00.000Z", "done", null, "2026-11-10T10:00:00.000Z");
    at("failed-in", "2026-11-09T10:00:00.000Z", "failed", "2026-11-09T11:00:00.000Z");
    at("done-out", "2026-09-01T10:00:00.000Z", "done", "2026-09-02T10:00:00.000Z");
    at("edge", "2026-10-30T00:00:00.000Z", "done", "2026-10-30T00:00:00.000Z");
    const now = new Date("2026-11-12T10:00:00Z");
    for (const windowDays of [undefined, 1, 14, 90]) {
      const since = statsWindowStart(now, windowDays);
      const rows = store.statsRows(since);
      expect(computeStats(rows, now, windowDays, store.countWorkItems())).toEqual(computeStats(store.listWorkItems({ limit: 1e6 }), now, windowDays));
    }
    expect(statsWindowStart(now, 14)).toBe("2026-10-30T00:00:00.000Z");
    expect(store.statsRows(statsWindowStart(now, 14)).length).toBe(6);
    expect(store.countWorkItems()).toBe(7);
  });
});

describe("activity log task labels", () => {
  it("names each row's task from its work item, keeping the row's own id and repo", () => {
    const { store, add } = storeSetup();
    add("issue-item", { repo: "acme/app", issueNumber: 109, issueTitle: "Activity rows do not name their task" });
    add("standalone", { repo: "acme/app", issueTitle: "Tidy the README" });
    add("untitled", { repo: "acme/app", issueTitle: "" });
    store.log({ level: "info", kind: "spawn", repo: "other/repo", workItemId: "issue-item", message: "spawned", actor: "event" });
    store.log({ level: "info", kind: "spawn", repo: "acme/app", workItemId: "standalone", message: "spawned", actor: "event" });
    store.log({ level: "info", kind: "spawn", repo: "acme/app", workItemId: "untitled", message: "spawned", actor: "event" });
    store.log({ level: "info", kind: "control", repo: null, workItemId: null, message: "paused", actor: "rpc:client" });
    store.log({ level: "info", kind: "spawn", repo: "acme/app", workItemId: "gone", message: "spawned", actor: "event" });
    const [gone, control, untitled, standalone, issue] = store.listLog();
    expect(issue).toMatchObject({ id: 1, repo: "other/repo", workItemId: "issue-item", issueNumber: 109, issueTitle: "Activity rows do not name their task" });
    expect(standalone).toMatchObject({ id: 2, issueNumber: null, issueTitle: "Tidy the README" });
    // Found with an empty title: "" (not null), so the dashboard still labels it.
    expect(untitled).toMatchObject({ id: 3, issueNumber: null, issueTitle: "" });
    expect(control).toMatchObject({ id: 4, repo: null, workItemId: null, issueNumber: null, issueTitle: null });
    expect(gone).toMatchObject({ id: 5, workItemId: "gone", issueNumber: null, issueTitle: null });
    expect(store.listLog({ workItemId: "standalone" }).map((e) => e.id)).toEqual([2]);
  });
});

describe("bounded log and journal", () => {
  const caps = { logMaxRows: 10, journalMaxRows: 12, pruneEvery: 4 };

  it("keeps the newest log rows, at most one prune interval over the cap", () => {
    const { store, db } = storeSetup(caps);
    for (let i = 1; i <= caps.logMaxRows + 25; i++) {
      store.log({ level: "info", kind: "test", repo: null, workItemId: null, message: `m${i}`, actor: "test" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM activity_log").get() as { n: number }).n).toBeLessThanOrEqual(caps.logMaxRows + caps.pruneEvery);
    }
    const messages = store.listLog({ limit: 100 }).map((e) => e.message);
    expect(messages[0]).toBe("m35");
    expect(messages).toContain("m26");
    expect(messages).not.toContain("m1");
  });

  it("keeps the newest journal rows when several are written at once", () => {
    const { store, db } = storeSetup(caps);
    for (let i = 1; i <= 20; i++) store.appendJournal("x", [1, 2, 3].map((k) => ({ step: "build", round: i, kind: "started" as const, detail: `${i}.${k}` })), "test");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM step_journal").get() as { n: number }).n;
    expect(n).toBeLessThanOrEqual(caps.journalMaxRows + caps.pruneEvery + 2);
    expect(n).toBeGreaterThanOrEqual(caps.journalMaxRows);
    const details = store.listJournal("x").map((e) => e.detail);
    expect(details.at(-1)).toBe("20.3");
    expect(details).not.toContain("1.1");
  });

  it("prunes on the first write after a restart", () => {
    const { store, db } = storeSetup({ ...caps, pruneEvery: 1_000 });
    for (let i = 0; i < 30; i++) store.log({ level: "info", kind: "test", repo: null, workItemId: null, message: `m${i}`, actor: "test" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM activity_log").get() as { n: number }).n).toBe(30);
    new StateStore(db, undefined, { ...caps, pruneEvery: 1_000 }).log({ level: "info", kind: "test", repo: null, workItemId: null, message: "after", actor: "test" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM activity_log").get() as { n: number }).n).toBe(caps.logMaxRows);
  });
});
