import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, occupiesCapacity, StateStore, type NewWorkItem, type WorkItem } from "../src/state";
import { freshNode, type Nodes } from "../src/machine";
import { normalizeWorkflow, workflowSchema } from "../src/workflow";

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
