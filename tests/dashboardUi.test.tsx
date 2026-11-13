// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/state";
import type { RosterEntry } from "../src/roster";
import { entry } from "./helpers/roster";
import { clickOutside, tick } from "./dom";
import { DEFAULT_WORKFLOW } from "../src/workflow";

type Query = { method: string; input: unknown };
const mocks = vi.hoisted(() => ({ entries: [] as RosterEntry[], logs: [] as LogEntry[], repos: [] as { key: string }[], workflow: {} as Record<string, unknown>, queries: [] as Query[], paused: false, failing: {} as Record<string, string>, call: vi.fn(), navigate: { toThread: vi.fn() } }));
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
      data: method === "cos_log" ? { entries: mocks.logs.filter((e) => !workItemId || e.workItemId === workItemId) } : method === "cos_roster" ? { entries: mocks.entries } : method === "cos_item_workflow" ? mocks.workflow : method === "cos_stats" ? { doneInWindow: 13, failedInWindow: 13, medianCycleMinutes: null, daily: [] } : { paused: mocks.paused, repos: mocks.repos, occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 }, errors: [], warnings: [] },
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
afterEach(async () => { await act(async () => { root?.unmount(); }); container.remove(); document.body.replaceChildren(); document.body.removeAttribute("style"); mocks.paused = false; mocks.failing = {}; mocks.logs = []; mocks.entries = []; mocks.repos = []; mocks.workflow = {}; mocks.queries = []; mocks.call.mockReset(); mocks.navigate.toThread.mockReset(); vi.unstubAllGlobals(); });

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

