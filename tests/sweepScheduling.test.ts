import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sweep } from "../src/sweep";
import type { Cos } from "../src/context";

const mocks = vi.hoisted(() => ({ intake: vi.fn(), ci: vi.fn(), sync: vi.fn(), pr: vi.fn() }));
vi.mock("../src/intake", () => ({ runIntake: mocks.intake }));
vi.mock("../src/delivery", () => ({ watchCi: mocks.ci }));
vi.mock("../src/prState", () => ({ refreshPrStates: mocks.pr }));
vi.mock("../src/roster", () => ({ detectStalls: async () => {} }));
vi.mock("../src/sync", () => ({ syncThreads: mocks.sync, tickItems: async () => {} }));
vi.mock("../src/threadGroups", () => ({ groupExistingThreads: async () => {} }));
vi.mock("../src/retention", () => ({ maybeRunRetention: async () => {} }));

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  vi.resetAllMocks();
});

function setup(options: { intake?: number; ci?: number; pr?: number; failIntake?: boolean; limitIntake?: boolean } = {}) {
  const host = createFakePluginHost({ pluginId: "test" });
  hosts.push(host);
  let now = 0;
  let limited = false;
  let paused = false;
  const calls: string[] = [];
  mocks.sync.mockResolvedValue(undefined);
  mocks.intake.mockImplementation(async () => {
    calls.push("intake");
    now += options.intake ?? 125_000;
    if (options.limitIntake) limited = true;
    if (options.failIntake) throw new Error("intake failed");
  });
  mocks.ci.mockImplementation(async () => { calls.push("ci"); now += options.ci ?? 125_000; });
  mocks.pr.mockImplementation(async () => { calls.push("pr"); now += options.pr ?? 1000; });
  const context = () => ({
    bb: host.bb, now: () => new Date(now), store: { isPaused: () => paused },
    config: async () => ({ repos: [{}], values: { intakeIntervalMinutes: 1 } }),
    githubLimit: () => limited ? { until: new Date(now + 60_000), reason: "limited" } : null,
    invalidate: () => {},
  }) as unknown as Cos;
  return {
    host,
    async pass() {
      calls.length = 0;
      await sweep(context());
      now += 60_000;
      return [...calls];
    },
    clearLimit() { limited = false; },
    setLimited() { limited = true; },
    pause(value: boolean) { paused = value; },
  };
}

it("gives both overdue phases turns across budget-limited sweeps and reloads", async () => {
  const { pass } = setup();
  expect(await pass()).toEqual(["intake"]);
  expect(await pass()).toEqual(["ci"]);
  expect(await pass()).toEqual(["intake"]);
  expect(await pass()).toEqual(["ci"]);
  expect(mocks.sync).toHaveBeenCalledTimes(4);
});

it("runs both phases in one sweep when the budget permits", async () => {
  const { pass } = setup({ intake: 1000, ci: 1000 });
  expect(await pass()).toEqual(["intake", "ci", "pr"]);
  // Intake is due again after a minute, CI is not.
  expect(await pass()).toEqual(["intake", "pr"]);
  expect(await pass()).toEqual(["ci", "intake", "pr"]);
});

it("lets CI run next even when intake failed after consuming its budget", async () => {
  const { pass } = setup({ failIntake: true });
  expect(await pass()).toEqual(["intake"]);
  expect(await pass()).toEqual(["ci"]);
});

it("keeps the waiting phase unstamped during a rate limit and resumes it after reset", async () => {
  const { pass, host, clearLimit } = setup({ limitIntake: true });
  expect(await pass()).toEqual(["intake"]);
  expect(await pass()).toEqual([]);
  expect(await host.bb.storage.kv.get("sweep:lastCiAt")).toBeUndefined();
  clearLimit();
  expect(await pass()).toEqual(["ci"]);
  expect(mocks.sync).toHaveBeenCalledTimes(3);
});

it("refreshes PR state every sweep, after the intake and CI phases", async () => {
  const { pass } = setup({ intake: 1000, ci: 1000 });
  expect(await pass()).toEqual(["intake", "ci", "pr"]);
  expect(await pass()).toEqual(["intake", "pr"]);
  expect(mocks.pr).toHaveBeenLastCalledWith(expect.anything(), "schedule:pr-state", { deadline: expect.any(Number) });
});

it("gives the PR state refresh only the budget intake and CI leave", async () => {
  const { pass } = setup();
  // Intake used the whole budget: no PR state this sweep.
  expect(await pass()).toEqual(["intake"]);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("skips the PR state refresh during a rate limit or a pause", async () => {
  const { pass, setLimited, clearLimit, pause } = setup({ intake: 1000, ci: 1000 });
  setLimited();
  expect(await pass()).toEqual([]);
  clearLimit();
  // Paused while the last GitHub phase ran.
  mocks.ci.mockImplementationOnce(async () => { pause(true); });
  expect(await pass()).toEqual(["intake"]);
  pause(false);
  expect(await pass()).toEqual(["intake", "pr"]);
});
