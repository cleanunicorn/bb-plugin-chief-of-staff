// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LogRow } from "../src/state";
import type { RosterEntry } from "../src/roster";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import { entry } from "./helpers/roster";
import { clickOutside, tick } from "./dom";

const mocks = vi.hoisted(() => ({ entries: [] as RosterEntry[], logs: [] as LogRow[], repos: [] as { key: string }[], paused: false, failing: {} as Record<string, string>, queries: [] as { method: string; input: unknown }[], call: vi.fn(), navigate: { toThread: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method, input }: { method: string; input: unknown }) => {
    mocks.queries.push({ method, input });
    const failure = mocks.failing[method];
    // Like the SDK, a failed first load has an error and no data.
    if (failure) return { data: undefined, error: new Error(failure), isLoading: false, isFetching: false, refetch: vi.fn() };
    const workItemId = (input as { workItemId?: string } | null)?.workItemId;
    return {
      data: method === "cos_log" ? { entries: mocks.logs.filter((e) => !workItemId || e.workItemId === workItemId) }
        : method === "cos_roster" ? { entries: mocks.entries }
        : method === "cos_stats" ? { doneInWindow: 13, failedInWindow: 13, medianCycleMinutes: null, daily: [] }
        : method === "cos_item_workflow" ? { title: "Fix login", workflow: DEFAULT_WORKFLOW, live: {}, journal: [] }
        : { paused: mocks.paused, repos: mocks.repos, occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 }, errors: [], warnings: [] },
      error: null, refetch: vi.fn(),
    };
  },
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
  ThreadTitle: () => null, UrlLink: () => null,
}));
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} aria-hidden="true" /> }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({ ...(await original<typeof import("../components/cos/workflowCanvas")>()), WorkflowCanvas: () => null }));
import { PipelineTab, ReposTab, ActivityFeed, Dashboard } from "../app";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
async function mount(content: ReactNode = <PipelineTab />) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(content); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); container.remove(); document.body.replaceChildren(); document.body.removeAttribute("style"); mocks.paused = false; mocks.failing = {}; mocks.repos = []; mocks.logs = []; mocks.queries = []; mocks.call.mockReset(); mocks.navigate.toThread.mockReset(); vi.unstubAllGlobals(); });

/** An activity row of task "one", #7 Fix login, in acme/app. */
const logRow = (over: Partial<LogRow> = {}): LogRow => ({ id: 1, at: new Date().toISOString(), level: "info", kind: "spawn", message: "spawned Review thr_abc", actor: "event", repo: "acme/app", workItemId: "one", issueNumber: 7, issueTitle: "Fix login", ...over });

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

it("names the workflow summary as a spaced sentence for screen readers", async () => {
  const step = (id: string, depth: number, status: "done" | "running" | "pending") => ({ id, name: id, depth, status, type: "agent" as const, phase: null, agents: 1, reported: 0, nudged: 0, attempts: 0, round: 1, waitingKind: null, retrying: false });
  mocks.entries = [entry({ steps: [step("Plan", 0, "done"), step("Build", 1, "running"), step("Ship", 2, "pending")] })];
  await mount();
  const summary = container.querySelector("article details > summary")!;
  expect(summary.textContent!.replace(/\s+/g, " ").trim()).toBe("Workflow progress: 1/3 steps complete");
});

it("shows compact activity rows with full messages and preserves problem filtering", async () => {
  mocks.logs = [
    logRow(),
    logRow({ id: 2, level: "error", kind: "check", message: "Build failed (exit 1)", actor: "job", workItemId: "two", issueNumber: 8, issueTitle: "Repair deploy" }),
  ];
  await mount(<ActivityFeed />);
  const row = container.querySelector("li")!;
  expect(row.textContent).toContain("spawn");
  expect(row.textContent).toContain("app #7 Fix login spawned Review thr_abc");
  expect(row.textContent).toContain("· event");
  expect(row.querySelector("time[title]")).not.toBeNull();
  expect(row.querySelector('[data-icon="Info"]')).not.toBeNull();
  expect(container.querySelector("details")).toBeNull();
  await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === "Problems only")!.click());
  expect(container.textContent).not.toContain("spawned Review thr_abc");
  expect(container.textContent).toContain("Build failed (exit 1)");
});

const taskButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("li button[aria-label^='Open task']"));

