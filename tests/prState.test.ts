// The PR state refresh pass: which PRs it reads, what it records, and how it
// shares the sweep's GitHub budget. A real store, a fake GitHub, a clock that
// advances with every request.
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { PR_STALE_MS, refreshPrStates } from "../src/prState";
import { GitHubError, GitHubRateLimitError, type GitHubPull, type Review } from "../src/github";
import { freshNode } from "../src/machine";
import { migrationsForDatabase, StateStore, type NewWorkItem } from "../src/state";
import { workflowSchema } from "../src/workflow";
import type { Cos } from "../src/context";

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
  { id: "ship", name: "Ship", type: "ship", action: "merge", onFail: "build" },
] });

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

type Pull = Pick<GitHubPull, "number" | "state" | "draft" | "merged" | "merged_at" | "head">;
type Ci = "passing" | "failing" | "pending" | "no_checks";

function setup() {
  const host = createFakePluginHost({ pluginId: "pr-state" });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  let now = Date.parse("2026-11-13T10:00:00Z");
  const store = new StateStore(db, () => new Date(now));
  const pulls = new Map<number, Pull | Error>();
  const ci = new Map<number, Ci>();
  const reviews = new Map<number, Review[]>();
  const calls: string[] = [];
  const invalidate = vi.fn();
  // Dispatching a machine event writes the item through updateWorkItem.
  const updates = vi.spyOn(store, "updateWorkItem");
  let hasToken = true;
  const configured = new Set(["acme/app"]);
  const github = {
    get hasToken() { return hasToken; },
    async getPull(_owner: string, _repo: string, number: number) {
      calls.push(`pull ${number}`);
      now += 30_000;
      const pr = pulls.get(number);
      if (!pr) throw new GitHubError("not found", 404, `/pulls/${number}`);
      if (pr instanceof Error) throw pr;
      return pr;
    },
    async ciSummary(_owner: string, _repo: string, sha: string) {
      calls.push(`ci ${sha}`);
      return { state: ci.get(Number(sha)) ?? "passing", failed: [], total: 1 };
    },
    async listReviews(_owner: string, _repo: string, number: number) {
      calls.push(`reviews ${number}`);
      return reviews.get(number) ?? [];
    },
  };
  const cos = {
    bb: host.bb, store, now: () => new Date(now), invalidate,
    github: async () => github,
    repo: async (key: string) => (configured.has(key) ? { owner: key.split("/")[0], repo: key.split("/")[1] } : null),
    safe: async (text: string) => text,
  } as unknown as Cos;
  let seq = 0;
  const add = (number: number, over: Partial<NewWorkItem> = {}) => {
    const id = over.id ?? `item-${number}`;
    // Distinct creation times: the newest item comes first among never-read ones.
    now += 1000 * ++seq;
    store.insertWorkItem({
      id, repo: "acme/app", status: "done", issueTitle: id, issueNumber: null, branch: id, threadId: null, environmentId: null, prNumber: number,
      prUrl: `https://github.com/acme/app/pull/${number}`, providerId: null, model: null, lastError: null, source: "task", lastActivityAt: null,
      finishedAt: null, workflow, nodes: { build: freshNode(), ship: freshNode() }, ...over,
    });
    return id;
  };
  const pull = (number: number, over: Partial<Pull> = {}) => pulls.set(number, { number, state: "open", draft: false, merged: false, merged_at: null, head: { ref: "b", sha: String(number) }, ...over } as Pull);
  const state = (id: string) => store.getWorkItem(id)!.prState;
  const run = async (budgetMs?: number) => {
    calls.length = 0;
    await refreshPrStates(cos, "test", budgetMs === undefined ? {} : { deadline: now + budgetMs });
    return [...calls];
  };
  return {
    store, add, pull, ci, reviews, state, run, calls, invalidate, updates,
    advance: (ms: number) => { now += ms; },
    noToken: () => { hasToken = false; },
    fail: (number: number, error: Error) => pulls.set(number, error),
  };
}

const review = (login: string, state: Review["state"]): Review => ({ user: { login }, state, submitted_at: "" });