/** A log row of acme/app whose work item was not found (no task label), unless the test names one. */
const log = (over: Partial<LogEntry> & { id: number }): LogEntry => ({ at: new Date().toISOString(), level: "info", kind: "spawn", message: "spawned", actor: "event", repo: "acme/app", workItemId: null, issueNumber: null, issueTitle: null, ...over });
const taskButton = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="Open task ${name}"]`);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

it("shows compact activity rows with full messages and preserves problem filtering", async () => {
  mocks.logs = [
    log({ id: 1, kind: "spawn", message: "spawned Review thr_abc", actor: "event", workItemId: "one" }),
    log({ id: 2, level: "error", kind: "check", message: "Build failed (exit 1)", actor: "job", workItemId: "two" }),
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

// ---------- Activity rows: task names, thread links, task filter (#109) ----------

it("names each row's task and opens its workflow sheet, returning focus to the name", async () => {
  mocks.logs = [
    log({ id: 3, message: "Review agent 1 reported done", actor: "event", workItemId: "one", issueNumber: 7, issueTitle: "Fix login" }),
    log({ id: 2, message: "marked done", actor: "rpc:client", workItemId: "solo", issueTitle: "Tidy the README" }),
    log({ id: 1, kind: "control", message: "paused", actor: "rpc:client", repo: null }),
  ];
  mocks.workflow = { title: "acme/app#7 Fix login", workflow: DEFAULT_WORKFLOW, live: {} };
  await mount(<ActivityFeed />);
  const [issueRow, soloRow, controlRow] = Array.from(container.querySelectorAll("li"));
  const issue = taskButton("#7 Fix login")!;
  expect(issueRow!.contains(issue)).toBe(true);
  expect(issue.textContent).toBe("#7 Fix login");
  expect(issue.title).toBe("#7 Fix login");
  expect(issueRow!.textContent).toContain("#7 Fix login app Review agent 1 reported done · event");
  expect(soloRow!.contains(taskButton("Tidy the README"))).toBe(true);
  // Severity, kind, time and actor are still on the row.
  expect(soloRow!.querySelector('[data-icon="Info"]')).not.toBeNull();
  expect(soloRow!.querySelector("time")).not.toBeNull();
  expect(soloRow!.textContent).toContain("spawn");
  expect(soloRow!.textContent).toContain("· rpc:client");
  expect(controlRow!.querySelector('button[aria-label^="Open task"]')).toBeNull();
  expect(controlRow!.querySelector("span:last-child")!.textContent).toBe("paused · rpc:client");

  issue.focus();
  await act(async () => issue.click());
  expect(mocks.queries).toContainEqual({ method: "cos_item_workflow", input: { id: "one" } });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Where this task is");
  await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.getAttribute("aria-label") === "Close")!.click());
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(taskButton("#7 Fix login"));
});

it("links every thread id in a row's message and actor, leaving the text as it was", async () => {
  mocks.logs = [log({ id: 1, message: "archived 2 threads: thr_a, thr_b", actor: "tool:thr_c" })];
  await mount(<ActivityFeed />);
  const row = container.querySelector("li")!;
  expect(row.textContent).toContain("app archived 2 threads: thr_a, thr_b · tool:thr_c");
  const links = Array.from(row.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open thread"]'));
  expect(links.map((b) => b.textContent)).toEqual(["thr_a", "thr_b", "thr_c"]);
  for (const link of links) await act(async () => link.click());
  expect(mocks.navigate.toThread.mock.calls).toEqual([["thr_a"], ["thr_b"], ["thr_c"]]);
});

const logQueries = () => mocks.queries.filter((q) => q.method === "cos_log").map((q) => q.input);
const taskFilterTrigger = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Filter activity by task"]')!;
const openTaskFilter = async () => {
  taskFilterTrigger().focus();
  await keydown(taskFilterTrigger(), "Enter");
  await tick();
};
const twoTaskLogs = () => [
  log({ id: 4, level: "error", kind: "check", message: "Deploy failed", workItemId: "two", issueNumber: 9, issueTitle: "Repair deploy" }),
  log({ id: 3, message: "Review agent 1 reported done", workItemId: "one", issueNumber: 7, issueTitle: "Fix login" }),
  log({ id: 2, message: "spawned Build", workItemId: "two", issueNumber: 9, issueTitle: "Repair deploy" }),
  log({ id: 1, kind: "control", message: "paused", actor: "rpc:client", repo: null }),
];

it("narrows the feed to one task from its task menu, combines with Problems only, and clears again", async () => {
  mocks.logs = twoTaskLogs();
  await mount(<ActivityFeed />);
  await openTaskFilter();
  expect(menuItems().map((el) => el.textContent?.trim())).toEqual(["#9 Repair deploy", "#7 Fix login"]);
  await act(async () => menuItem("#9 Repair deploy").click());
  await tick();
  expect(logQueries().at(-1)).toEqual({ limit: 60, workItemId: "two" });
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.textContent).toContain("Deploy failed");
  expect(container.textContent).toContain("spawned Build");
  expect(container.textContent).not.toContain("Review agent 1 reported done");
  expect(taskFilterTrigger().textContent).toContain("Task: #9 Repair deploy");

  await act(async () => buttonLabelled("Problems only").click());
  expect(container.textContent).toContain("Deploy failed");
  expect(container.textContent).not.toContain("spawned Build");

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Clear task filter"]')!.click());
  expect(logQueries().at(-1)).toEqual({ limit: 60 });
  expect(taskFilterTrigger().textContent?.trim()).toBe("Task");
  expect(document.activeElement).toBe(taskFilterTrigger());
  await act(async () => buttonLabelled("Problems only").click());
  expect(container.textContent).toContain("Review agent 1 reported done");
  expect(container.textContent).toContain("paused");
});

it("names the chosen task even when it has no activity, and offers it in the task menu", async () => {
  mocks.logs = twoTaskLogs();
  const onTaskChange = vi.fn();
  await mount(<ActivityFeed task={{ id: "quiet", label: "#5 Quiet task" }} onTaskChange={onTaskChange} />);
  expect(logQueries().at(-1)).toEqual({ limit: 60, workItemId: "quiet" });
  expect(container.textContent).toContain("No activity for this task.");
  expect(taskFilterTrigger().textContent).toContain("Task: #5 Quiet task");
  await openTaskFilter();
  expect(menuItems().map((el) => el.textContent?.trim())).toContain("#5 Quiet task, selected");
  await keydown(document.activeElement!, "Escape");
  await tick();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Clear task filter"]')!.click());
  expect(onTaskChange).toHaveBeenCalledWith(null);
});

it("shows a card's activity from its menu, finished cards included, and moves focus to the Activity panel", async () => {
  mocks.entries = [entry(), entry({ id: "done-one", issueNumber: 3, issueTitle: "Old work", detail: "done", status: "done", threadId: null })];
  mocks.logs = [log({ id: 1, message: "marked done", workItemId: "done-one", issueNumber: 3, issueTitle: "Old work" }), log({ id: 2, message: "spawned Build", workItemId: "one", issueNumber: 1, issueTitle: "Fix login" })];
  const scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  await mount(<Dashboard subPath="agents" />);
  const done = Array.from(container.querySelectorAll("article")).find((a) => a.textContent?.includes("Old work"))!;
  const more = done.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
  more.focus();
  await keydown(more, "Enter");
  await tick();
  // A finished task offers only Show activity.
  expect(menuItems().map((el) => el.textContent?.trim())).toEqual(["Show activity"]);
  await act(async () => menuItem("Show activity").click());
  await tick(5);
  expect(logQueries().at(-1)).toEqual({ limit: 60, workItemId: "done-one" });
  expect(taskFilterTrigger().textContent).toContain("Task: #3 Old work");
  expect(container.textContent).toContain("marked done");
  expect(container.textContent).not.toContain("spawned Build");
  const heading = Array.from(container.querySelectorAll("h2")).find((h) => h.textContent?.trim() === "Activity")!;
  expect(document.activeElement).toBe(heading);
  expect(scrollIntoView).toHaveBeenCalled();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("keeps the active card's actions and adds Show activity last", async () => {
  mocks.entries = [entry()];
  await mount(<Dashboard subPath="agents" />);
  await openMenu();
  expect(menuItems().map((el) => el.textContent?.trim())).toEqual(["Retry the stuck step", "Mark done…", "Mark failed…", "Show activity"]);
});

it("drops the repository prefix when it is the only configured repository", async () => {
  mocks.repos = [{ key: "acme/app" }];
  mocks.logs = [log({ id: 2, message: "spawned Build" }), log({ id: 1, message: "old run", repo: "acme/removed" })];
  await mount(<ActivityFeed />);
  const [current, removed] = Array.from(container.querySelectorAll("li"));
  expect(current!.querySelector("span:last-child")!.textContent).toBe("spawned Build · event");
  // A row from a repository no longer configured keeps its name.
  expect(removed!.querySelector("span:last-child")!.textContent).toBe("removed old run · event");
  expect(mocks.queries).toContainEqual({ method: "cos_overview", input: null });
});

it("keeps the repository prefix with several repositories, or while they are unknown", async () => {
  mocks.repos = [{ key: "acme/app" }, { key: "acme/api" }];
  mocks.logs = [log({ id: 1, message: "spawned Build" })];
  await mount(<ActivityFeed />);
  expect(container.querySelector("li span:last-child")!.textContent).toBe("app spawned Build · event");
  mocks.repos = [{ key: "acme/app" }];
  mocks.failing = { cos_overview: "overview unavailable" };
  await act(async () => { root.render(<ActivityFeed key="again" />); });
  expect(container.querySelector("li span:last-child")!.textContent).toBe("app spawned Build · event");
  expect(container.textContent).not.toContain("overview unavailable");
});
