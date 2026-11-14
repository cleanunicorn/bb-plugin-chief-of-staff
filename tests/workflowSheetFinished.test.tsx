// @vitest-environment jsdom
// The workflow sheet of a finished task reads as a record: how it went, how and when it ended, and why; no timer
// counts on and nothing says work is going on. Rerunning a step says it reopens the task (#117).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import { stubReactFlowDom } from "./helpers/reactFlow";

const mocks = vi.hoisted(() => ({ entries: [] as unknown[], workflow: {} as unknown, call: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => ({ toThread: vi.fn() }),
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method }: { method: string }) => ({
    data: method === "cos_roster" ? { entries: mocks.entries } : method === "cos_item_workflow" ? mocks.workflow : method === "cos_stats" ? { doneInWindow: 0, failedInWindow: 0, medianCycleMinutes: null, daily: [] } : { paused: false, repos: [], occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 } },
    error: null, refetch: vi.fn(),
  }),
  ThreadTitle: () => null, UrlLink: () => null, Markdown: ({ content }: { content: string }) => content,
}));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("@xyflow/react/dist/style.css", () => ({}));
import { PipelineTab } from "../app";
import { entry } from "./helpers/roster";

const NOW = Date.parse("2026-11-10T10:00:00Z");
const CREATED = "2026-11-05T09:00:00.000Z";
const FINISHED = "2026-11-05T12:00:00.000Z";
const at = (iso: string) => new Date(iso).toLocaleString();

const live = (status: string) => ({ status, phase: null, reported: 0, agents: 1, waitingKind: null, retrying: false, attempts: 0, round: status === "pending" ? 0 : 1 });
const step = (startedAt: string | null, finishedAt: string | null, summary?: string) => ({ startedAt, finishedAt, feedback: null, output: null, waitingReason: null, reports: summary ? [{ agent: 0, outcome: "passed", summary, at: finishedAt! }] : [], threads: [] });
const task = (status: string, extra: Record<string, unknown>) => ({ repo: "acme/app", issueNumber: 1, issueUrl: null, body: "Fix it", status, branch: null, prNumber: null, prUrl: null, threadId: null, waitingReason: null, lastError: null, createdAt: CREATED, lastActivityAt: FINISHED, finishedAt: FINISHED, outcome: null, ...extra });
const ran = { plan: step(CREATED, "2026-11-05T09:30:00.000Z", "The plan."), build: step("2026-11-05T09:30:00.000Z", "2026-11-05T10:30:00.000Z", "Built it."), review: step("2026-11-05T10:30:00.000Z", "2026-11-05T11:00:00.000Z", "Looks good.") };

/** A failed task whose thread was archived while Ship was still running. */
const failedView = {
  title: "Fix login",
  workflow: DEFAULT_WORKFLOW,
  live: { plan: live("done"), build: live("done"), review: live("done"), ship: live("stopped") },
  task: task("failed", { lastError: "thread archived", outcome: "failed" }),
  steps: { ...ran, ship: step("2026-11-05T11:00:00.000Z", null) },
  journal: [],
};
/** A done task whose pull request was merged. */
const doneView = {
  title: "Fix login",
  workflow: DEFAULT_WORKFLOW,
  live: { plan: live("done"), build: live("done"), review: live("done"), ship: live("done") },
  task: task("done", { prNumber: 7, outcome: "merged" }),
  steps: { ...ran, ship: step("2026-11-05T11:00:00.000Z", "2026-11-05T11:20:00.000Z") },
  journal: [],
};
/** The same task while Ship runs. */
const activeView = {
  ...failedView,
  live: { ...failedView.live, ship: live("running") },
  task: task("agent", { finishedAt: null, lastActivityAt: "2026-11-10T09:00:00.000Z" }),
  steps: { ...ran, ship: step("2026-11-10T09:00:00.000Z", null) },
};

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const confirm = () => document.querySelectorAll<HTMLElement>('[role="dialog"]')[1] ?? null;
const title = () => document.getElementById(sheet().getAttribute("aria-labelledby")!)?.textContent;
const buttonIn = (scope: HTMLElement, label: string) => Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
const click = (el: HTMLElement) => act(async () => { el.click(); });
const fact = (label: string) => Array.from(sheet().querySelectorAll('[aria-label="Step details"] dt')).find((dt) => dt.textContent === label)?.nextElementSibling?.textContent ?? null;
/** Advance the sheet's clock (it ticks every 30s) by `ms`. */
const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