it("names each row's task: number and title, a standalone title, or nothing without a task", async () => {
  mocks.logs = [
    logRow(),
    logRow({ id: 2, workItemId: "two", issueNumber: null, issueTitle: "Tidy the docs" }),
    logRow({ id: 3, workItemId: "three", issueNumber: 9, issueTitle: "" }),
    logRow({ id: 4, workItemId: "four", issueNumber: null, issueTitle: "" }),
    logRow({ id: 5, kind: "control", workItemId: null, issueNumber: null, issueTitle: null, repo: null, message: "paused", actor: "rpc:client" }),
    logRow({ id: 6, workItemId: "gone", issueNumber: null, issueTitle: null }),
  ];
  await mount(<ActivityFeed />);
  expect(taskButtons().map((b) => [b.textContent, b.getAttribute("aria-label"), b.title])).toEqual([
    ["#7 Fix login", "Open task #7 Fix login", "#7 Fix login"],
    ["Tidy the docs", "Open task Tidy the docs", "Tidy the docs"],
    ["#9", "Open task #9", "#9"],
    ["Untitled task", "Open task Untitled task", "Untitled task"],
  ]);
  const rows = container.querySelectorAll("li");
  expect(rows[4]!.querySelector("button[aria-label^='Open task']")).toBeNull();
  expect(rows[5]!.querySelector("button[aria-label^='Open task']")).toBeNull();
});

it("opens the task's workflow from its name, and returns focus to the name on close", async () => {
  mocks.logs = [logRow(), logRow({ id: 2, workItemId: "two", issueNumber: 8, issueTitle: "Repair deploy" })];
  await mount(<ActivityFeed />);
  const name = taskButtons()[1]!;
  await act(async () => { name.focus(); name.click(); });
  await tick();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Where this task is");
  expect(mocks.queries).toContainEqual({ method: "cos_item_workflow", input: { id: "two" } });
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')!.click());
  await tick(5);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(taskButtons()[1]);
});

it("links every thread id in a row's message and actor, and keeps the text as it was", async () => {
  mocks.logs = [logRow({ kind: "archive", message: "archived 2 threads: thr_a, thr_b", actor: "tool:thr_x" })];
  await mount(<ActivityFeed />);
  const row = container.querySelector("li")!;
  expect(row.textContent).toContain("archived 2 threads: thr_a, thr_b · tool:thr_x");
  const links = Array.from(row.querySelectorAll<HTMLButtonElement>("button[aria-label^='Open thread']"));
  expect(links.map((b) => [b.textContent, b.getAttribute("aria-label")])).toEqual([
    ["thr_a", "Open thread thr_a"],
    ["thr_b", "Open thread thr_b"],
    ["thr_x", "Open thread thr_x"],
  ]);
  await act(async () => links[1]!.click());
  expect(mocks.navigate.toThread).toHaveBeenLastCalledWith("thr_b");
  await act(async () => links[2]!.click());
  expect(mocks.navigate.toThread).toHaveBeenLastCalledWith("thr_x");
  expect(mocks.navigate.toThread).toHaveBeenCalledTimes(2);
});

it("names the repository on each row only when more than one is configured", async () => {
  mocks.logs = [logRow()];
  mocks.repos = [{ key: "acme/app" }];
  await mount(<ActivityFeed />);
  expect(container.querySelector("li")!.textContent).toMatch(/^spawn.*#7 Fix login spawned Review thr_abc · event/);
  expect(container.querySelector("li")!.textContent).not.toContain("app #7");
  mocks.repos = [{ key: "acme/app" }, { key: "acme/web" }];
  await act(async () => { root.render(<ActivityFeed key="two" />); });
  expect(container.querySelector("li")!.textContent).toContain("app #7 Fix login spawned Review thr_abc");
  // Unknown repositories keep the name: nothing is hidden on a guess.
  mocks.repos = [{ key: "acme/app" }];
  mocks.failing = { cos_overview: "overview unavailable" };
  await act(async () => { root.render(<ActivityFeed key="failed" />); });
  expect(container.querySelector("li")!.textContent).toContain("app #7 Fix login spawned Review thr_abc");
  expect(container.textContent).not.toContain("overview unavailable");
});

// ---------- Narrowing the feed to one task ----------

const logQueries = () => mocks.queries.filter((q) => q.method === "cos_log").map((q) => q.input);
const activityPanel = () => Array.from(container.querySelectorAll("h2")).find((h) => h.textContent === "Activity")!.closest("section")!;
const rowMessages = () => Array.from(activityPanel().querySelectorAll("ol > li")).map((li) => li.textContent);
const taskLogs = () => [
  logRow({ id: 1, message: "spawned Review thr_abc" }),
  logRow({ id: 2, workItemId: "two", issueNumber: 8, issueTitle: "Repair deploy", message: "Review agent 1 reported done" }),
  logRow({ id: 3, workItemId: "two", issueNumber: 8, issueTitle: "Repair deploy", level: "error", kind: "check", message: "Build failed (exit 1)" }),
  logRow({ id: 4, kind: "control", workItemId: null, issueNumber: null, issueTitle: null, repo: null, message: "paused", actor: "rpc:client" }),
];
/** Radix menus open on pointerdown or the keyboard, not on click. */
const openMenuOn = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await tick();
};
const taskMenu = () => Array.from(activityPanel().querySelectorAll<HTMLButtonElement>("button[aria-haspopup='menu']")).find((b) => b.textContent?.startsWith("Task"));
const menuItemsNow = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));

