// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/state";
import type { RosterEntry } from "../src/roster";

const mocks = vi.hoisted(() => ({ entries: [] as RosterEntry[], logs: [] as LogEntry[], navigate: { toThread: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: vi.fn() }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method }: { method: string }) => ({
    data: method === "cos_log" ? { entries: mocks.logs } : method === "cos_roster" ? { entries: mocks.entries } : method === "cos_stats" ? { doneInWindow: 13, failedInWindow: 13, medianCycleMinutes: null, daily: [] } : { repos: [], occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 } },
    error: null, refetch: vi.fn(),
  }),
  ThreadTitle: () => null, UrlLink: () => null,
}));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("../components/cos/workflowCanvas", () => ({ WorkflowCanvas: () => null }));
import { PipelineTab, ActivityFeed } from "../app";

export function entry(extra: Partial<RosterEntry> = {}): RosterEntry {
  return { id: "one", detail: "agent", status: "running", actor: "agent", occupiesCapacity: true, workflowName: "Delivery", steps: [], current: ["Build"], activity: "Build: agent working", waitingKind: null, repo: "acme/app", issueNumber: 1, issueTitle: "Fix login", threadId: "thread-1", threadStatus: "working", threadTitle: "Build", branch: null, prNumber: null, prUrl: null, startedAt: new Date().toISOString(), lastActivityAt: null, stalled: false, fixAttempts: 0, retryCount: 0, lastError: null, waitingReason: null, providerId: null, model: null, source: "task", usage: null, ...extra };
}
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
async function mount(content: ReactNode = <PipelineTab />) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(content); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

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


it("shows readable activity with expandable diagnostics and preserves problem filtering", async () => {
  mocks.logs = [
    { id: 1, at: new Date().toISOString(), level: "info", kind: "spawn", message: "spawned Review thr_abc", actor: "event", repo: "acme/app", workItemId: "one" },
    { id: 2, at: new Date().toISOString(), level: "error", kind: "check", message: "Build failed (exit 1)", actor: "job", repo: "acme/app", workItemId: "two" },
  ];
  await mount(<ActivityFeed />);
  expect(container.querySelector("li p")?.textContent).toBe("Started Review agent");
  const details = container.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("spawned Review thr_abc");
  expect(container.textContent).toContain("View task");
  await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "Problems only")!.click());
  expect(container.textContent).not.toContain("Started Review agent");
  expect(container.textContent).toContain("Build failed (exit 1)");
});
