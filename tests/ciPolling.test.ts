import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { watchCi } from "../src/delivery";
import { GitHubRateLimitError } from "../src/github";
import { freshNode } from "../src/machine";
import { workflowSchema } from "../src/workflow";
import type { Cos } from "../src/context";
import type { WorkItem } from "../src/state";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function setup(failure?: Error, pull: Record<string, unknown> = { state: "open", merged: false }) {
  const host = createFakePluginHost({ pluginId: "test" });
  hosts.push(host);
  const workflow = workflowSchema.parse({ id: "poll", name: "Poll", steps: [
    { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
    { id: "ship", name: "Ship", type: "ship", action: "merge" },
  ] });
  const items = [1, 2, 3].map((number) => ({
    id: `item-${number}`, repo: "acme/app", prNumber: number, workflow,
    nodes: { build: { ...freshNode(), status: "done" }, ship: { ...freshNode(), status: "running", phase: "ci" } },
  } satisfies Partial<WorkItem>));
  let now = 0;
  const calls: number[] = [];
  const recorded: [string, unknown][] = [];
  const github = {
    hasToken: true,
    async getPull(_owner: string, _repo: string, number: number) {
      calls.push(number);
      now += 60_000;
      if (failure && number === 1) throw failure;
      return { number, draft: false, merged_at: null, ...pull, head: { sha: "abc" } };
    },
    async ciSummary() { return { state: "pending" }; },
  };
  // Recreate the context each pass: progress must survive plugin reloads in KV.
  const context = () => ({
    bb: host.bb, store: { listWorkItems: () => items, isPaused: () => false, setPrState: (id: string, state: unknown) => recorded.push([id, state]) },
    github: async () => github, repo: async () => ({ owner: "acme", repo: "app" }),
    now: () => new Date(now), safe: async (text: string) => text,
  }) as unknown as Cos;
  const poll = async (budget: number) => {
    calls.length = 0;
    await watchCi(context(), "test", { deadline: now + budget });
    return [...calls];
  };
  return { poll, recorded };
}

it("resumes after the last polled task across deadline-limited passes and reloads", async () => {
  const { poll } = setup();
  expect(await poll(120_000)).toEqual([1, 2]);
  expect(await poll(120_000)).toEqual([3, 1]);
  expect(await poll(120_000)).toEqual([2, 3]);
});

it.each([
  new Error("request timed out"),
  new GitHubRateLimitError("rate limited", "/pulls/1", new Date(60_000)),
])("advances past an unsuccessful poll ($message)", async (error) => {
  const { poll } = setup(error);
  expect(await poll(60_000)).toEqual([1]);
  expect(await poll(60_000)).toEqual([2]);
});

it.each([
  { merged: true, state: "merged" },
  { merged: false, state: "closed" },
])("records a $state PR on its way out", async ({ merged, state }) => {
  const { poll, recorded } = setup(undefined, { state: "closed", merged });
  await poll(60_000);
  expect(recorded).toEqual([["item-1", { number: 1, state, draft: false, checks: null, review: null, checkedAt: new Date(60_000).toISOString() }]]);
});

it("leaves an open PR's state to the PR state refresh", async () => {
  const { poll, recorded } = setup();
  await poll(60_000);
  expect(recorded).toEqual([]);
});

describe("a head with no checks reported (#50)", () => {
  function graceSetup() {
    const host = createFakePluginHost({ pluginId: "test" });
    hosts.push(host);
    const workflow = workflowSchema.parse({ id: "grace", name: "Grace", steps: [
      { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
      { id: "ship", name: "Ship", type: "ship", action: "merge", requireApproval: false },
    ] });
    const item = {
      id: "item-1", repo: "acme/app", prNumber: 1, workflow,
      nodes: { build: { ...freshNode(), status: "done" }, ship: { ...freshNode(), status: "running", phase: "ci" } },
    } satisfies Partial<WorkItem>;
    const state = { now: 0, sha: "abc", ci: "no_checks" as string };
    const dispatched: string[] = [];
    const github = {
      hasToken: true,
      async getPull(_owner: string, _repo: string, number: number) {
        return { number, state: "open", merged: false, draft: false, merged_at: null, head: { sha: state.sha } };
      },
      async ciSummary() { return { state: state.ci, failed: [], total: state.ci === "no_checks" ? 0 : 1 }; },
      async getJobLogsForRun() { return ""; },
    };
    // dispatch() reads the item first: record that, and stop there.
    const cos = {
      bb: host.bb,
      store: { listWorkItems: () => [item], isPaused: () => false, setPrState: () => {}, getWorkItem: (id: string) => { dispatched.push(`${id}@${state.ci}`); return null; } },
      github: async () => github, repo: async () => ({ owner: "acme", repo: "app" }),
      now: () => new Date(state.now), safe: async (text: string) => text,
    } as unknown as Cos;
    const poll = async (atMinutes: number) => {
      state.now = atMinutes * 60_000;
      dispatched.length = 0;
      await watchCi(cos, "test");
      return [...dispatched];
    };
    return { poll, state };
  }

  it("holds a head with no checks as pending for the grace, then passes it", async () => {
    const { poll } = graceSetup();
    expect(await poll(0)).toEqual([]);
    expect(await poll(2)).toEqual([]);
    expect(await poll(4.9)).toEqual([]);
    expect(await poll(5)).toEqual(["item-1@no_checks"]);
  });

  it("restarts the grace for a new head sha", async () => {
    const { poll, state } = graceSetup();
    await poll(0);
    expect(await poll(6)).toEqual(["item-1@no_checks"]);
    // A fix pushes a new head: its checks have not registered yet.
    state.sha = "def";
    expect(await poll(8)).toEqual([]);
    expect(await poll(12)).toEqual([]);
    expect(await poll(13)).toEqual(["item-1@no_checks"]);
  });

  it.each([
    { ci: "pending", dispatched: [] },
    { ci: "passing", dispatched: ["item-1@passing"] },
    { ci: "failing", dispatched: ["item-1@failing"] },
  ])("acts on checks that appear during the grace: $ci", async ({ ci, dispatched }) => {
    const { poll, state } = graceSetup();
    expect(await poll(0)).toEqual([]);
    state.ci = ci;
    expect(await poll(2)).toEqual(dispatched);
  });
});