it("narrows the feed to a task picked in it, and clears back to all activity", async () => {
  mocks.logs = taskLogs();
  await mount(<ActivityFeed />);
  expect(logQueries().at(-1)).toEqual({ limit: 60 });
  await openMenuOn(taskMenu()!);
  expect(menuItemsNow().map((el) => el.textContent?.trim())).toEqual(["#7 Fix login", "#8 Repair deploy"]);
  await act(async () => menuItemsNow()[1]!.click());
  await tick();
  expect(logQueries().at(-1)).toEqual({ limit: 60, workItemId: "two" });
  expect(rowMessages()).toHaveLength(2);
  for (const text of rowMessages()) expect(text).toContain("#8 Repair deploy");
  expect(taskMenu()!.textContent).toBe("Task:\u00a0#8 Repair deploy");
  expect(document.activeElement).toBe(taskMenu());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show all activity"]')!.click());
  expect(logQueries().at(-1)).toEqual({ limit: 60 });
  expect(rowMessages()).toHaveLength(4);
  expect(taskMenu()!.textContent).toBe("Task");
  expect(document.activeElement).toBe(taskMenu());
  // The tasks seen before filtering are still offered.
  await openMenuOn(taskMenu()!);
  expect(menuItemsNow().map((el) => el.textContent?.trim())).toEqual(["#7 Fix login", "#8 Repair deploy"]);
});

it("combines the task filter with Problems only, and says when a task has nothing to show", async () => {
  mocks.logs = taskLogs();
  await mount(<ActivityFeed task={{ id: "two", label: "#8 Repair deploy" }} onTaskChange={() => {}} />);
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Problems only")!.click());
  expect(rowMessages()).toHaveLength(1);
  expect(rowMessages()[0]).toContain("Build failed (exit 1)");
  await act(async () => { root.render(<ActivityFeed task={{ id: "three", label: "#9 Quiet" }} onTaskChange={() => {}} />); });
  expect(taskMenu()!.textContent).toBe("Task:\u00a0#9 Quiet");
  expect(container.textContent).toContain("No warnings or errors.");
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Problems only")!.click());
  expect(container.textContent).toContain("No activity for this task.");
});

