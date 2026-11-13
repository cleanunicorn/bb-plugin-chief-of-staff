import reorderedMigrations from "./fixtures/migrations-reordered-pause.json";
import previousMigrations from "./fixtures/migrations-before-pause.json";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, migrationsForDatabase, StateStore, type NewWorkItem } from "../src/state";
import { DEFAULT_POLICY, freshNode, initialNodes, repoNotConfiguredReason } from "../src/machine";
import { describeActivity } from "../src/roster";
import { workflowSchema } from "../src/workflow";
import { dispatch, settleJobs, watchCi } from "../src/delivery";
import { tickItems } from "../src/sync";
import { liveWarnings, type Cos } from "../src/context";

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
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  const store = new StateStore(db);
  const repo = { owner: "a", repo: "b", maxConcurrent: 1 };
  // Mutable: admission reads config().repos, so a test can drop the repo and add it back.
  const repos = [repo];
  const cos = { bb: host.bb, store, now: () => new Date(), config: async () => ({ policy: DEFAULT_POLICY, repos, values: { maxConcurrentTotal: 1, archiveThreadsOnDone: false } }), repo: async () => repo, safe: async (s: string) => s, invalidate: () => {}, notify: async () => {} } as unknown as Cos;
  function add(id: string, waiting = false) {
    return store.insertWorkItem({ id, repo: "a/b", status: waiting ? "ci" : "agent", issueTitle: id, issueNumber: null, branch: id, threadId: `thread-${id}`, environmentId: null, prNumber: waiting ? 7 : null, prUrl: null, providerId: null, model: null, lastError: null, source: "task", lastActivityAt: null, finishedAt: null, workflow, nodes: {
      build: { ...freshNode(), round: 1, status: waiting ? "done" : "running" },
      ship: { ...freshNode(), round: 1, status: waiting ? "running" : "pending", phase: waiting ? "ci" : null },
    } } satisfies NewWorkItem);
  }
  function addQueued(id: string) {
    return store.insertWorkItem({ id, repo: "a/b", status: "queued", issueTitle: id, issueNumber: 3, branch: id, threadId: `thread-${id}`, environmentId: null, prNumber: null, prUrl: null, providerId: null, model: null, lastError: null, source: "task", lastActivityAt: null, finishedAt: null, workflow, nodes: initialNodes(workflow) } satisfies NewWorkItem);
  }
  return { host, cos, store, add, addQueued, db, repo, repos };
}

