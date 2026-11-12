// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/state";
import type { RosterEntry } from "../src/roster";
import { entry } from "./helpers/roster";

const mocks = vi.hoisted(() => ({ entries: [] as RosterEntry[], logs: [] as LogEntry[], paused: false, failing: {} as Record<string, string>, call: vi.fn(), navigate: { toThread: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method }: { method: string }) => {
    const failure = mocks.failing[method];
    // Like the SDK, a failed first load has an error and no data.
    if (failure) return { data: undefined, error: new Error(failure), isLoading: false, isFetching: false, refetch: vi.fn() };
    return {
      data: method === "cos_log" ? { entries: mocks.logs } : method === "cos_roster" ? { entries: mocks.entries } : method === "cos_stats" ? { doneInWindow: 13, failedInWindow: 13, medianCycleMinutes: null, daily: [] } : { paused: mocks.paused, repos: [], occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 }, errors: [], warnings: [] },
      error: null, refetch: vi.fn(),
    };
  },
  ThreadTitle: () => null, UrlLink: () => null,
}));
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} aria-hidden="true" /> }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({ ...(await original<typeof import("../components/cos/workflowCanvas")>()), WorkflowCanvas: () => null }));
import { PipelineTab, ReposTab, ActivityFeed } from "../app";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
async function mount(content: ReactNode = <PipelineTab />) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(content); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); container.remove(); mocks.paused = false; mocks.failing = {}; mocks.call.mockReset(); vi.unstubAllGlobals(); });

it("prioritizes active tasks over historical outcomes and keeps failure history out of attention", async () => {
  mocks.entries = [entry()];
  await mount();
  const text = container.textContent!;
  expect(text.indexOf("Fix login")).toBeLessThan(text.indexOf("Throughput"));
  expect(text).toContain("13 historical failed runs");
  expect(container.querySelector('[aria-label="Needs attention"]')).toBeNull();
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});

it("drills into failure decisions and clears the filter", async () => {
  mocks.entries = [entry(), entry({ id: "two", issueTitle: "Repair deploy", detail: "waiting_on_human", status: "waiting on human", waitingKind: "cos_error" })];
  await mount();
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes("needing a decision"))!;
  await act(async () => button.click());
  expect(container.textContent).toContain("Repair deploy");
  expect(container.textContent).not.toContain("Fix login");
  await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === "Clear filter")!.click());
  expect(container.textContent).toContain("Fix login");
});

it("leads with the title, omits missing usage, and opens the task thread", async () => {
  mocks.entries = [entry()];
  await mount();
  const card = container.querySelector("article")!;
  expect(card.textContent!.indexOf("Fix login")).toBeLessThan(card.textContent!.indexOf("Build"));
  expect(card.textContent).not.toContain("agent working");
  expect(card.textContent).not.toContain("Tokens");
  expect(card.textContent).not.toContain("Cost");
  const open = Array.from(card.querySelectorAll('button')).find(b => b.textContent?.trim() === "Open thread")!;
  await act(async () => open.click());
  expect(mocks.navigate.toThread).toHaveBeenCalledWith("thread-1");
});

it("shows real zero usage and keeps task actions available without a thread", async () => {
  mocks.entries = [entry({ threadId: null, usage: { inputTokens: null, outputTokens: null, totalTokens: 0, cost: { amount: 0, currency: "USD" } } })];
  await mount();
  const card = container.querySelector("article")!;
  expect(card.textContent).toContain("Tokens0");
  expect(card.textContent).toContain("Cost0.00 USD");
  expect(card.textContent).not.toContain("Open thread");
  expect(card.textContent).toContain("Workflow");
});


it("shows compact activity rows with full messages and preserves problem filtering", async () => {
  mocks.logs = [
    { id: 1, at: new Date().toISOString(), level: "info", kind: "spawn", message: "spawned Review thr_abc", actor: "event", repo: "acme/app", workItemId: "one" },
    { id: 2, at: new Date().toISOString(), level: "error", kind: "check", message: "Build failed (exit 1)", actor: "job", repo: "acme/app", workItemId: "two" },
  ];
  await mount(<ActivityFeed />);
  const row = container.querySelector("li")!;
  expect(row.textContent).toContain("spawn");
  expect(row.textContent).toContain("app spawned Review thr_abc");
  expect(row.textContent).toContain("· event");
  expect(row.querySelector('[title]')).not.toBeNull();
  expect(container.querySelector("details")).toBeNull();
  await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "Problems only")!.click());
  expect(container.textContent).not.toContain("spawned Review thr_abc");
  expect(container.textContent).toContain("Build failed (exit 1)");
});


it("pairs task state pictograms with explicit labels", async () => {
  mocks.entries = [entry({ detail: "waiting_on_human", status: "waiting on human", waitingKind: "cos_error", current: ["Build"] })];
  await mount();
  const card = container.querySelector("article")!;
  expect(card.querySelector('header [data-icon="OctagonAlert"]')).not.toBeNull();
  expect(card.textContent).toContain("CoS stuck");
});


it("preserves global pause and resume alongside the redesigned task overview", async () => {
  mocks.entries = [entry()];
  mocks.call.mockResolvedValue({});
  await mount();
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === label)!;
  expect(container.textContent).toContain("Work overview");
  expect(container.textContent).toContain("Fix login");
  await act(async () => button("Pause everything").click());
  expect(mocks.call).toHaveBeenLastCalledWith("cos_set_paused", { paused: true });
  mocks.paused = true;
  await act(async () => { root.render(<PipelineTab />); });
  expect(container.textContent).toContain("Chief of Staff is paused");
  await act(async () => button("Resume everything").click());
  expect(mocks.call).toHaveBeenLastCalledWith("cos_set_paused", { paused: false });
});


const buttonLabelled = (label: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === label)!;

it("shows the overview error on the Pipeline tab, with Pause everything still disabled", async () => {
  mocks.entries = [entry()];
  mocks.failing = { cos_overview: "overview unavailable" };
  await mount();
  expect(container.textContent).toContain("overview unavailable");
  expect(buttonLabelled("Pause everything").disabled).toBe(true);
});

it("shows the roster error on the Repos & PRs tab instead of an empty pull request list", async () => {
  mocks.failing = { cos_roster: "roster unavailable" };
  await mount(<ReposTab />);
  expect(container.textContent).toContain("roster unavailable");
  expect(container.textContent).not.toContain("No pull requests yet");
});

it("does not call a failed roster an empty pipeline", async () => {
  mocks.failing = { cos_roster: "roster unavailable" };
  await mount();
  expect(container.textContent).toContain("roster unavailable");
  expect(container.textContent).not.toContain("No active tasks");
});

it("shows every failing query once, even when they share a message", async () => {
  mocks.entries = [entry()];
  mocks.failing = { cos_roster: "roster unavailable", cos_stats: "stats unavailable", cos_overview: "overview unavailable" };
  await mount();
  for (const m of ["roster unavailable", "stats unavailable", "overview unavailable"]) expect(container.textContent).toContain(m);
  await act(async () => { root.render(<ReposTab />); });
  mocks.failing = { cos_roster: "backend down", cos_overview: "backend down" };
  await act(async () => { root.render(<ReposTab key="again" />); });
  expect(container.textContent!.split("backend down")).toHaveLength(2);
});

it("still shows the empty pull request state when nothing failed", async () => {
  mocks.entries = [];
  await mount(<ReposTab />);
  expect(container.textContent).toContain("No pull requests yet");
});
