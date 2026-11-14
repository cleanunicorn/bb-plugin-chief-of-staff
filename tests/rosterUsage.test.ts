import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, StateStore, type NewWorkItem } from "../src/state";
import { buildRoster } from "../src/roster";
import { countFinishedUsage, USAGE_BATCH, USAGE_RETRY_MS } from "../src/usage";

/** The roster's entries: buildRoster returns `{ entries, nextBefore }` since #139. */
const roster = async (...args: Parameters<typeof buildRoster>) => (await buildRoster(...args)).entries;
import { readThreadUsage, sumUsage, USAGE_CONCURRENCY } from "../src/threads";
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
  let clock = Date.parse(NOW);
  const store = new StateStore(db, () => new Date(clock));
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
  const invalidate = vi.fn();
  const cos = {
    store,
    invalidate,
    now: () => new Date(clock),
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
  /** Give the item agent threads beyond its builder (item_threads rows). */
  const threads = (itemId: string, ...ids: string[]) => ids.forEach((threadId) => store.upsertThread({ threadId, itemId, role: "step", stepId: "build", agent: 0, environmentId: null, round: 1, promptSentAt: null }));
  const advance = (ms: number) => { clock += ms; };
  return { db, store, cos, add, threads, advance, invalidate, calls, replies, statuses, threadsList, eventsList, pending, peak: () => peak, inFlight: () => inFlight, drain };
}

describe("reading usage of active tasks for the roster", () => {
  it("reads every item's usage concurrently, with a cap", async () => {
    const t = setup({ gate: true });
    const n = 10;
    for (let i = 0; i < n; i++) t.add(`a${i}`);
    const run = roster(t.cos, { withUsage: true });
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
    const entries = await roster(t.cos, { withUsage: true });
    const ids = t.store.listWorkItems({ activeOnly: true }).map((i) => i.id);
    expect(entries.map((e) => e.id)).toEqual(ids);
    for (const e of entries) {
      const i = Number(e.id.slice(1));
      expect(e.usage).toEqual({ inputTokens: i, outputTokens: i * 2, totalTokens: i * 3, cost: { amount: i / 100, currency: "USD" }, threads: 1, reportedThreads: 1, counted: true });
    }
  });

  it("gives all-null usage when the provider reports nothing", async () => {
    const t = setup();
    t.add("quiet");
    t.replies.set("t-quiet", () => []);
    const [e] = await roster(t.cos, { withUsage: true });
    expect(e!.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null, threads: 1, reportedThreads: 0, counted: true });
  });

  it("makes no usage calls without withUsage or a thread", async () => {
    const t = setup();
    t.add("a");
    t.add("b", { threadId: null });
    const plain = await roster(t.cos);
    expect(plain.map((e) => e.usage)).toEqual([null, null]);
    expect(t.eventsList).not.toHaveBeenCalled();
    const withUsage = await roster(t.cos, { withUsage: true });
    expect(t.calls.map((c) => c.threadId)).toEqual(["t-a", "t-a"]);
    expect(withUsage.find((e) => e.id === "b")!.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null, threads: 0, reportedThreads: 0, counted: true });
  });

  it("sums every agent thread of an active task, capping reads across tasks", async () => {
    const t = setup({ gate: true });
    for (let i = 0; i < 3; i++) {
      t.add(`a${i}`);
      t.threads(`a${i}`, `a${i}-plan`, `a${i}-review`, `a${i}-review2`);
    }
    t.replies.set("t-a0", reported(1));
    t.replies.set("a0-plan", reported(2));
    t.replies.set("a0-review", () => []);
    t.replies.set("a0-review2", reported(4));
    const run = roster(t.cos, { withUsage: true });
    await vi.waitFor(() => expect(t.inFlight()).toBe(2 * USAGE_CONCURRENCY));
    const entries = await t.drain(run);
    expect(t.peak()).toBeLessThanOrEqual(2 * USAGE_CONCURRENCY);
    expect(t.calls).toHaveLength(2 * 12);
    const a0 = entries.find((e) => e.id === "a0")!.usage!;
    expect(a0).toMatchObject({ inputTokens: 7, outputTokens: 14, totalTokens: 21, cost: { currency: "USD" }, threads: 4, reportedThreads: 3, counted: true });
    expect(a0.cost!.amount).toBeCloseTo(0.07);
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

describe("summing threads' usage", () => {
  const u = (totalTokens: number | null, cost: { amount: number; currency: string } | null = null) => ({ inputTokens: null, outputTokens: null, totalTokens, cost });

  it("sums only what threads reported, and keeps null rather than 0 when none did", () => {
    expect(sumUsage([])).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null, threads: 0, reportedThreads: 0 });
    expect(sumUsage([u(null), u(null)])).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null, threads: 2, reportedThreads: 0 });
    expect(sumUsage([u(0), u(null)])).toMatchObject({ totalTokens: 0, threads: 2, reportedThreads: 1 });
    expect(sumUsage([u(5, { amount: 0.25, currency: "USD" }), u(null), u(7, { amount: 0.5, currency: "USD" })])).toMatchObject({ totalTokens: 12, cost: { amount: 0.75, currency: "USD" }, threads: 3, reportedThreads: 2 });
  });

  it("leaves cost out when the threads report different currencies", () => {
    expect(sumUsage([u(5, { amount: 1, currency: "USD" }), u(7, { amount: 1, currency: "EUR" })])).toMatchObject({ totalTokens: 12, cost: null, reportedThreads: 2 });
  });
});

