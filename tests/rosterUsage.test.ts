import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, StateStore, type NewWorkItem } from "../src/state";
import { buildRoster, USAGE_CONCURRENCY } from "../src/roster";
import { readThreadUsage } from "../src/threads";
import { workflowSchema } from "../src/workflow";
import type { Cos } from "../src/context";

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [{ id: "build", name: "Build", type: "agent", writes: true, next: [] }] });
const NOW = "2026-11-13T10:00:00.000Z";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

type EventsQuery = { threadId: string; types: string[] };
type Handler = (query: EventsQuery) => unknown;

/** The provider's reply for a thread: tokens and cost, as the two usage events carry them. */
const reported = (n: number): Handler => (q) => q.types[0] === "thread/tokenUsage/updated"
  ? [{ data: { tokenUsage: { total: { inputTokens: n, outputTokens: n * 2, totalTokens: n * 3 } } } }]
  : [{ data: { contextWindowUsage: { cost: { amount: n / 100, currency: "USD" } } } }];

function setup(opts: { gate?: boolean } = {}) {
  const host = createFakePluginHost({ pluginId: "roster-usage" });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  const store = new StateStore(db, () => new Date(NOW));
  const calls: EventsQuery[] = [];
  const pending: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;
  /** Thread id → its reply; default: tokens 1, cost 0.01. */
  const replies = new Map<string, Handler>();
  const statuses = new Map<string, string>();
  const threadsList = vi.fn(async ({ threadIds }: { threadIds: string[] }) => threadIds.map((id) => ({ id, status: "active", runtime: { displayStatus: statuses.get(id) ?? "idle" }, title: id })));
  const eventsList = vi.fn(async (query: EventsQuery) => {
    calls.push(query);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      if (opts.gate) await new Promise<void>((resolve) => pending.push(resolve));
      return (replies.get(query.threadId) ?? reported(1))(query);
    } finally {
      inFlight--;
    }
  });
  const cos = {
    store,
    now: () => new Date(NOW),
    config: async () => ({ values: { stallThresholdMinutes: 30 } }),
    bb: { sdk: { threads: { list: threadsList, events: { list: eventsList } } }, log: { debug: vi.fn(), warn: vi.fn() } },
  } as unknown as Cos;
  const add = (id: string, over: Partial<NewWorkItem> = {}) => store.insertWorkItem({
    id, repo: "a/b", status: "agent", issueTitle: id, issueNumber: 1, branch: null, threadId: `t-${id}`, environmentId: null, prNumber: null, prUrl: null,
    providerId: null, model: null, lastError: null, source: "task", lastActivityAt: null, finishedAt: null, workflow, nodes: {}, ...over,
  });
  /** Release gated calls until the roster settles. */
  const drain = async <T>(run: Promise<T>): Promise<T> => {
    let done = false;
    void run.finally(() => { done = true; });
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      pending.splice(0).forEach((release) => release());
    }
    return run;
  };
  return { db, store, cos, add, calls, replies, statuses, threadsList, eventsList, pending, peak: () => peak, inFlight: () => inFlight, drain };
}

describe("reading usage for the roster", () => {
  it("reads every item's usage concurrently, with a cap", async () => {
    const t = setup({ gate: true });
    const n = 10;
    for (let i = 0; i < n; i++) t.add(`a${i}`);
    const run = buildRoster(t.cos, { withUsage: true });
    await vi.waitFor(() => expect(t.inFlight()).toBe(2 * USAGE_CONCURRENCY));
    // No call gets past the cap while the first batch is held.
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.inFlight()).toBe(2 * USAGE_CONCURRENCY);
    const entries = await t.drain(run);
    expect(t.calls).toHaveLength(2 * n);
    expect(t.peak()).toBeGreaterThan(2);
    expect(t.peak()).toBeLessThanOrEqual(2 * USAGE_CONCURRENCY);
    expect(entries).toHaveLength(n);
  });

  it("keeps entry order and parses usage as before", async () => {
    const t = setup();
    for (let i = 1; i <= 6; i++) {
      t.add(`a${i}`);
      t.replies.set(`t-a${i}`, reported(i));
    }
    const entries = await buildRoster(t.cos, { withUsage: true });
    const ids = t.store.listWorkItems({ activeOnly: true }).map((i) => i.id);
    expect(entries.map((e) => e.id)).toEqual(ids);
    for (const e of entries) {
      const i = Number(e.id.slice(1));
      expect(e.usage).toEqual({ inputTokens: i, outputTokens: i * 2, totalTokens: i * 3, cost: { amount: i / 100, currency: "USD" } });
    }
  });

  it("gives all-null usage when the provider reports nothing", async () => {
    const t = setup();
    t.add("quiet");
    t.replies.set("t-quiet", () => []);
    const [e] = await buildRoster(t.cos, { withUsage: true });
    expect(e!.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null });
  });

  it("makes no usage calls without withUsage or a thread", async () => {
    const t = setup();
    t.add("a");
    t.add("b", { threadId: null });
    const plain = await buildRoster(t.cos);
    expect(plain.map((e) => e.usage)).toEqual([null, null]);
    expect(t.eventsList).not.toHaveBeenCalled();
    const withUsage = await buildRoster(t.cos, { withUsage: true });
    expect(t.calls.map((c) => c.threadId)).toEqual(["t-a", "t-a"]);
    expect(withUsage.find((e) => e.id === "b")!.usage).toBeNull();
  });

  it("tells a failed read apart from a provider that reports nothing", async () => {
    const t = setup();
    t.replies.set("t-empty", () => []);
    expect(await readThreadUsage(t.cos, "t-empty")).toEqual({ usage: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null }, complete: true });
    t.replies.set("t-half", (q) => {
      if (q.types[0] === "thread/contextWindowUsage/updated") throw new Error("down");
      return reported(5)(q);
    });
    expect(await readThreadUsage(t.cos, "t-half")).toEqual({ usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15, cost: null }, complete: false });
  });
});

