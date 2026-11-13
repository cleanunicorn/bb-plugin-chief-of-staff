// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/state";
import type { RosterEntry } from "../src/roster";
import { entry } from "./helpers/roster";
import { clickOutside, tick } from "./dom";

type RosterInput = { includeDone?: boolean; finishedLimit?: number; before?: string; withUsage?: boolean };
const mocks = vi.hoisted(() => ({
  entries: [] as RosterEntry[], logs: [] as LogEntry[], paused: false, failing: {} as Record<string, string>, call: vi.fn(), navigate: { toThread: vi.fn() },
  /** When set, answers cos_roster queries from their input (like the server, which lists finished items only with includeDone). */
  roster: null as null | ((input: RosterInput) => { entries: RosterEntry[]; nextBefore?: string | null }),
  rosterInputs: [] as RosterInput[],
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method, input }: { method: string; input: unknown }) => {
    if (method === "cos_roster") mocks.rosterInputs.push(input as RosterInput);
    const failure = mocks.failing[method];
    // Like the SDK, a failed first load has an error and no data.
    if (failure) return { data: undefined, error: new Error(failure), isLoading: false, isFetching: false, refetch: vi.fn() };
    return {
      data: method === "cos_log" ? { entries: mocks.logs } : method === "cos_roster" ? (mocks.roster?.(input as RosterInput) ?? { entries: mocks.entries }) : method === "cos_stats" ? { doneInWindow: 13, failedInWindow: 13, medianCycleMinutes: null, daily: [] } : { paused: mocks.paused, repos: [], occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 }, errors: [], warnings: [] },
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
afterEach(async () => { await act(async () => { root?.unmount(); }); container.remove(); document.body.replaceChildren(); document.body.removeAttribute("style"); mocks.paused = false; mocks.failing = {}; mocks.roster = null; mocks.rosterInputs = []; mocks.call.mockReset(); vi.unstubAllGlobals(); });

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

// ---------- finished history (#106) ----------

const titles = () => Array.from(container.querySelectorAll("article")).map((a) => a.querySelector("h3")?.textContent ?? a.textContent);
const finished = (id: string, title: string, detail: "done" | "failed" = "done") => entry({ id, issueTitle: title, detail, status: detail, actor: "none", current: [], occupiesCapacity: false, threadId: null });

it("keeps an old active task and its counts when Show finished is on", async () => {
  const active = [
    entry({ id: "old", issueTitle: "Old approval", detail: "waiting_on_human", status: "waiting on human", actor: "human", waitingKind: "approval", waitingReason: "Approve the plan" }),
    entry({ id: "new", issueTitle: "New build" }),
  ];
  const history = [finished("f1", "Shipped one"), finished("f2", "Broke two", "failed")];
  mocks.roster = (input) => ({ entries: input.includeDone ? [...active, ...history] : active, nextBefore: null });
  await mount();
  const attention = () => container.querySelector('[aria-label="Needs attention"]')?.textContent;
  const stages = () => container.querySelector('[aria-label="Filter active tasks"]')?.textContent;
  const [attentionOff, stagesOff] = [attention(), stages()];
  expect(attentionOff).toContain("1 questions or approvals");
  await act(async () => buttonLabelled("Show finished").click());
  expect(container.textContent).toContain("Old approval");
  expect(container.textContent).toContain("Shipped one");
  expect(attention()).toBe(attentionOff);
  expect(stages()).toBe(stagesOff);
  expect(container.textContent).not.toContain("Show older finished");
});

it("pages older finished tasks without duplicates and drops them when finished are hidden", async () => {
  const live = [entry({ id: "a", issueTitle: "Active task" }), finished("f1", "Finished one")];
  mocks.roster = (input) => (input.includeDone ? { entries: live, nextBefore: "c1" } : { entries: [live[0]!] });
  mocks.call.mockImplementation(async (method: string, input: RosterInput) => {
    if (method !== "cos_roster") return {};
    if (input.before === "c1") return { entries: [finished("f1", "Finished one"), finished("f2", "Finished two")], nextBefore: "c2" };
    if (input.before === "c2") return { entries: [finished("f3", "Finished three")], nextBefore: null };
    throw new Error(`unexpected cursor ${input.before}`);
  });
  await mount();
  expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Show older finished"))).toBe(false);
  await act(async () => buttonLabelled("Show finished").click());
  await act(async () => buttonLabelled("Show older finished").click());
  expect(mocks.call).toHaveBeenCalledWith("cos_roster", { includeDone: true, before: "c1", withUsage: true });
  expect(titles().filter((t) => t?.includes("Finished one"))).toHaveLength(1);
  expect(container.textContent).toContain("Finished two");
  await act(async () => buttonLabelled("Show older finished").click());
  expect(mocks.call).toHaveBeenLastCalledWith("cos_roster", { includeDone: true, before: "c2", withUsage: true });
  expect(container.textContent).toContain("Finished three");
  expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Show older finished"))).toBe(false);
  // The active task comes first, once.
  expect(titles()[0]).toContain("Active task");
  expect(titles().filter((t) => t?.includes("Active task"))).toHaveLength(1);

  await act(async () => buttonLabelled("Hide finished").click());
  expect(container.textContent).not.toContain("Finished two");
  await act(async () => buttonLabelled("Show finished").click());
  expect(container.textContent).not.toContain("Finished two");
  expect(buttonLabelled("Show older finished")).toBeDefined();
});

it("shows a live task once when an appended page still holds its finished copy", async () => {
  let retried = false;
  mocks.roster = (input) => ({ entries: retried ? [entry({ id: "f2", issueTitle: "Retried two" })] : input.includeDone ? [finished("f1", "Finished one")] : [], nextBefore: "c1" });
  mocks.call.mockResolvedValue({ entries: [finished("f2", "Finished two")], nextBefore: null });
  await mount();
  await act(async () => buttonLabelled("Show finished").click());
  await act(async () => buttonLabelled("Show older finished").click());
  expect(container.textContent).toContain("Finished two");
  retried = true;
  await act(async () => { root.render(<PipelineTab />); });
  expect(container.textContent).toContain("Retried two");
  expect(container.textContent).not.toContain("Finished two");
});

it("reports a failed older page and keeps the button", async () => {
  mocks.roster = () => ({ entries: [finished("f1", "Finished one")], nextBefore: "c1" });
  mocks.call.mockRejectedValue(new Error("history unavailable"));
  await mount();
  await act(async () => buttonLabelled("Show finished").click());
  await act(async () => buttonLabelled("Show older finished").click());
  expect(container.textContent).toContain("history unavailable");
  expect(buttonLabelled("Show older finished").disabled).toBe(false);
});

const hasOlderButton = () => Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Show older finished"));

it("offers older finished tasks only when no filter hides them", async () => {
  mocks.roster = () => ({ entries: [entry({ id: "a", issueTitle: "Active task" }), finished("f1", "Finished one")], nextBefore: "c1" });
  await mount();
  await act(async () => buttonLabelled("Show finished").click());
  expect(hasOlderButton()).toBe(true);
  const stage = Array.from(container.querySelectorAll('[aria-label="Filter active tasks"] button')).find((b) => b.textContent?.includes("Tasks with agents")) as HTMLButtonElement;
  await act(async () => stage.click());
  expect(hasOlderButton()).toBe(false);
  await act(async () => buttonLabelled("Clear filter").click());
  expect(hasOlderButton()).toBe(true);
});

it("loads one older page at a time", async () => {
  mocks.roster = () => ({ entries: [finished("f1", "Finished one")], nextBefore: "c1" });
  let resolve!: (page: unknown) => void;
  mocks.call.mockImplementation(() => new Promise((r) => { resolve = r; }));
  await mount();
  await act(async () => buttonLabelled("Show finished").click());
  const button = buttonLabelled("Show older finished");
  await act(async () => { button.click(); button.click(); });
  expect(mocks.call).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  await act(async () => resolve({ entries: [finished("f2", "Finished two")], nextBefore: null }));
  expect(container.textContent).toContain("Finished two");
});

it("drops an older page that arrives after finished tasks were hidden", async () => {
  mocks.roster = () => ({ entries: [finished("f1", "Finished one")], nextBefore: "c1" });
  let resolve!: (page: unknown) => void;
  mocks.call.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  await mount();
  await act(async () => buttonLabelled("Show finished").click());
  await act(async () => buttonLabelled("Show older finished").click());
  await act(async () => buttonLabelled("Hide finished").click());
  await act(async () => buttonLabelled("Show finished").click());
  await act(async () => resolve({ entries: [finished("f2", "Late page")], nextBefore: null }));
  expect(container.textContent).not.toContain("Late page");
  expect(buttonLabelled("Show older finished").disabled).toBe(false);
});

it("lists the pull request of an active task on Repos & PRs, with a deep finished page", async () => {
  mocks.entries = [entry({ id: "old", issueTitle: "Old approval", prNumber: 42, detail: "waiting_on_human", status: "waiting on human" }), finished("f1", "No PR")];
  await mount(<ReposTab />);
  expect(container.textContent).toContain("#42");
  expect(container.textContent).toContain("Old approval");
  expect(mocks.rosterInputs.at(-1)).toMatchObject({ includeDone: true, finishedLimit: 200 });
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
