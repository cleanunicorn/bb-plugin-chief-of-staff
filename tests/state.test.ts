import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, occupiesCapacity, StateStore, type NewWorkItem, type PrState, type WorkItem } from "../src/state";
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

describe("cached pull request state", () => {
  const open = (number: number, at: string, over: Partial<PrState> = {}): PrState => ({ number, state: "open", draft: false, checks: "failing", review: "changes_requested", checkedAt: at, ...over });

  it("round-trips through reads and survives full-row writes without moving updated_at", () => {
    const { store, add, setClock } = storeSetup();
    add("x", { prNumber: 7, status: "done" });
    expect(store.getWorkItem("x")!.prState).toBeNull();
    const before = store.getWorkItem("x")!.updatedAt;
    setClock("2026-11-12T11:00:00Z");
    store.setPrState("x", open(7, "2026-11-12T11:00:00.000Z"));
    expect(store.getWorkItem("x")!.prState).toEqual(open(7, "2026-11-12T11:00:00.000Z"));
    expect(store.getWorkItem("x")!.updatedAt).toBe(before);
    store.touchPrChecked("x", "2026-11-12T11:05:00.000Z");
    expect(store.getWorkItem("x")!.updatedAt).toBe(before);
    // A full-row write keeps the state, and the last successful read time.
    store.updateWorkItem("x", { lastError: "boom" });
    expect(store.getWorkItem("x")!.prState).toEqual(open(7, "2026-11-12T11:00:00.000Z"));
    expect(store.listWorkItems()[0]!.prState?.state).toBe("open");
  });

  it("drops details it cannot read", () => {
    const { store, add, db } = storeSetup();
    add("x", { prNumber: 7 });
    store.setPrState("x", open(7, "2026-11-12T11:00:00.000Z"));
    db.prepare("UPDATE work_items SET pr_state_json = '{broken' WHERE id = 'x'").run();
    expect(store.getWorkItem("x")!.prState).toBeNull();
  });

  it("keeps the state when retention compacts a finished item", () => {
    const { store, add } = storeSetup();
    add("x", { prNumber: 7, status: "done", finishedAt: "2026-01-01T00:00:00.000Z" });
    store.setPrState("x", open(7, "2026-01-01T00:00:00.000Z", { state: "merged", checks: null, review: null }));
    expect(store.compactFinished("2026-11-01T00:00:00.000Z")).toEqual(["x"]);
    expect(store.getWorkItem("x")!.prState?.state).toBe("merged");
  });

  it("lists the PRs due for a refresh, never-attempted first and failures last", () => {
    const { store, add } = storeSetup();
    const stale = "2026-11-12T09:00:00.000Z";
    const fresh = "2026-11-12T09:55:00.000Z";
    const staleBefore = "2026-11-12T09:50:00.000Z";
    add("no-pr");
    add("never", { prNumber: 1 });
    add("open-stale", { prNumber: 2 });
    store.setPrState("open-stale", open(2, stale));
    add("open-fresh", { prNumber: 3 });
    store.setPrState("open-fresh", open(3, fresh));
    add("merged", { prNumber: 4 });
    store.setPrState("merged", open(4, stale, { state: "merged", checks: null, review: null }));
    add("closed", { prNumber: 5 });
    store.setPrState("closed", open(5, stale, { state: "closed", checks: null, review: null }));
    // Re-shipped with a new PR: the recorded state belongs to the old one.
    add("reshipped", { prNumber: 9 });
    store.setPrState("reshipped", open(6, "2026-11-12T09:01:00.000Z", { state: "merged", checks: null, review: null }));
    add("paused", { repo: "p/q", prNumber: 7 });
    store.setRepoPaused("p/q", true);
    const due = () => store.listPrItemsDue(staleBefore).map((r) => r.id);
    expect(due()).toEqual(["never", "open-stale", "reshipped"]);
    expect(store.listPrItemsDue(staleBefore)[0]).toEqual({ id: "never", repo: "a/b", prNumber: 1, prState: null });
    // An attempt that read nothing sends the row behind the others.
    store.touchPrChecked("never", "2026-11-12T09:40:00.000Z");
    expect(due()).toEqual(["open-stale", "reshipped", "never"]);
    store.touchPrChecked("open-stale", "2026-11-12T09:51:00.000Z");
    expect(due()).toEqual(["reshipped", "never"]);
  });
});

describe("activity log filtering and cursor", () => {
  it("finds an old problem before applying the page limit", () => {
    const { store } = storeSetup();
    store.log({ level: "error", kind: "test", repo: null, workItemId: "old", message: "old failure", actor: "test" });
    for (let i = 0; i < 200; i++) store.log({ level: "info", kind: "test", repo: null, workItemId: null, message: `info ${i}`, actor: "test" });
    expect(store.listLog({ limit: 60, onlyProblems: true }).map(e => e.message)).toEqual(["old failure"]);
  });

  it("pages by exclusive id despite equal timestamps and concurrent new rows", () => {
    const { store } = storeSetup();
    for (let i = 0; i < 5; i++) store.log({ level: i % 2 ? "warn" : "error", kind: "test", repo: null, workItemId: "a", message: `m${i}`, actor: "test" });
    const first = store.listLog({ limit: 2, onlyProblems: true, workItemId: "a" });
    store.log({ level: "error", kind: "test", repo: null, workItemId: "a", message: "new", actor: "test" });
    const second = store.listLog({ limit: 2, before: first.at(-1)!.id, onlyProblems: true, workItemId: "a" });
    const third = store.listLog({ limit: 2, before: second.at(-1)!.id, onlyProblems: true, workItemId: "a" });
    expect([...first, ...second, ...third].map(e => e.message)).toEqual(["m4", "m3", "m2", "m1", "m0"]);
    expect(store.listLog({ before: third[0]!.id })).toEqual([]);
    expect(store.listLog({ workItemId: "other", onlyProblems: true })).toEqual([]);
  });
});