describe("final usage of finished items", () => {
  const done = (over: Partial<NewWorkItem> = {}): Partial<NewWorkItem> => ({ status: "done", finishedAt: "2026-11-13T09:00:00.000Z", ...over });
  const nothing = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null };

  it("reads a finished item once, stores it, and makes no calls for it afterwards", async () => {
    const t = setup();
    for (let i = 0; i < 55; i++) t.add(`d${i}`, done());
    t.add("live");
    t.replies.set("t-d3", reported(3));
    const first = await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(t.calls).toHaveLength(2 * 56);
    expect(t.store.getWorkItem("d3")!.finalUsage).toEqual({ inputTokens: 3, outputTokens: 6, totalTokens: 9, cost: { amount: 0.03, currency: "USD" } });
    t.calls.length = 0;
    const second = await buildRoster(t.cos, { includeDone: true, withUsage: true });
    // Only the unfinished item is read again.
    expect(t.calls.map((c) => c.threadId)).toEqual(["t-live", "t-live"]);
    expect(second.map((e) => e.usage)).toEqual(first.map((e) => e.usage));
    expect(t.store.getWorkItem("live")!.finalUsage).toBeNull();
  });

  it("stores a provider that reports nothing as known, and still shows no usage", async () => {
    const t = setup();
    t.add("quiet", done());
    t.replies.set("t-quiet", () => []);
    await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(t.store.getWorkItem("quiet")!.finalUsage).toEqual(nothing);
    t.calls.length = 0;
    const [e] = await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(t.calls).toHaveLength(0);
    expect(e!.usage).toEqual(nothing);
  });

  it("does not store a read that failed, and reads it again next time", async () => {
    const t = setup();
    t.add("flaky", done());
    t.replies.set("t-flaky", (q) => {
      if (q.types[0] === "thread/tokenUsage/updated") throw new Error("down");
      return reported(1)(q);
    });
    const [e] = await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(e!.usage!.cost).toEqual({ amount: 0.01, currency: "USD" });
    expect(t.store.getWorkItem("flaky")!.finalUsage).toBeNull();
    t.replies.delete("t-flaky");
    t.calls.length = 0;
    await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(t.calls).toHaveLength(2);
    expect(t.store.getWorkItem("flaky")!.finalUsage).not.toBeNull();
  });

  it("does not store usage while the thread is still busy", async () => {
    const t = setup();
    t.add("manual", done());
    t.statuses.set("t-manual", "active");
    await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(t.store.getWorkItem("manual")!.finalUsage).toBeNull();
    t.statuses.set("t-manual", "idle");
    await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(t.store.getWorkItem("manual")!.finalUsage).not.toBeNull();
  });

  it("does not store usage when the thread states could not be listed", async () => {
    const t = setup();
    t.add("a", done());
    t.threadsList.mockRejectedValueOnce(new Error("down"));
    const [e] = await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(e!.usage).not.toBeNull();
    expect(t.store.getWorkItem("a")!.finalUsage).toBeNull();
  });

  it("reads usage again after a reopened item finishes", async () => {
    const t = setup();
    t.add("a", done());
    await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(t.store.getWorkItem("a")!.finalUsage).not.toBeNull();
    t.store.updateWorkItem("a", { status: "agent", finishedAt: null });
    t.store.updateWorkItem("a", { status: "done", finishedAt: NOW });
    t.replies.set("t-a", reported(7));
    t.calls.length = 0;
    const [e] = await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(t.calls).toHaveLength(2);
    expect(e!.usage!.totalTokens).toBe(21);
    expect(t.store.getWorkItem("a")!.finalUsage!.totalTokens).toBe(21);
  });

  it("keeps the roster when storing usage fails", async () => {
    const t = setup();
    t.add("a", done());
    vi.spyOn(t.store, "setFinalUsage").mockImplementation(() => { throw new Error("disk full"); });
    const [e] = await buildRoster(t.cos, { includeDone: true, withUsage: true });
    expect(e!.usage!.totalTokens).toBe(3);
  });

  it("leaves usage out without withUsage, even when it is stored", async () => {
    const t = setup();
    t.add("a", done());
    t.store.setFinalUsage("a", "t-a", nothing);
    const [e] = await buildRoster(t.cos, { includeDone: true });
    expect(e!.usage).toBeNull();
  });
});

