import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { runIntake } from "../src/intake";
import { repoConfigSchema, type RepoConfig } from "../src/config";
import type { Cos } from "../src/context";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function setup({ fail = false, empty = false } = {}) {
  const host = createFakePluginHost({ pluginId: "test" });
  hosts.push(host);
  const repos = ["slow", "fast"].map((repo) => repoConfigSchema.parse({ owner: "acme", repo, projectId: "project" }) as RepoConfig);
  let now = 0;
  const listed: string[] = [];
  const considered: number[] = [];
  let issues = [1, 2, 3];
  const github = {
    hasToken: true,
    async listOpenIssues(_owner: string, repo: string) {
      listed.push(repo);
      if (repo === "fast") return [];
      // Five 25-second pages can use the budget without any request timing out.
      now += 125_000;
      if (fail) throw new Error("listing failed");
      return empty ? [] : issues.map((number) => ({ number }));
    },
  };
  const context = () => ({
    bb: host.bb, config: async () => ({ repos, values: { maxConcurrentTotal: 4 } }),
    github: async () => github, now: () => new Date(now), safe: async (text: string) => text,
    store: {
      listWorkItems: () => [], isPaused: () => false, isRepoPaused: () => false, log: () => {},
      findActiveForIssue: (_repo: string, number: number) => { considered.push(number); return true; },
    },
  }) as unknown as Cos;
  const poll = async (options: { dryRun?: boolean; repo?: string; bounded?: boolean } = {}) => {
    listed.length = 0;
    await runIntake(context(), { actor: "test", ...options, ...(options.bounded === false ? {} : { deadline: now + 120_000 }) });
    return [...listed];
  };
  return { poll, considered, removeIssue: (number: number) => { issues = issues.filter((n) => n !== number); } };
}

it("resumes across repositories and issues after a slow listing, including across reloads", async () => {
  const { poll, considered } = setup();
  expect(await poll()).toEqual(["slow"]);
  expect(await poll()).toEqual(["fast", "slow"]);
  expect(await poll()).toEqual(["fast", "slow"]);
  expect(considered).toEqual([1, 2, 3]);
});

it.each([{ fail: true }, { empty: true }])("advances past an unsuccessful or empty repository ($fail, $empty)", async (options) => {
  const { poll } = setup(options);
  expect(await poll()).toEqual(["slow"]);
  expect(await poll()).toEqual(["fast", "slow"]);
});

it("keeps manual and dry runs from consuming scheduled progress", async () => {
  const { poll, considered } = setup();
  await poll();
  await poll({ dryRun: true, bounded: false });
  await poll({ repo: "acme/fast", bounded: false });
  considered.length = 0;
  expect(await poll()).toEqual(["fast", "slow"]);
  expect(considered).toEqual([2]);
});

it("recovers when the saved next issue disappears", async () => {
  const { poll, considered, removeIssue } = setup();
  await poll();
  removeIssue(2);
  await poll();
  await poll();
  expect(considered).toEqual([1, 1, 3]);
});