describe("counting finished tasks' usage", () => {
  const done = (over: Partial<NewWorkItem> = {}): Partial<NewWorkItem> => ({ status: "done", finishedAt: "2026-11-13T09:00:00.000Z", ...over });
  const nothing = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null };
  const checkedAt = (t: ReturnType<typeof setup>, id: string) => (t.db.prepare("SELECT usage_checked_at FROM work_items WHERE id = ?").get(id) as { usage_checked_at: string | null }).usage_checked_at;

  it("stores the sum over every thread of the task, including a replaced builder", async () => {
    const t = setup();
    t.add("a", done({ threadId: "builder-2" }));
    t.threads("a", "builder-1", "chooser", "plan", "review-1", "review-2");
    t.replies.set("builder-1", reported(10));
    t.replies.set("builder-2", reported(20));
    t.replies.set("chooser", reported(1));
    t.replies.set("plan", reported(2));
    t.replies.set("review-1", () => []);
    t.replies.set("review-2", reported(3));
    expect(await countFinishedUsage(t.cos)).toEqual(["a"]);
    const usage = t.store.getWorkItem("a")!.taskUsage!;
    expect(usage).toMatchObject({ inputTokens: 36, outputTokens: 72, totalTokens: 108, cost: { currency: "USD" }, threads: 6, reportedThreads: 5 });
    expect(usage.cost!.amount).toBeCloseTo(0.36);
    expect(t.invalidate).toHaveBeenCalledTimes(1);
    // Counted once: the next pass reads nothing.
    t.calls.length = 0;
    t.advance(USAGE_RETRY_MS + 1);
    expect(await countFinishedUsage(t.cos)).toEqual([]);
    expect(t.calls).toHaveLength(0);
    expect(t.invalidate).toHaveBeenCalledTimes(1);
  });

  it("stores nothing while a thread is busy, and counts it once every thread stopped", async () => {
    const t = setup();
    t.add("a", done());
    t.threads("a", "review");
    t.statuses.set("review", "active");
    expect(await countFinishedUsage(t.cos)).toEqual([]);
    expect(t.calls).toHaveLength(0);
    expect(t.store.getWorkItem("a")!.taskUsage).toBeNull();
    expect(checkedAt(t, "a")).toBe(NOW);
    // Not tried again before the retry time.
    t.statuses.delete("review");
    expect(await countFinishedUsage(t.cos)).toEqual([]);
    t.advance(USAGE_RETRY_MS + 1);
    expect(await countFinishedUsage(t.cos)).toEqual(["a"]);
    expect(t.store.getWorkItem("a")!.taskUsage!.threads).toBe(2);
  });

  it("stores nothing when the thread states cannot be listed", async () => {
    const t = setup();
    t.add("a", done());
    t.threadsList.mockRejectedValueOnce(new Error("down"));
    expect(await countFinishedUsage(t.cos)).toEqual([]);
    expect(t.store.getWorkItem("a")!.taskUsage).toBeNull();
    expect(checkedAt(t, "a")).toBe(NOW);
  });

  it("counts a deleted thread as reporting nothing", async () => {
    const t = setup();
    t.add("a", done());
    t.threads("a", "gone");
    t.replies.set("gone", () => { throw Object.assign(new Error("Thread not found"), { status: 404 }); });
    expect(await countFinishedUsage(t.cos)).toEqual(["a"]);
    expect(t.store.getWorkItem("a")!.taskUsage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: { amount: 0.01, currency: "USD" }, threads: 2, reportedThreads: 1 });
  });

  it("stamps a failed read and tries it again later", async () => {
    const t = setup();
    t.add("a", done());
    t.replies.set("t-a", (q) => {
      if (q.types[0] === "thread/tokenUsage/updated") throw new Error("down");
      return reported(1)(q);
    });
    expect(await countFinishedUsage(t.cos)).toEqual([]);
    expect(t.store.getWorkItem("a")!.taskUsage).toBeNull();
    expect(checkedAt(t, "a")).toBe(NOW);
    expect(t.invalidate).not.toHaveBeenCalled();
    t.replies.delete("t-a");
    t.advance(USAGE_RETRY_MS + 1);
    expect(await countFinishedUsage(t.cos)).toEqual(["a"]);
  });

  it("stores a task whose threads reported nothing as counted with null tokens, never 0", async () => {
    const t = setup();
    t.add("quiet", done());
    t.replies.set("t-quiet", () => []);
    t.add("threadless", done({ threadId: null }));
    expect((await countFinishedUsage(t.cos)).sort()).toEqual(["quiet", "threadless"]);
    expect(t.store.getWorkItem("quiet")!.taskUsage).toEqual({ ...nothing, threads: 1, reportedThreads: 0 });
    expect(t.store.getWorkItem("threadless")!.taskUsage).toEqual({ ...nothing, threads: 0, reportedThreads: 0 });
    expect((t.db.prepare("SELECT usage_tokens FROM work_items WHERE id = 'quiet'").get() as { usage_tokens: number | null }).usage_tokens).toBeNull();
  });

  it("counts a bounded batch per pass, rotating past items that keep failing", async () => {
    const t = setup();
    for (let i = 0; i < USAGE_BATCH + 3; i++) t.add(`d${String(i).padStart(2, "0")}`, done({ finishedAt: `2026-11-13T09:${String(i).padStart(2, "0")}:00.000Z` }));
    // The two most recently finished keep failing.
    const failing = [`d${USAGE_BATCH + 2}`, `d${USAGE_BATCH + 1}`];
    for (const id of failing) t.replies.set(`t-${id}`, () => { throw new Error("down"); });
    const first = await countFinishedUsage(t.cos);
    expect(first).toHaveLength(USAGE_BATCH - 2);
    t.advance(USAGE_RETRY_MS + 1);
    // Never-tried items go before the ones that failed.
    const second = await countFinishedUsage(t.cos);
    expect(second).toEqual(["d02", "d01", "d00"]);
    expect(t.store.getWorkItem(failing[0]!)!.taskUsage).toBeNull();
  });

  it("never counts an active task", async () => {
    const t = setup();
    t.add("live");
    expect(await countFinishedUsage(t.cos)).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });

  it("stops when Chief of Staff is paused", async () => {
    const t = setup();
    t.add("a", done());
    t.store.setPaused(true);
    expect(await countFinishedUsage(t.cos)).toEqual([]);
    expect(t.calls).toHaveLength(0);
  });
});