it("shows a task's activity from its card, finished or not, and moves focus to the Activity heading", async () => {
  mocks.entries = [entry(), entry({ id: "old", detail: "done", status: "done", issueNumber: 3, issueTitle: "Old work" })];
  mocks.logs = [...taskLogs(), logRow({ id: 5, workItemId: "old", issueNumber: 3, issueTitle: "Old work", message: "marked done" })];
  await mount(<Dashboard subPath="agents" />);
  const [active, done] = Array.from(container.querySelectorAll("article"));
  await openMenuOn(active!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!);
  expect(menuItemsNow().map((el) => el.textContent?.trim())).toEqual(["Show activity", "Retry the stuck step", "Mark done…", "Mark failed…"]);
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await tick();
  await openMenuOn(done!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!);
  expect(menuItemsNow().map((el) => el.textContent?.trim())).toEqual(["Show activity"]);
  await act(async () => menuItemsNow()[0]!.click());
  await tick(5);
  expect(logQueries().at(-1)).toEqual({ limit: 60, workItemId: "old" });
  expect(rowMessages()).toEqual([expect.stringContaining("marked done")]);
  expect(taskMenu()!.textContent).toBe("Task:\u00a0#3 Old work");
  expect(document.activeElement?.tagName).toBe("H2");
  expect(document.activeElement?.textContent).toBe("Activity");
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

// ---------- More actions menu and confirmations ----------

const menuItems = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const menuItem = (label: string) => menuItems().find((el) => el.textContent?.trim().startsWith(label))!;
const confirmDialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const bodyButton = (label: string) => Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
const keydown = (target: Element, key: string) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const moreActions = () => container.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
/** Radix menus open on pointerdown or the keyboard, not on click. */
const openMenu = async () => {
  moreActions().focus();
  await keydown(moreActions(), "Enter");
  await tick();
};
const actionCalls = () => mocks.call.mock.calls.filter(([method]) => method === "cos_item_action");

it("opens More actions from the keyboard, moves through it with arrows, and closes on Escape", async () => {
  mocks.entries = [entry()];
  await mount();
  await openMenu();
  expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  expect(menuItems().map((el) => el.textContent?.trim())).toEqual(["Retry the stuck step", "Mark done…", "Mark failed…"]);
  expect(document.activeElement).toBe(menuItems()[0]);
  await keydown(document.activeElement!, "ArrowDown");
  await tick();
  expect(document.activeElement).toBe(menuItems()[1]);
  await keydown(document.activeElement!, "Escape");
  await tick();
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(moreActions());
});

it("closes More actions on a click outside", async () => {
  mocks.entries = [entry()];
  await mount();
  await openMenu();
  await clickOutside(container.querySelector("h2")!);
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
});

it("asks before marking a task done, and sends it once on confirm", async () => {
  mocks.entries = [entry()];
  mocks.call.mockResolvedValue({});
  await mount();
  await openMenu();
  await act(async () => menuItem("Mark done").click());
  await tick();
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  expect(actionCalls()).toHaveLength(0);
  expect(confirmDialog()?.textContent).toContain("Mark ‘Fix login’ done?");
  expect(confirmDialog()!.contains(document.activeElement)).toBe(true);
  await act(async () => bodyButton("Mark done").click());
  await tick(5);
  expect(actionCalls()).toEqual([["cos_item_action", { id: "one", action: "mark_done" }]]);
  expect(confirmDialog()).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(document.activeElement).toBe(moreActions());
});

it("sends nothing when marking failed is cancelled", async () => {
  mocks.entries = [entry()];
  await mount();
  await openMenu();
  await act(async () => menuItem("Mark failed").click());
  await tick();
  expect(confirmDialog()?.textContent).toContain("Mark ‘Fix login’ failed?");
  await act(async () => bodyButton("Cancel").click());
  await tick(5);
  expect(confirmDialog()).toBeNull();
  expect(mocks.call).not.toHaveBeenCalled();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(document.activeElement).toBe(moreActions());
});

it("retries the stuck step from the menu at once, without asking", async () => {
  mocks.entries = [entry()];
  mocks.call.mockResolvedValue({});
  await mount();
  await openMenu();
  await act(async () => menuItem("Retry the stuck step").click());
  await tick();
  expect(confirmDialog()).toBeNull();
  expect(actionCalls()).toEqual([["cos_item_action", { id: "one", action: "retry" }]]);
});

it("keeps Approve and Resume on the card to one click", async () => {
  mocks.entries = [
    entry({ detail: "waiting_on_human", status: "waiting on human", waitingKind: "approval", waitingReason: "Review the plan" }),
    entry({ id: "two", issueTitle: "Repair deploy", detail: "waiting_on_human", status: "waiting on human", waitingKind: "stalled" }),
  ];
  mocks.call.mockResolvedValue({});
  await mount();
  const [first, second] = Array.from(container.querySelectorAll("article"));
  await act(async () => Array.from(first!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Approve")!.click());
  await act(async () => Array.from(second!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Resume")!.click());
  expect(confirmDialog()).toBeNull();
  expect(actionCalls()).toEqual([
    ["cos_item_action", { id: "one", action: "approve" }],
    ["cos_item_action", { id: "two", action: "retry" }],
  ]);
});

it("keeps a task's buttons disabled while its own action runs, whatever finishes first", async () => {
  mocks.entries = [
    entry({ detail: "waiting_on_human", status: "waiting on human", waitingKind: "approval", waitingReason: "Review the plan" }),
    entry({ id: "two", issueTitle: "Repair deploy", detail: "waiting_on_human", status: "waiting on human", waitingKind: "approval", waitingReason: "Review the plan" }),
  ];
  const pending = new Map<string, () => void>();
  mocks.call.mockImplementation((_method: string, input: { id: string }) => new Promise<void>((resolve) => pending.set(input.id, resolve)));
  await mount();
  const approve = (index: number) => Array.from(container.querySelectorAll("article")[index]!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Approve")!;
  const more = (index: number) => container.querySelectorAll("article")[index]!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
  await act(async () => approve(0).click());
  await act(async () => approve(1).click());
  expect([approve(0).disabled, approve(1).disabled]).toEqual([true, true]);

  await act(async () => pending.get("one")!());
  expect([approve(0).disabled, more(0).disabled]).toEqual([false, false]);
  expect([approve(1).disabled, more(1).disabled]).toEqual([true, true]);

  await act(async () => pending.get("two")!());
  expect([approve(1).disabled, more(1).disabled]).toEqual([false, false]);
});

it("does not pull focus back to More actions if it moved on while the action ran", async () => {
  mocks.entries = [entry()];
  let finish!: () => void;
  mocks.call.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await mount();
  await openMenu();
  await act(async () => menuItem("Mark failed").click());
  await tick();
  await act(async () => bodyButton("Mark failed").click());
  await tick(5);
  const elsewhere = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "New task")!;
  elsewhere.focus();
  await act(async () => finish());
  expect(document.activeElement).toBe(elsewhere);
});