async function open(view: unknown, card: Record<string, unknown>) {
  mocks.workflow = view;
  mocks.entries = [entry(card)];
  await act(async () => { root.render(<PipelineTab />); });
  await click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Workflow")!);
}
async function selectShip() {
  await click(buttonIn(sheet(), "List"));
  await click(Array.from(sheet().querySelectorAll<HTMLElement>('ol[aria-label="Workflow steps"] button')).find((b) => b.textContent?.includes("Ship"))!);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubReactFlowDom();
  mocks.call.mockReset().mockResolvedValue({});
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const finishedCard = (detail: string, outcome: string, extra: Record<string, unknown> = {}) => ({ detail, status: detail, actor: "none", occupiesCapacity: false, current: [], outcome, finishedAt: FINISHED, startedAt: CREATED, ...extra });

describe("a failed task with a step it stopped in", () => {
  beforeEach(() => open(failedView, finishedCard("failed", "failed", { lastError: "thread archived" })));

  it("is titled as a record and says why and when it ended", () => {
    expect(title()).toBe("How this task went");
    const text = sheet().textContent!;
    expect(text).toContain(`Failed · ended ${at(FINISHED)}`);
    expect(text).toContain("Why it ended: thread archived");
    expect(text).toContain(`finished ${at(FINISHED)}`);
    expect(text).toContain("Took3.0h");
    expect(text).toContain("Select a step to reopen this task and run it (and everything after it) again.");
    expect(text).not.toMatch(/Where this task is|Working on it|Running for|\byet\b/);
  });

  it("stops the stopped step's timer at the task's end, and keeps it there", async () => {
    await selectShip();
    expect(fact("Ran for")).toBe("1.0h before the task ended");
    const text = sheet().textContent!;
    expect(text).toContain("Did not finish.");
    expect(text).toContain("No runs recorded for this step.");
    expect(text).not.toMatch(/Where this task is|Working on it|Running for|\byet\b/);
    await wait(2 * 60 * 60_000);
    expect(fact("Ran for")).toBe("1.0h before the task ended");
    expect(sheet().textContent).toContain("Took3.0h");
  });

  it("says rerunning a step reopens the task", async () => {
    await selectShip();
    await click(buttonIn(sheet(), "Run again from here"));
    expect(confirm()!.textContent).toContain("This resets Ship and runs it again. This reopens the finished task, and agents start working on it again.");
    await click(buttonIn(confirm()!, "Reopen and run again"));
    expect(mocks.call).toHaveBeenCalledWith("cos_item_action", { id: "one", action: "rerun_step", step: "ship" });
  });
});

describe("a done task", () => {
  beforeEach(() => open(doneView, finishedCard("done", "merged", { prNumber: 7 })));

  it("is titled as a record and says how it ended", () => {
    expect(title()).toBe("How this task went");
    const text = sheet().textContent!;
    expect(text).toContain(`Merged · ended ${at(FINISHED)}`);
    expect(text).not.toContain("Why it ended");
    expect(text).not.toMatch(/Where this task is|Working on it|Running for|\byet\b/);
  });

  it("keeps the time each step took, and says rerunning reopens the task", async () => {
    await selectShip();
    expect(fact("Took")).toBe("20m");
    expect(sheet().textContent).not.toMatch(/Working on it|Running for|\byet\b/);
    await click(buttonIn(sheet(), "Run again from here"));
    expect(confirm()!.textContent).toContain("This reopens the finished task");
    expect(buttonIn(confirm()!, "Reopen and run again")).toBeDefined();
  });
});

describe("an active task", () => {
  beforeEach(() => open(activeView, {}));

  it("keeps saying where the task is, and counts on", async () => {
    expect(title()).toBe("Where this task is");
    expect(sheet().textContent).toContain("Select a step to run it (and everything after it) again.");
    await selectShip();
    expect(fact("Running for")).toBe("1.0h");
    expect(sheet().textContent).toContain("Working on it.");
    await wait(60 * 60_000);
    expect(fact("Running for")).toBe("2.0h");
  });

  it("does not say rerunning reopens it", async () => {
    await selectShip();
    await click(buttonIn(sheet(), "Run again from here"));
    expect(confirm()!.textContent).toContain("This resets Ship and runs it again.");
    expect(confirm()!.textContent).not.toContain("reopens");
    expect(buttonIn(confirm()!, "Run again")).toBeDefined();
  });
});

describe("before the sheet's data loads", () => {
  it("titles a finished task from its card", async () => {
    await open(undefined, finishedCard("failed", "failed", { lastError: "thread archived" }));
    expect(title()).toBe("How this task went");
  });

  it("titles an active task from its card", async () => {
    await open(undefined, {});
    expect(title()).toBe("Where this task is");
  });
});