describe("finished tasks on the roster", () => {
  const done = (over: Partial<NewWorkItem> = {}): Partial<NewWorkItem> => ({ status: "done", finishedAt: "2026-11-13T09:00:00.000Z", ...over });

  it("makes no usage calls for finished tasks, showing the stored count or that it is not counted yet", async () => {
    const t = setup();
    for (let i = 0; i < 55; i++) t.add(`d${i}`, done());
    t.threads("d3", "d3-review");
    t.add("live");
    await countFinishedUsage(t.cos, 100);
    t.add("fresh", done());
    t.threads("fresh", "fresh-review");
    t.calls.length = 0;
    const entries = await roster(t.cos, { includeDone: true, finishedLimit: 100, withUsage: true });
    expect(t.calls.map((c) => c.threadId)).toEqual(["t-live", "t-live"]);
    expect(entries.find((e) => e.id === "d3")!.usage).toEqual({ inputTokens: 2, outputTokens: 4, totalTokens: 6, cost: { amount: 0.02, currency: "USD" }, threads: 2, reportedThreads: 2, counted: true });
    expect(entries.find((e) => e.id === "fresh")!.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null, threads: 2, reportedThreads: 0, counted: false });
  });

  it("reads usage again after a reopened task finishes", async () => {
    const t = setup();
    t.add("a", done());
    await countFinishedUsage(t.cos);
    t.store.updateWorkItem("a", { status: "agent", finishedAt: null });
    t.store.updateWorkItem("a", { status: "done", finishedAt: NOW });
    expect((await roster(t.cos, { includeDone: true, withUsage: true }))[0]!.usage!.counted).toBe(false);
    t.replies.set("t-a", reported(7));
    expect(await countFinishedUsage(t.cos)).toEqual(["a"]);
    expect((await roster(t.cos, { includeDone: true, withUsage: true }))[0]!.usage!.totalTokens).toBe(21);
  });

  it("leaves usage out without withUsage, even when it is stored", async () => {
    const t = setup();
    t.add("a", done());
    await countFinishedUsage(t.cos);
    const [e] = await roster(t.cos, { includeDone: true });
    expect(e!.usage).toBeNull();
  });
});