describe("admission when the repository is not configured (#52)", () => {
  const warns = (store: StateStore, id: string) => store.listLog({ limit: 100 }).filter((e) => e.workItemId === id && e.level === "warn");

  it("queues a fresh start with its own reason, logs it once, and starts once the repository is back", async () => {
    const { cos, store, addQueued, host, repo, repos } = setup();
    addQueued("a");
    repos.splice(0);
    await dispatch(cos, "a", { type: "start" }, "test");
    const queued = store.getWorkItem("a")!;
    expect(queued).toMatchObject({ status: "queued", queuedEvent: { type: "start" }, waitingReason: repoNotConfiguredReason("a/b") });
    expect(queued.waitingReason).toMatch(/a\/b is not in the repos setting/);
    expect(describeActivity(queued)).toBe(repoNotConfiguredReason("a/b"));
    expect(describeActivity(queued)).not.toMatch(/capacity/);
    expect(warns(store, "a")).toHaveLength(1);
    expect(warns(store, "a")[0]!.message).toContain("a/b");
    await tickItems(cos, "test");
    await tickItems(cos, "test");
    expect(warns(store, "a")).toHaveLength(1);
    expect(store.getWorkItem("a")!.status).toBe("queued");
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    repos.push(repo);
    await tickItems(cos, "test");
    expect(store.getWorkItem("a")).toMatchObject({ status: "agent", queuedEvent: null });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("keeps a CI repair queued while the repository is not configured, then runs it with the CI log", async () => {
    const { cos, store, add, host, repo, repos } = setup();
    add("a", true);
    repos.splice(0);
    await dispatch(cos, "a", { type: "ci_failing", log: "red check" }, "test");
    const queued = store.getWorkItem("a")!;
    expect(queued).toMatchObject({ status: "queued", queuedEvent: { type: "ci_failing", log: "red check" }, waitingReason: repoNotConfiguredReason("a/b") });
    expect(describeActivity(queued)).toBe(repoNotConfiguredReason("a/b"));
    await tickItems(cos, "test");
    await tickItems(cos, "test");
    expect(warns(store, "a")).toHaveLength(1);
    repos.push(repo);
    await tickItems(cos, "test");
    expect(store.getWorkItem("a")).toMatchObject({ status: "agent", queuedEvent: null });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(JSON.stringify(host.harness.inspection.sdk.callsTo("threads.send"))).toContain("red check");
  });

  it("still says a configured repository at capacity is waiting for capacity", async () => {
    const { cos, store, add, addQueued } = setup();
    add("b"); addQueued("a");
    await dispatch(cos, "a", { type: "start" }, "test");
    const queued = store.getWorkItem("a")!;
    expect(queued).toMatchObject({ status: "queued", waitingReason: "Waiting for task capacity" });
    expect(describeActivity(queued)).toBe("Waiting for task capacity");
    expect(warns(store, "a")).toHaveLength(0);
  });
});

describe("overview warning for tasks whose repository is not configured (#52)", () => {
  const cosOf = (store: StateStore) => ({ store, githubLimit: () => null, now: () => new Date() });
  const config = (warnings: string[], repos: object[]) => ({ warnings, repos }) as unknown as Parameters<typeof liveWarnings>[1];

  it("names active tasks of an unconfigured repository, caps the list, and skips finished tasks", () => {
    const { store, add, addQueued, repo } = setup();
    expect(liveWarnings(cosOf(store), config([], [repo]))).toEqual([]);
    addQueued("q");
    add("running");
    store.updateWorkItem("running", { issueTitle: "Fix login" });
    add("done"); store.updateWorkItem("done", { status: "done" });
    add("failed"); store.updateWorkItem("failed", { status: "failed" });
    // Configured: no warning.
    expect(liveWarnings(cosOf(store), config(["config"], [repo]))).toEqual(["config"]);
    const [warning] = liveWarnings(cosOf(store), config([], []));
    expect(warning).toContain("a/b#3");
    expect(warning).toContain("a/b: Fix login");
    expect(warning).not.toContain("done");
    expect(warning).not.toContain("failed");
    expect(warning).toMatch(/repos setting/);
    expect(warning).toMatch(/close/);
    for (const id of ["c", "d", "e", "f", "g"]) add(id);
    const [capped] = liveWarnings(cosOf(store), config([], []));
    expect(capped).toContain("and 2 more");
    expect(capped.match(/a\/b/g)).toHaveLength(5);
    expect(capped).toMatch(/Add the repository back/);
    store.updateWorkItem("c", { repo: "x/y" });
    expect(liveWarnings(cosOf(store), config([], []))[0]).toMatch(/^Repositories .*Add the repositories back/);
  });
});

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

  it.each([
    ["before pause", previousMigrations],
    ["reordered pause", reorderedMigrations],
    ["restored order", MIGRATIONS],
  ])("upgrades %s history without changing existing records", (_name, history) => {
    const host = createFakePluginHost({ pluginId: "upgrade" }); hosts.push(host);
    const db = host.bb.storage.database();
    // Frozen histories: pre-pause d961a23 and reordered pause 6bc7c67.
    // Do not regenerate these fixtures from MIGRATIONS.
    host.bb.storage.migrate(db, history);
    const recorded = db.prepare("SELECT * FROM _bb_migrations").all();
    db.prepare("INSERT INTO work_items (id, repo, status, created_at, updated_at, queued_event_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("existing", "a/b", "queued", "2026-11-08", "2026-11-08", '{"type":"retry"}');
    expect(() => host.bb.storage.migrate(db, migrationsForDatabase(db))).not.toThrow();
    expect(() => host.bb.storage.migrate(db, migrationsForDatabase(db))).not.toThrow();
    expect(db.prepare("SELECT * FROM _bb_migrations").all()).toEqual(expect.arrayContaining(recorded));
    const store = new StateStore(db);
    expect(store.getWorkItem("existing")?.queuedEvent).toEqual({ type: "retry" });
    store.setPaused(true);
    expect(store.isPaused()).toBe(true);
    store.deferEvent("existing", { type: "retry" }, "test");
    expect(store.nextDeferredEvent()).toMatchObject({ item_id: "existing", event_json: '{"type":"retry"}' });
    expect(db.prepare("PRAGMA table_info(work_items)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "queued_event_json" })]));
    expect(db.prepare("PRAGMA table_info(work_items)").all()).toEqual(expect.arrayContaining(["occupies_capacity", "detail_pruned_at", "pr_state", "pr_state_number", "pr_state_json", "pr_checked_at"].map((name) => expect.objectContaining({ name }))));
    expect(db.prepare("PRAGMA index_list(work_items)").all()).toEqual(expect.arrayContaining(["work_items_status", "work_items_created"].map((name) => expect.objectContaining({ name }))));
    // Per-project pause: a paused repo's deferred events wait while others replay.
    store.setPaused(false);
    store.setRepoPaused("a/b", true);
    expect(store.isPaused()).toBe(false);
    expect(store.isPaused("a/b")).toBe(true);
    expect(store.isPaused("c/d")).toBe(false);
    expect(store.nextDeferredEvent()).toBeUndefined();
    store.setRepoPaused("a/b", false);
    expect(store.nextDeferredEvent()).toMatchObject({ item_id: "existing" });
  });

  it.each([[previousMigrations], [reorderedMigrations]])("rejects unknown hashes without changing the database", (history) => {
    const host = createFakePluginHost({ pluginId: "unknown" }); hosts.push(host);
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, history);
    db.prepare("UPDATE _bb_migrations SET statement_hash = 'unknown' WHERE id = 26").run();
    const before = db.serialize();
    expect(() => host.bb.storage.migrate(db, migrationsForDatabase(db))).toThrow("migration 26");
    expect(db.serialize()).toEqual(before);
  });

  it("orders the roster by the created_at index instead of sorting the table", () => {
    const host = createFakePluginHost({ pluginId: "plan" }); hosts.push(host);
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, migrationsForDatabase(db));
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT * FROM work_items ORDER BY created_at DESC LIMIT 200").all() as { detail: string }[]).map((r) => r.detail).join("\n");
    expect(plan).toContain("work_items_created");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("marks finished rows as holding no capacity when upgrading", () => {
    const host = createFakePluginHost({ pluginId: "backfill" }); hosts.push(host);
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS.slice(0, 33));
    const insert = db.prepare("INSERT INTO work_items (id, repo, status, created_at, updated_at) VALUES (?, 'a/b', ?, 'x', 'x')");
    insert.run("done", "done"); insert.run("failed", "failed"); insert.run("agent", "agent");
    host.bb.storage.migrate(db, migrationsForDatabase(db));
    expect(db.prepare("SELECT id, occupies_capacity AS o FROM work_items ORDER BY id").all()).toEqual([{ id: "agent", o: null }, { id: "done", o: 0 }, { id: "failed", o: 0 }]);
  });

  it.each([28, 29])("completes a reordered history with %i applied statements", (count) => {
    const host = createFakePluginHost({ pluginId: "partial" }); hosts.push(host);
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, reorderedMigrations.slice(0, count));
    expect(() => host.bb.storage.migrate(db, migrationsForDatabase(db))).not.toThrow();
    expect(() => host.bb.storage.migrate(db, migrationsForDatabase(db))).not.toThrow();
    expect(db.prepare("PRAGMA table_info(work_items)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "queued_event_json" })]));
    expect(new StateStore(db).isPaused()).toBe(false);
  });

});
