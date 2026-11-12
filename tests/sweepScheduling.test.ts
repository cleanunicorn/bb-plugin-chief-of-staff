import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sweep } from "../src/sweep";
import type { Cos } from "../src/context";

const mocks = vi.hoisted(() => ({ intake: vi.fn(), ci: vi.fn(), sync: vi.fn() }));
vi.mock("../src/intake", () => ({ runIntake: mocks.intake }));
vi.mock("../src/delivery", () => ({ watchCi: mocks.ci }));
vi.mock("../src/roster", () => ({ detectStalls: async () => {} }));
vi.mock("../src/sync", () => ({ syncThreads: mocks.sync, tickItems: async () => {} }));
vi.mock("../src/threadGroups", () => ({ groupExistingThreads: async () => {} }));
vi.mock("../src/retention", () => ({ maybeRunRetention: async () => {} }));

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  vi.resetAllMocks();
});

function setup(options: { intake?: number; ci?: number; failIntake?: boolean; limitIntake?: boolean } = {}) {
  const host = createFakePluginHost({ pluginId: "test" });
  hosts.push(host);
  let now = 0;
  let limited = false;
  const calls: string[] = [];
  mocks.sync.mockResolvedValue(undefined);
  mocks.intake.mockImplementation(async () => {
    calls.push("intake");
    now += options.intake ?? 125_000;
    if (options.limitIntake) limited = true;
    if (options.failIntake) throw new Error("intake failed");
  });
  mocks.ci.mockImplementation(async () => { calls.push("ci"); now += options.ci ?? 125_000; });
  const context = () => ({
    bb: host.bb, now: () => new Date(now), store: { isPaused: () => false },
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
  expect(await pass()).toEqual(["intake", "ci"]);
  // Intake is due again after a minute, CI is not.
  expect(await pass()).toEqual(["intake"]);
  expect(await pass()).toEqual(["ci", "intake"]);
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
