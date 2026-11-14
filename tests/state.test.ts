import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, migrationsForDatabase, occupiesCapacity, StateStore, type NewWorkItem, type PrState, type WorkItem } from "../src/state";
import { freshNode, transition, type Nodes } from "../src/machine";
import { applyTransition } from "../src/delivery";
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
    return store.listWorkItems().filter((i) => (!repo || i.repo === repo) && i.id !== excludeId && occupiesCapacity(i)).length;
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
      expect(computeStats(rows, now, windowDays, store.countWorkItems())).toEqual(computeStats(store.listWorkItems(), now, windowDays));
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

  it("names each row's task from its work item, without overwriting the row's own id and repo", () => {
    const { store, add } = storeSetup();
    add("issue", { repo: "acme/app", issueNumber: 7, issueTitle: "Fix login" });
    add("standalone", { repo: "acme/app", issueNumber: null, issueTitle: "Tidy the docs" });
    store.log({ level: "info", kind: "spawn", repo: "other/repo", workItemId: "issue", message: "spawned", actor: "event" });
    store.log({ level: "info", kind: "spawn", repo: "acme/app", workItemId: "standalone", message: "spawned", actor: "event" });
    store.log({ level: "info", kind: "control", repo: null, workItemId: null, message: "paused", actor: "rpc:client" });
    store.log({ level: "info", kind: "spawn", repo: "acme/app", workItemId: "gone", message: "spawned", actor: "event" });
    const [gone, control, standalone, issue] = store.listLog();
    expect(issue).toMatchObject({ id: 1, repo: "other/repo", workItemId: "issue", issueNumber: 7, issueTitle: "Fix login" });
    expect(standalone).toMatchObject({ id: 2, workItemId: "standalone", issueNumber: null, issueTitle: "Tidy the docs" });
    expect(control).toMatchObject({ id: 3, repo: null, workItemId: null, issueNumber: null, issueTitle: null });
    expect(gone).toMatchObject({ id: 4, workItemId: "gone", issueNumber: null, issueTitle: null });
    expect(store.listLog({ workItemId: "issue" })).toEqual([issue]);
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

  it("keeps when GitHub closed the PR", () => {
    const { store, add } = storeSetup();
    add("x", { prNumber: 7, status: "failed" });
    store.setPrState("x", open(7, "2026-11-12T11:00:00.000Z", { state: "closed", checks: null, review: null, closedAt: "2026-11-12T10:30:00Z" }));
    expect(store.getWorkItem("x")!.prState).toMatchObject({ state: "closed", closedAt: "2026-11-12T10:30:00Z" });
    store.setPrState("x", open(7, "2026-11-12T11:00:00.000Z"));
    expect(store.getWorkItem("x")!.prState).not.toHaveProperty("closedAt");
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

describe("latest task for an issue (#48)", () => {
  it("returns null without a task, else the newest task of that repo and issue", () => {
    const { store, add, setClock } = storeSetup();
    expect(store.latestForIssue("a/b", 12)).toBeNull();
    add("old", { issueNumber: 12, status: "agent", nodes: nodes({ status: "running" }) });
    setClock("2026-11-12T11:00:00Z");
    add("new", { issueNumber: 12, status: "failed" });
    add("other-issue", { issueNumber: 13 });
    add("other-repo", { repo: "c/d", issueNumber: 12 });
    expect(store.latestForIssue("a/b", 12)?.id).toBe("new");
    // An older active task can sit behind the newer finished one.
    expect(store.findActiveForIssue("a/b", 12)?.id).toBe("old");
    expect(store.latestForIssue("a/b", 14)).toBeNull();
  });

  it("breaks a tie on creation time by insertion order", () => {
    const { store, add } = storeSetup();
    add("first", { issueNumber: 12 });
    add("second", { issueNumber: 12 });
    expect(store.latestForIssue("a/b", 12)?.id).toBe("second");
  });
});

describe("latestManualActions", () => {
  it("returns the newest manual row per item and ignores other kinds and items", () => {
    const { store, setClock } = storeSetup();
    const log = (workItemId: string, kind: string, message: string, at: string) => {
      setClock(at);
      store.log({ level: "info", kind, repo: "a/b", workItemId, message, actor: "test" });
    };
    log("a", "manual", "marked failed", "2026-11-12T10:00:00Z");
    log("a", "manual", "marked done", "2026-11-12T10:05:00Z");
    log("a", "transition", "later, not manual", "2026-11-12T10:06:00Z");
    log("b", "transition", "no manual row", "2026-11-12T10:00:00Z");
    log("c", "manual", "marked done", "2026-11-12T09:00:00Z");
    const found = store.latestManualActions(["a", "b"]);
    expect([...found.keys()]).toEqual(["a"]);
    expect(found.get("a")).toEqual({ message: "marked done", at: "2026-11-12T10:05:00.000Z" });
    expect(store.latestManualActions([]).size).toBe(0);
  });
});

describe("roster items: every active item plus a page of finished ones", () => {
  /** One active item created first, then `finished` finished ones; finish times come in groups of three that share a timestamp. */
  function seed(finished: number) {
    const s = storeSetup();
    const base = Date.parse("2026-01-01T00:00:00Z");
    s.setClock(new Date(base).toISOString());
    s.add("active-oldest", { status: "waiting_on_human" });
    const expected: { id: string; at: string }[] = [];
    for (let i = 0; i < finished; i++) {
      const id = `f${String(i).padStart(3, "0")}`;
      s.setClock(new Date(base + (i + 1) * 60_000).toISOString());
      const at = new Date(base + 10 * 86_400_000 + Math.floor(i / 3) * 1_000).toISOString();
      s.add(id, { status: i % 5 ? "done" : "failed", finishedAt: at });
      expected.push({ id, at });
    }
    expected.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
    return { ...s, expected: expected.map((e) => e.id) };
  }

  it("lists an old active item past 200 newer finished ones and pages every finished item once, in order", () => {
    const { store, expected } = seed(249);
    // The newest-200 list no longer reaches it.
    expect(store.listWorkItems({ limit: 200 }).some((i) => i.id === "active-oldest")).toBe(false);
    expect(store.listRosterItems({}).active.map((i) => i.id)).toEqual(["active-oldest"]);
    expect(store.listRosterItems({}).finished).toEqual([]);
    expect(store.listRosterItems({}).nextBefore).toBeNull();

    const first = store.listRosterItems({ includeDone: true, finishedLimit: 50 });
    expect(first.active.map((i) => i.id)).toEqual(["active-oldest"]);
    const seen = first.finished.map((i) => i.id);
    let cursor = first.nextBefore;
    let pages = 1;
    while (cursor) {
      const page = store.listRosterItems({ includeDone: true, finishedLimit: 50, before: cursor });
      expect(page.active).toEqual([]);
      seen.push(...page.finished.map((i) => i.id));
      cursor = page.nextBefore;
      pages++;
    }
    // 50 is not a multiple of 3, so tie groups straddle page boundaries.
    expect(pages).toBe(5);
    expect(seen).toEqual(expected);
  });

  it("says when there is nothing more", () => {
    const { store } = seed(6);
    expect(store.listRosterItems({ includeDone: true, finishedLimit: 6 })).toMatchObject({ nextBefore: null });
    const page = store.listRosterItems({ includeDone: true, finishedLimit: 5 });
    expect(page.finished).toHaveLength(5);
    expect(store.listRosterItems({ includeDone: true, finishedLimit: 5, before: page.nextBefore! }).finished).toHaveLength(1);
  });

  it("orders a finished row without finished_at by its last update", () => {
    const { store, add, db } = storeSetup();
    add("a", { status: "done", finishedAt: "2026-11-01T00:00:00.000Z" });
    add("legacy", { status: "done", finishedAt: null });
    add("c", { status: "failed", finishedAt: "2026-11-03T00:00:00.000Z" });
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2026-11-02T00:00:00.000Z", "legacy");
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id <> ?").run("2026-11-12T00:00:00.000Z", "legacy");
    const first = store.listRosterItems({ includeDone: true, finishedLimit: 2 });
    expect(first.finished.map((i) => i.id)).toEqual(["c", "legacy"]);
    expect(store.listRosterItems({ includeDone: true, finishedLimit: 2, before: first.nextBefore! }).finished.map((i) => i.id)).toEqual(["a"]);
  });

  it("filters both lists by repo", () => {
    const { store, add } = storeSetup();
    add("mine-active", { status: "agent" });
    add("theirs-active", { repo: "c/d", status: "agent" });
    add("mine-done", { status: "done", finishedAt: "2026-11-01T00:00:00.000Z" });
    add("theirs-done", { repo: "c/d", status: "done", finishedAt: "2026-11-02T00:00:00.000Z" });
    const page = store.listRosterItems({ repo: "a/b", includeDone: true, finishedLimit: 1 });
    expect(page.active.map((i) => i.id)).toEqual(["mine-active"]);
    expect(page.finished.map((i) => i.id)).toEqual(["mine-done"]);
    expect(page.nextBefore).toBeNull();
  });

  it("rejects a malformed cursor instead of returning the first page", () => {
    const { store, add } = storeSetup();
    add("x", { status: "done", finishedAt: "2026-11-01T00:00:00.000Z" });
    for (const before of ["", "nope", Buffer.from("[1,2]").toString("base64url"), Buffer.from('["2026-11-01T00:00:00.000Z"]').toString("base64url"), Buffer.from("{}").toString("base64url")]) {
      expect(() => store.listRosterItems({ includeDone: true, before })).toThrow("invalid cursor");
    }
  });
});


describe("usage of finished items, summed over their threads", () => {
  const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: { amount: 0.5, currency: "USD" }, threads: 3, reportedThreads: 2 };
  const nothing = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, threads: 2, reportedThreads: 0 };
  const FINISHED = "2026-11-12T09:00:00Z";
  const AT = "2026-11-12T10:00:00.000Z";
  const row = (db: ReturnType<typeof storeSetup>["db"], id: string) => db.prepare("SELECT updated_at, usage_tokens, usage_checked_at, task_usage_json FROM work_items WHERE id = ?").get(id) as { updated_at: string; usage_tokens: number | null; usage_checked_at: string | null; task_usage_json: string | null };

  it("is not counted until stored; an all-null count is stored as counted, with no tokens", () => {
    const { db, store, add } = storeSetup();
    add("a", { status: "done", finishedAt: FINISHED });
    expect(store.getWorkItem("a")!.taskUsage).toBeNull();
    expect(store.setTaskUsage("a", FINISHED, nothing, AT)).toBe(true);
    expect(store.getWorkItem("a")!.taskUsage).toEqual(nothing);
    expect(row(db, "a").usage_tokens).toBeNull();
    expect(store.setTaskUsage("a", FINISHED, usage, AT)).toBe(true);
    expect(store.listWorkItems()[0]!.taskUsage).toEqual(usage);
    expect(row(db, "a")).toMatchObject({ usage_tokens: 30, usage_checked_at: AT });
  });

  it("does not touch updated_at, and stores only for the finished item that was read", () => {
    const { db, store, add, setClock } = storeSetup();
    add("done", { status: "done", finishedAt: FINISHED });
    add("active", { status: "agent" });
    const before = row(db, "done").updated_at;
    setClock("2026-11-12T11:00:00Z");
    store.setTaskUsage("done", FINISHED, usage, AT);
    store.touchUsageChecked("done", AT);
    expect(row(db, "done").updated_at).toBe(before);
    // Finished again since it was read: another finish time.
    expect(store.setTaskUsage("done", "2026-11-12T08:00:00Z", nothing, AT)).toBe(false);
    expect(store.getWorkItem("done")!.taskUsage).toEqual(usage);
    expect(store.setTaskUsage("active", null, usage, AT)).toBe(false);
    store.touchUsageChecked("active", AT);
    expect(row(db, "active")).toMatchObject({ task_usage_json: null, usage_checked_at: null });
  });

  it("is kept when a finished item is saved, and cleared with its attempts when it is reopened", () => {
    const { db, store, add } = storeSetup();
    add("a", { status: "failed", threadId: "t-a", finishedAt: FINISHED });
    store.setTaskUsage("a", FINISHED, usage, AT);
    expect(store.updateWorkItem("a", { lastError: "boom", threadId: "t-b" })!.taskUsage).toEqual(usage);
    expect(store.getWorkItem("a")!.taskUsage).toEqual(usage);
    const reopened = store.updateWorkItem("a", { status: "agent", finishedAt: null });
    expect(reopened!.taskUsage).toBeNull();
    expect(row(db, "a")).toMatchObject({ task_usage_json: null, usage_tokens: null, usage_checked_at: null });
    // Finishing again does not bring the old value back.
    store.updateWorkItem("a", { status: "done", finishedAt: "2026-11-12T10:00:00Z" });
    expect(store.getWorkItem("a")!.taskUsage).toBeNull();
  });

  it("is cleared when a failed item is revived through the machine", () => {
    const { store, add } = storeSetup();
    add("a", { status: "failed", threadId: "t-a", finishedAt: FINISHED, nodes: nodes({ status: "running", round: 1, reports: [null], nudges: [0] }) });
    store.setTaskUsage("a", FINISHED, usage, AT);
    const item = store.getWorkItem("a")!;
    const t = transition(item, { type: "revive" });
    const after = store.updateWorkItem("a", applyTransition(item, t.nodes, t.patch))!;
    expect(after.status).not.toBe("failed");
    expect(store.getWorkItem("a")!.taskUsage).toBeNull();
  });

  it("lists finished items not counted yet: never tried first (latest finished first), then the oldest attempt, past the retry time", () => {
    const { store, add } = storeSetup();
    add("old", { status: "done", finishedAt: "2026-11-01T00:00:00Z" });
    add("new", { status: "failed", finishedAt: "2026-11-10T00:00:00Z" });
    add("tried-late", { status: "done", finishedAt: "2026-11-11T00:00:00Z" });
    add("tried-early", { status: "done", finishedAt: "2026-11-11T00:00:00Z" });
    add("recent-try", { status: "done", finishedAt: "2026-11-11T00:00:00Z" });
    add("counted", { status: "done", finishedAt: "2026-11-11T00:00:00Z" });
    add("active", { status: "agent" });
    store.touchUsageChecked("tried-late", "2026-11-12T09:30:00.000Z");
    store.touchUsageChecked("tried-early", "2026-11-12T09:00:00.000Z");
    store.touchUsageChecked("recent-try", "2026-11-12T09:55:00.000Z");
    store.setTaskUsage("counted", "2026-11-11T00:00:00Z", nothing, AT);
    const due = (limit: number) => store.listUsageDue("2026-11-12T09:50:00.000Z", limit).map((i) => i.id);
    expect(due(10)).toEqual(["new", "old", "tried-early", "tried-late"]);
    expect(due(2)).toEqual(["new", "old"]);
  });

  it("adds its columns on top of the shipped migrations, without reusing the builder-only figure", () => {
    const host = createFakePluginHost({ pluginId: "usage-upgrade" });
    hosts.push(host);
    const db = host.bb.storage.database();
    const shipped = MIGRATIONS.slice(0, MIGRATIONS.indexOf("ALTER TABLE work_items ADD COLUMN final_usage_json TEXT") + 1);
    expect(shipped.length).toBeLessThan(MIGRATIONS.length);
    host.bb.storage.migrate(db, shipped);
    db.prepare("INSERT INTO work_items (id, repo, status, created_at, updated_at, finished_at, final_usage_json) VALUES ('old', 'a/b', 'done', ?, ?, ?, ?)")
      .run(FINISHED, FINISHED, FINISHED, JSON.stringify({ inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: null }));
    expect(() => host.bb.storage.migrate(db, migrationsForDatabase(db))).not.toThrow();
    expect(db.prepare("PRAGMA table_info(work_items)").all()).toEqual(expect.arrayContaining(["task_usage_json", "usage_tokens", "usage_checked_at"].map((name) => expect.objectContaining({ name }))));
    const store = new StateStore(db);
    expect(store.getWorkItem("old")!.taskUsage).toBeNull();
    expect(store.listUsageDue(AT, 10).map((i) => i.id)).toEqual(["old"]);
  });
});