it("records merged, closed, failing checks and requested changes", async () => {
  const t = setup();
  const merged = t.add(1); t.pull(1, { state: "closed", merged: true, merged_at: "x" });
  const closed = t.add(2); t.pull(2, { state: "closed" });
  const failing = t.add(3); t.pull(3); t.ci.set(3, "failing");
  const changes = t.add(4); t.pull(4, { draft: true }); t.ci.set(4, "no_checks"); t.reviews.set(4, [review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")]);
  await t.run();
  expect(t.state(merged)).toMatchObject({ number: 1, state: "merged", checks: null, review: null });
  expect(t.state(closed)).toMatchObject({ number: 2, state: "closed", checks: null, review: null });
  expect(t.state(failing)).toMatchObject({ number: 3, state: "open", draft: false, checks: "failing", review: null });
  expect(t.state(changes)).toMatchObject({ number: 4, state: "open", draft: true, checks: "none", review: "changes_requested" });
  // Merged and closed PRs cost one request; open ones also read CI and reviews.
  expect(t.calls.filter((c) => c === "ci 1" || c === "ci 2" || c === "reviews 1" || c === "reviews 2")).toEqual([]);
  expect(t.invalidate).toHaveBeenCalledTimes(1);
});

it("never reads a merged or closed PR again, and re-reads open ones once stale", async () => {
  const t = setup();
  t.add(1); t.pull(1, { state: "closed", merged: true });
  t.add(2); t.pull(2, { state: "closed" });
  t.add(3); t.pull(3);
  await t.run();
  expect(await t.run()).toEqual([]);
  t.advance(PR_STALE_MS);
  expect(await t.run()).toEqual(["pull 3", "ci 3", "reviews 3"]);
  // Nothing changed: no dashboard refresh.
  expect(t.invalidate).toHaveBeenCalledTimes(1);
});

it("reads a PR again when the task re-ships with a new one", async () => {
  const t = setup();
  const id = t.add(1); t.pull(1, { state: "closed" });
  await t.run();
  t.store.updateWorkItem(id, { prNumber: 5 });
  t.pull(5);
  // Shipping records the new PR at once; this covers a ship that could not.
  t.advance(PR_STALE_MS + 1);
  expect(await t.run()).toEqual(["pull 5", "ci 5", "reviews 5"]);
  expect(t.state(id)).toMatchObject({ number: 5, state: "open" });
});

it("covers active tasks CI watching tracks, without dispatching anything", async () => {
  const t = setup();
  const id = t.add(1, { status: "ci", nodes: { build: { ...freshNode(), status: "done" }, ship: { ...freshNode(), status: "running", phase: "ci" } } });
  t.pull(1, { state: "closed", merged: true });
  t.updates.mockClear();
  await t.run();
  expect(t.state(id)).toMatchObject({ state: "merged" });
  expect(t.store.getWorkItem(id)!.status).toBe("ci");
  expect(t.updates).not.toHaveBeenCalled();
});

it("does nothing without a GitHub token or anything due", async () => {
  const t = setup();
  expect(await t.run()).toEqual([]);
  const id = t.add(1); t.pull(1);
  t.noToken();
  expect(await t.run()).toEqual([]);
  expect(t.state(id)).toBeNull();
});

it("stops at the deadline and resumes with the rest on the next pass", async () => {
  const t = setup();
  t.add(1); t.pull(1);
  t.add(2); t.pull(2);
  t.add(3); t.pull(3);
  // Never-read rows come newest first; each getPull takes 30 s.
  expect(await t.run(30_000)).toEqual(["pull 3", "ci 3", "reviews 3"]);
  expect(await t.run(30_000)).toEqual(["pull 2", "ci 2", "reviews 2"]);
  expect(await t.run(30_000)).toEqual(["pull 1", "ci 1", "reviews 1"]);
});

it("stops on a rate limit without marking the PR as attempted", async () => {
  const t = setup();
  const id = t.add(1);
  t.fail(1, new GitHubRateLimitError("rate limited", "/pulls/1", new Date()));
  t.add(2); t.pull(2);
  expect(await t.run()).toEqual(["pull 2", "ci 2", "reviews 2", "pull 1"]);
  // Still never attempted: first in line once the limit lifts.
  expect(t.store.listPrItemsDue("2100-01-01T00:00:00.000Z")[0]).toMatchObject({ id, prState: null });
});

it("moves past a missing PR and an unconfigured repo, so neither starves the others", async () => {
  const t = setup();
  const good = t.add(1); t.pull(1);
  const missing = t.add(2);
  const gone = t.add(3, { repo: "old/repo" });
  // A tight budget: the failures come first (newest), cost their attempt, then go to the back.
  expect(await t.run(1)).toEqual(["pull 2"]);
  expect(await t.run(1)).toEqual(["pull 1", "ci 1", "reviews 1"]);
  expect(t.state(good)).toMatchObject({ state: "open" });
  expect(t.state(missing)).toBeNull();
  expect(t.state(gone)).toBeNull();
  // Both were attempted: neither is due again before it goes stale.
  expect(await t.run()).toEqual([]);
});
