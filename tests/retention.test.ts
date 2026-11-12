import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, REMOVED_SUMMARY, StateStore, type NewWorkItem } from "../src/state";
import { freshNode, type NodeState, type Nodes } from "../src/machine";
import { settingsFor, workflowSchema } from "../src/workflow";
import { computeStats, statsWindowStart } from "../src/stats";
import { maybeRunRetention, runRetention } from "../src/retention";
import { threadGroupKey, threadParentKey } from "../src/threadGroups";
import type { Cos } from "../src/context";

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "pick", name: "Pick", type: "model", mode: "auto", next: ["build"] },
  { id: "build", name: "Build", type: "agent", writes: true, next: ["review"] },
  { id: "review", name: "Review", type: "agent", agents: 2, verdict: true, onFail: "build", next: [] },
] });

const NOW = "2026-11-12T10:00:00.000Z";
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

const report = (summary: string, extra: Record<string, unknown> = {}) => ({ outcome: "done" as const, summary, at: daysAgo(100), via: "tool" as const, delivery: "d1", ...extra });
function fullNodes(): Nodes {
  const node = (over: Partial<NodeState>): NodeState => ({ ...freshNode(), round: 1, status: "done", startedAt: daysAgo(100), finishedAt: daysAgo(100), ...over });
  return {
    pick: node({ reports: [report("Opus, because auth", { pick: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" } })] }),
    build: node({
      attempts: 1, feedback: "x".repeat(5_000), output: "log".repeat(2_000), reports: [report("Built it", { question: "Which DB?" })], nudges: [1],
      deliveries: { 0: { id: "d1", round: 1, threadId: "t-build", state: "accepted", sentAt: 1 } },
      agentRetries: { 0: { effect: { type: "agent", step: "build", agent: 0, kind: "start" }, at: null, count: 1 } },
    }),
    review: node({ status: "waiting", reports: [report("Looks wrong", { outcome: "failed" }), null], waiting: { kind: "escalation", reason: "Gave up" } }),
  };
}

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function setup() {
  const host = createFakePluginHost({ pluginId: "retention" });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  let clock = Date.parse(NOW);
  const store = new StateStore(db, () => new Date(clock));
  const cos = { bb: host.bb, store, now: () => new Date(clock) } as unknown as Cos;
  /** An item finished `days` ago (or active, when days is null). */
  const add = (id: string, days: number | null, over: Partial<NewWorkItem> = {}) => {
    store.insertWorkItem({
      id, repo: "a/b", status: days === null ? "agent" : "failed", issueTitle: id, issueNumber: 7, branch: `b-${id}`, threadId: `t-${id}`, environmentId: "env", prNumber: 3, prUrl: "u",
      providerId: null, model: null, lastError: days === null ? null : "boom", source: "task", lastActivityAt: null, finishedAt: days === null ? null : daysAgo(days),
      workflow, nodes: fullNodes(), ...over,
    });
    const at = daysAgo(days ?? 0);
    db.prepare("UPDATE work_items SET created_at = ?, updated_at = ?, check_output = 'check', pending_report_json = '{}' WHERE id = ?").run(daysAgo((days ?? 0) + 1), at, id);
    store.upsertThread({ threadId: `t-${id}`, itemId: id, role: "builder", stepId: null, agent: 0, environmentId: "env", round: 1, promptSentAt: null });
    store.updateThread(`t-${id}`, { pendingReport: { ...report("pending"), step: "build", round: 1 } });
  };
  const raw = (id: string) => db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Record<string, unknown>;
  return { host, db, store, cos, add, raw, setClock: (iso: string) => { clock = Date.parse(iso); } };
}

const olderThan = daysAgo(90);

describe("compacting finished items", () => {
  it("removes bulky step text but keeps what retry, revive and rerun read", () => {
    const { store, add, raw } = setup();
    add("old", 91);
    const before = raw("old");
    const beforeItem = store.getWorkItem("old")!;
    expect(store.compactFinished(olderThan)).toEqual(["old"]);
    const after = raw("old");
    const item = store.getWorkItem("old")!;
    // Scalars and timestamps are unchanged.
    for (const column of ["repo", "issue_number", "issue_title", "status", "branch", "pr_number", "created_at", "updated_at", "finished_at", "last_error", "fix_attempts", "workflow_json", "occupies_capacity"]) {
      expect(after[column]).toEqual(before[column]);
    }
    expect(after).toMatchObject({ check_output: null, pending_report_json: null, detail_pruned_at: NOW });
    // Node structure is kept: statuses, report slots, picks, waiting, nudges.
    expect(item.nodes.build).toMatchObject({ status: "done", round: 1, attempts: 1, feedback: null, output: null, nudges: [1], startedAt: daysAgo(100) });
    expect(item.nodes.build).not.toHaveProperty("deliveries");
    expect(item.nodes.build).not.toHaveProperty("agentRetries");
    expect(item.nodes.build!.reports).toEqual([{ outcome: "done", summary: REMOVED_SUMMARY, at: daysAgo(100), via: "tool", delivery: "d1", question: null }]);
    expect(item.nodes.review!.reports).toEqual([{ outcome: "failed", summary: REMOVED_SUMMARY, at: daysAgo(100), via: "tool", delivery: "d1" }, null]);
    expect(item.nodes.review!.waiting).toEqual({ kind: "escalation", reason: "Gave up" });
    expect(item.nodes.pick!.reports[0]!.pick).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(settingsFor(item.workflow, "build", item.nodes)).toEqual(settingsFor(beforeItem.workflow, "build", beforeItem.nodes));
    // Thread links stay; only their pending report goes.
    expect(store.listThreads("old")).toEqual([expect.objectContaining({ threadId: "t-old", pendingReport: null })]);
    expect(store.compactFinished(olderThan)).toEqual([]);
  });

  it("leaves recent and active items alone", () => {
    const { store, add, raw } = setup();
    add("recent", 89);
    add("active", null);
    add("active-long", null, { finishedAt: null });
    const before = ["recent", "active", "active-long"].map(raw);
    expect(store.compactFinished(olderThan)).toEqual([]);
    expect(["recent", "active", "active-long"].map(raw)).toEqual(before);
  });

  it("compacts done items without finished_at by their last update", () => {
    const { store, add } = setup();
    add("old-done", 120, { status: "done", finishedAt: null });
    expect(store.compactFinished(olderThan)).toEqual(["old-done"]);
  });

  it("marks rows without readable step state so the pass ends", () => {
    const { store, add, db, raw } = setup();
    add("legacy", 200);
    add("garbled", 200);
    db.prepare("UPDATE work_items SET nodes_json = NULL WHERE id = 'legacy'").run();
    db.prepare("UPDATE work_items SET nodes_json = 'not json' WHERE id = 'garbled'").run();
    expect(store.compactFinished(olderThan).sort()).toEqual(["garbled", "legacy"]);
    expect(raw("legacy")).toMatchObject({ nodes_json: null, detail_pruned_at: NOW });
    expect(store.compactFinished(olderThan)).toEqual([]);
  });

  it("keeps deferred events waiting on a paused project", () => {
    const { store, add, db } = setup();
    add("old", 91);
    add("active", null);
    add("paused-old", 91, { repo: "c/d" });
    store.setRepoPaused("c/d", true);
    for (const id of ["old", "active", "paused-old"]) store.deferEvent(id, { type: "retry" }, "test");
    store.compactFinished(olderThan);
    expect((db.prepare("SELECT item_id FROM deferred_events ORDER BY id").all() as { item_id: string }[]).map((r) => r.item_id)).toEqual(["active", "paused-old"]);
  });

  it("does not change stats", () => {
    const { store, add } = setup();
    add("old", 91);
    add("older-done", 95, { status: "done" });
    add("recent", 10, { status: "done" });
    add("active", null);
    const now = new Date(NOW);
    const stats = () => computeStats(store.statsRows(statsWindowStart(now, 90)), now, 90, store.countWorkItems());
    const before = stats();
    expect(store.compactFinished(olderThan)).toHaveLength(2);
    expect(stats()).toEqual(before);
  });

  it("compacts a re-activated item again once it finishes again", () => {
    const { store, add, db, raw, setClock } = setup();
    add("old", 91);
    store.compactFinished(olderThan);
    store.updateWorkItem("old", { status: "agent", finishedAt: null, lastError: null });
    expect(raw("old").detail_pruned_at).toBeNull();
    store.updateWorkItem("old", { status: "failed", finishedAt: NOW });
    expect(raw("old").detail_pruned_at).toBeNull();
    setClock(daysAgo(-91));
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = 'old'").run(NOW);
    expect(store.compactFinished(daysAgo(-1))).toEqual(["old"]);
  });

  it("keeps the marker when a finished item is written again", () => {
    const { store, add, raw } = setup();
    add("old", 91);
    store.compactFinished(olderThan);
    store.updateWorkItem("old", { lastActivityAt: NOW });
    expect(raw("old").detail_pruned_at).toBe(NOW);
  });
});

describe("runRetention", () => {
  it("drains every batch and forgets the compacted items' thread grouping", async () => {
    const { cos, add, host } = setup();
    for (let i = 0; i < 5; i++) add(`old${i}`, 91 + i);
    add("recent", 30);
    for (const id of ["old0", "old4", "recent"]) {
      await host.bb.storage.kv.set(threadParentKey(id), `t-${id}`);
      await host.bb.storage.kv.set(threadGroupKey(id), `t-${id}`);
    }
    expect(await runRetention(cos, "test", 2)).toBe(5);
    for (const id of ["old0", "old4"]) {
      expect(await host.bb.storage.kv.get(threadParentKey(id))).toBeUndefined();
      expect(await host.bb.storage.kv.get(threadGroupKey(id))).toBeUndefined();
    }
    expect(await host.bb.storage.kv.get(threadParentKey("recent"))).toBe("t-recent");
    expect(await host.bb.storage.kv.get("sweep:lastRetentionAt")).toBe(NOW);
    expect(cos.store.listLog().map((e) => e.message)).toContain("removed step details of 5 tasks finished more than 90 days ago");
    expect(await runRetention(cos, "test")).toBe(0);
  });

  it("runs at most once a day and not while paused", async () => {
    const { cos, add, setClock } = setup();
    add("a", 91);
    cos.store.setPaused(true);
    expect(await maybeRunRetention(cos, "test")).toBe(false);
    cos.store.setPaused(false);
    expect(await maybeRunRetention(cos, "test")).toBe(true);
    setClock(daysAgo(-0.5));
    expect(await maybeRunRetention(cos, "test")).toBe(false);
    setClock(daysAgo(-1));
    expect(await maybeRunRetention(cos, "test")).toBe(true);
  });
});
