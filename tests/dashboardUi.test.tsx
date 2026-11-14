// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LogEntry, LogRow } from "../src/state";
import type { ActivityTask } from "../components/cos/dashboardModel";
import type { RosterEntry } from "../src/roster";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import { entry } from "./helpers/roster";
import { clickOutside, setValue, tick } from "./dom";

type RosterInput = { includeDone?: boolean; finishedLimit?: number; before?: string; withUsage?: boolean };
const mocks = vi.hoisted(() => ({
  entries: [] as RosterEntry[], logs: [] as (LogEntry | LogRow)[], repos: [] as { key: string }[], paused: false, archiveThreadsOnDone: undefined as boolean | undefined, daily: [] as { date: string; started: number; done: number; failed: number }[], failing: {} as Record<string, string>, queries: [] as { method: string; input: unknown }[], call: vi.fn(), navigate: { toThread: vi.fn() },
  /** When set, answers cos_roster queries from their input (like the server, which lists finished items only with includeDone). */
  roster: null as null | ((input: RosterInput) => { entries: RosterEntry[]; nextBefore?: string | null }),
  rosterInputs: [] as RosterInput[],
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method, input }: { method: string; input: { onlyProblems?: boolean; before?: number; limit?: number } }) => {
    // The host validates JSON before rendering, including absent optional cursors.
    z.json().parse(input);
    if (method === "cos_roster") mocks.rosterInputs.push(input as RosterInput);
    mocks.queries.push({ method, input });
    const failure = mocks.failing[method];
    // Like the SDK, a failed first load has an error and no data.
    if (failure) return { data: undefined, error: new Error(failure), isLoading: false, isFetching: false, refetch: vi.fn() };
    const workItemId = (input as { workItemId?: string } | null)?.workItemId;
    return {
      data: method === "cos_log" ? (() => { const rows = mocks.logs.filter(e => (!workItemId || e.workItemId === workItemId) && (!input.onlyProblems || e.level !== "info") && (input.before === undefined || e.id < input.before)); const entries = rows.slice(0, input.limit ?? 100); return { entries, nextCursor: rows.length > entries.length ? entries.at(-1)!.id : null }; })() : method === "cos_roster" ? (mocks.roster?.(input as RosterInput) ?? { entries: mocks.entries }) : method === "cos_stats" ? { doneInWindow: 13, failedInWindow: 13, medianCycleMinutes: null, daily: mocks.daily } : method === "cos_item_workflow" ? { title: "Fix login", workflow: DEFAULT_WORKFLOW, live: {}, journal: [], steps: {} } : { paused: mocks.paused, repos: mocks.repos, occupiedCapacity: 1, settings: { maxConcurrentTotal: 8, ...(mocks.archiveThreadsOnDone === undefined ? {} : { archiveThreadsOnDone: mocks.archiveThreadsOnDone }) }, errors: [], warnings: [] },
      error: null, refetch: vi.fn(),
    };
  },
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
  ThreadTitle: () => null,
  // Like the host's UrlLink: a plain anchor that passes its props through.
  UrlLink: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => <a href={href} {...rest}>{children}</a>,
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
afterEach(async () => { await act(async () => { root?.unmount(); }); container.remove(); document.body.replaceChildren(); document.body.removeAttribute("style"); mocks.paused = false; mocks.archiveThreadsOnDone = undefined; mocks.daily = []; mocks.failing = {}; mocks.repos = []; mocks.logs = []; mocks.queries = []; mocks.roster = null; mocks.rosterInputs = []; mocks.call.mockReset(); mocks.navigate.toThread.mockReset(); vi.unstubAllGlobals(); });

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

it("pads the Workflow progress disclosure to a touch-sized hit area on a coarse pointer only", async () => {
  const step = { id: "Plan", name: "Plan", depth: 0, status: "done" as const, type: "agent" as const, phase: null, agents: 1, reported: 0, nudged: 0, attempts: 0, round: 1, waitingKind: null, retrying: false };
  mocks.entries = [entry({ steps: [step] })];
  await mount();
  expect(container.querySelector("article details > summary")!.className.split(/\s+/)).toEqual(expect.arrayContaining(["py-0.5", "pointer-coarse:py-2"]));
});

// ---------- touch sizes (#116) ----------
// jsdom has no layout, so these pin the structure and the coarse-pointer classes; the sizes are measured in a browser.
const classes = (el: Element) => el.className.split(/\s+/);

it("makes the PR link the chip itself, sized for touch", async () => {
  mocks.entries = [entry({ prNumber: 42, prUrl: "https://github.com/acme/app/pull/42" })];
  await mount();
  const link = container.querySelector<HTMLAnchorElement>('article a[href="https://github.com/acme/app/pull/42"]')!;
  // The visible text is the link's name: no aria-label that would differ from it (WCAG 2.5.3).
  expect(link.hasAttribute("aria-label")).toBe(false);
  expect(link.textContent).toBe("PR #42");
  expect(link.querySelector('[data-icon="GitPullRequest"]')).not.toBeNull();
  expect(classes(link)).toEqual(expect.arrayContaining(["inline-flex", "h-7", "border", "pointer-coarse:h-10", "focus-visible:ring-1"]));
  expect(link.parentElement!.tagName).not.toBe("SPAN");
});

it("gives the card actions touch heights and keeps More actions out of the wrapping group", async () => {
  mocks.entries = [entry({ prNumber: 42, prUrl: "https://github.com/acme/app/pull/42", waitingKind: "approval", status: "waiting on human" })];
  await mount();
  const card = container.querySelector("article")!;
  const button = (label: string) => Array.from(card.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
  for (const label of ["Open thread", "Workflow", "Approve"]) expect(classes(button(label))).toEqual(expect.arrayContaining(["h-7", "pointer-coarse:h-10"]));
  const more = card.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
  expect(classes(more)).toEqual(expect.arrayContaining(["h-7", "w-7", "pointer-coarse:size-10", "shrink-0"]));
  expect(classes(more)).not.toContain("ml-auto");
  const group = button("Open thread").parentElement!;
  expect(classes(group)).toEqual(expect.arrayContaining(["flex-1", "flex-wrap"]));
  expect(group.contains(more)).toBe(false);
  expect(more.parentElement).toBe(group.parentElement);
  expect(classes(more.parentElement!)).not.toContain("flex-wrap");
});

it("keeps Resume and Retry step at touch height", async () => {
  mocks.entries = [entry({ detail: "waiting_on_human", status: "waiting on human", waitingKind: "cos_error" })];
  await mount();
  const retry = Array.from(container.querySelectorAll("article button")).find((b) => b.textContent?.trim() === "Retry step")!;
  expect(classes(retry)).toContain("pointer-coarse:h-10");
});

it("opens the Throughput table when the chart is tapped on a coarse pointer", async () => {
  mocks.entries = [];
  mocks.daily = Array.from({ length: 14 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, started: 1, done: 1, failed: 0 }));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  await mount();
  expect(container.querySelector("table")).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Show throughput as a table"]')!.click());
  expect(Array.from(container.querySelectorAll("th")).map((th) => th.textContent)).toEqual(["Day", "Started", "Done", "Failed"]);
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
  // A row from a repository no longer configured keeps its name, so it does not read as the current one.
  mocks.logs = [logRow({ repo: "acme/old", message: "merged PR" })];
  await act(async () => { root.render(<ActivityFeed key="removed" />); });
  expect(container.querySelector("li")!.textContent).toContain("old #7 Fix login merged PR");
  mocks.logs = [logRow()];
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
  expect(logQueries().at(-1)).toEqual({ limit: 60, onlyProblems: false });
  await openMenuOn(taskMenu()!);
  expect(menuItemsNow().map((el) => el.textContent?.trim())).toEqual(["#7 Fix login", "#8 Repair deploy"]);
  await act(async () => menuItemsNow()[1]!.click());
  await tick();
  expect(logQueries().at(-1)).toEqual({ limit: 60, onlyProblems: false, workItemId: "two" });
  expect(rowMessages()).toHaveLength(2);
  for (const text of rowMessages()) expect(text).toContain("#8 Repair deploy");
  expect(taskMenu()!.textContent).toBe("Task:\u00a0#8 Repair deploy");
  expect(document.activeElement).toBe(taskMenu());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show all activity"]')!.click());
  expect(logQueries().at(-1)).toEqual({ limit: 60, onlyProblems: false });
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
  // Problems only is filtered on the server, across retained history.
  expect(container.textContent).toContain("No warnings or errors within retention.");
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Problems only")!.click());
  expect(container.textContent).toContain("No activity for this task.");
});

it("moves focus to the Activity heading when clearing leaves no task to offer", async () => {
  mocks.logs = [];
  function Held() {
    const [task, setTask] = useState<ActivityTask | null>({ id: "quiet", label: "#9 Quiet" });
    return <ActivityFeed task={task} onTaskChange={setTask} />;
  }
  await mount(<Held />);
  expect(taskMenu()!.textContent).toBe("Task:\u00a0#9 Quiet");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show all activity"]')!.click());
  expect(taskMenu()).toBeUndefined();
  expect(document.activeElement?.tagName).toBe("H2");
  expect(document.activeElement?.textContent).toBe("Activity");
});

it("offers a described task without a title under its card's title", async () => {
  mocks.entries = [entry({ issueNumber: null, issueTitle: "", threadTitle: "Tidy the docs" })];
  await mount(<Dashboard subPath="agents" />);
  await openMenuOn(container.querySelector<HTMLButtonElement>('article [aria-label="More actions"]')!);
  await act(async () => menuItemsNow()[0]!.click());
  await tick(5);
  expect(taskMenu()!.textContent).toBe("Task:\u00a0Tidy the docs");
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
  // A done card also offers #135's "Run a step again…" (#108).
  expect(menuItemsNow().map((el) => el.textContent?.trim())).toEqual(["Show activity", "Run a step again…"]);
  await act(async () => menuItemsNow()[0]!.click());
  await tick(5);
  expect(logQueries().at(-1)).toEqual({ limit: 60, onlyProblems: false, workItemId: "old" });
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

it("shows a finished task's PR state next to its PR link", async () => {
  const finished = (id: string, title: string, state: "merged" | "open") => entry({ id, issueTitle: title, detail: "done", status: "done", actor: "none", current: [], prNumber: 7, prUrl: "https://github.com/acme/app/pull/7", pr: { state, draft: false, checks: state === "open" ? "failing" : null, review: null, checkedAt: new Date().toISOString() } });
  mocks.entries = [finished("a", "Merged task", "merged"), finished("b", "Open task", "open")];
  await mount();
  const row = (title: string) => Array.from(container.querySelectorAll("article")).find((a) => a.textContent!.includes(title))!;
  expect(row("Merged task").querySelector("[data-pr-state]")!.textContent).toBe("Merged");
  // The row shows the state alone; checks and review are on the Pull requests list.
  expect(row("Open task").querySelector("[data-pr-state]")!.textContent).toBe("Open");
});

it("still shows the empty pull request state when nothing failed", async () => {
  mocks.entries = [];
  await mount(<ReposTab />);
  expect(container.textContent).toContain("No pull requests yet");
});

// ---------- the Finished section (#105) ----------

const finished = (id: string, title: string, detail: "done" | "failed" = "done", over: Partial<RosterEntry> = {}) => entry({ id, issueTitle: title, detail, status: detail, actor: "none", current: [], occupiesCapacity: false, threadId: null, ...over });
const activeGroup = () => container.querySelector<HTMLElement>('[role="group"][aria-label="Tasks"]');
const finishedGroup = () => container.querySelector<HTMLElement>('[role="group"][aria-label="Finished tasks"]');
const cardTitles = () => Array.from(activeGroup()?.querySelectorAll("article") ?? []).map((a) => a.querySelector("h3")!.textContent);
const rowTitles = () => Array.from(finishedGroup()?.querySelectorAll("article") ?? []).map((a) => a.querySelector("p")!.textContent);
const hasButton = (label: string) => Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.trim() === label);
const finishedPanel = () => Array.from(container.querySelectorAll("h2")).find((h) => h.textContent?.startsWith("Finished"))!.closest("section")!;

it("keeps active cards in the active grid and finished tasks in the Finished section, never mixed", async () => {
  const active = [
    entry({ id: "old", issueTitle: "Old approval", detail: "waiting_on_human", status: "waiting on human", actor: "human", waitingKind: "approval", waitingReason: "Approve the plan" }),
    entry({ id: "new", issueTitle: "New build" }),
  ];
  const history = [finished("f1", "Shipped one"), finished("f2", "Broke two", "failed")];
  // The server lists finished items only with includeDone, after every active one.
  mocks.roster = (input) => ({ entries: input.includeDone ? [...active, ...history] : active, nextBefore: null });
  await mount();
  expect(cardTitles()).toEqual(["Old approval", "New build"]);
  expect(rowTitles()).toEqual(["Shipped one", "Broke two"]);
  // The Finished section comes after the active grid, and before Throughput.
  const throughput = Array.from(container.querySelectorAll("h2")).find((h) => h.textContent?.startsWith("Throughput"))!;
  expect(activeGroup()!.compareDocumentPosition(finishedGroup()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(finishedGroup()!.compareDocumentPosition(throughput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector('[aria-label="Needs attention"]')?.textContent).toContain("1 questions or approvals");
  expect(finishedPanel().querySelector("h2")!.textContent).toBe("Finished · 2");
  for (const gone of ["Show finished", "Hide finished", "Show older finished"]) expect(container.textContent).not.toContain(gone);
  expect(Array.from(container.querySelectorAll("h2")).map((h) => h.textContent)).toContain("Active tasks");
  // The active query asks for no finished items; the finished one skips token usage.
  expect(mocks.rosterInputs).toEqual(expect.arrayContaining([{ includeDone: false, withUsage: true }, { includeDone: true, withUsage: false }]));
});

it("never hides finished tasks behind a stage or attention filter", async () => {
  const active = [entry({ id: "a", issueTitle: "Agent task" }), entry({ id: "q", issueTitle: "Queued task", detail: "queued", status: "queued", actor: "none", current: [] })];
  mocks.roster = (input) => ({ entries: input.includeDone ? [...active, finished("f1", "Shipped one")] : active, nextBefore: null });
  await mount();
  const stage = Array.from(container.querySelectorAll('[aria-label="Filter active tasks"] button')).find((b) => b.textContent?.includes("Queued")) as HTMLButtonElement;
  await act(async () => stage.click());
  expect(cardTitles()).toEqual(["Queued task"]);
  expect(rowTitles()).toEqual(["Shipped one"]);
});

it("groups finished tasks by the day they finished, newest first", async () => {
  const day = (offsetDays: number, hour: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - offsetDays);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  mocks.roster = (input) => ({ entries: input.includeDone ? [finished("t", "Today task", "done", { finishedAt: day(0, 0) }), finished("y", "Yesterday task", "failed", { finishedAt: day(1, 12) }), finished("legacy", "Legacy task", "done", { finishedAt: null }), finished("o", "Old task", "done", { finishedAt: day(6, 12) })] : [], nextBefore: null });
  await mount();
  const headings = Array.from(finishedGroup()!.querySelectorAll("h3")).map((h) => h.textContent);
  expect(headings).toEqual(["Today", "Yesterday", new Date(day(6, 12)).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }), "Earlier"]);
  expect(rowTitles()).toEqual(["Today task", "Yesterday task", "Old task", "Legacy task"]);
});

it("renders a finished task whose detail was pruned (#56)", async () => {
  mocks.roster = (input) => ({ entries: input.includeDone ? [finished("p", "Pruned task", "done", { steps: [], finishedAt: null, outcome: "completed" })] : [], nextBefore: null });
  await mount();
  expect(rowTitles()).toEqual(["Pruned task"]);
  expect(finishedGroup()!.textContent).toContain("Completed");
  expect(finishedGroup()!.textContent).toContain("Started");
});

it("shows 10 finished tasks, then 20 more per click, fetching the next page when the loaded ones run out", async () => {
  const page1 = Array.from({ length: 45 }, (_, i) => finished(`f${i}`, `Finished ${i}`));
  const page2 = Array.from({ length: 10 }, (_, i) => finished(`g${i}`, `Older ${i}`));
  mocks.roster = (input) => ({ entries: input.includeDone ? page1 : [], nextBefore: input.includeDone ? "c1" : null });
  mocks.call.mockImplementation(async (method: string, input: RosterInput) => {
    if (method !== "cos_roster") return {};
    if (input.before === "c1") return { entries: page2, nextBefore: null };
    throw new Error(`unexpected cursor ${input.before}`);
  });
  await mount();
  expect(rowTitles()).toHaveLength(10);
  expect(finishedPanel().querySelector("h2")!.textContent).toBe("Finished · 45+");
  await act(async () => buttonLabelled("Show 20 more").click());
  expect(rowTitles()).toHaveLength(30);
  expect(mocks.call).not.toHaveBeenCalled();
  await act(async () => buttonLabelled("Show 20 more").click());
  expect(mocks.call).toHaveBeenCalledWith("cos_roster", { includeDone: true, before: "c1", withUsage: false });
  expect(rowTitles()).toHaveLength(50);
  expect(rowTitles().at(-1)).toBe("Older 4");
  await act(async () => buttonLabelled("Show 20 more").click());
  expect(rowTitles()).toHaveLength(55);
  expect(hasButton("Show 20 more")).toBe(false);
  expect(finishedPanel().querySelector("h2")!.textContent).toBe("Finished · 55");
});

it("shows a live task once when an appended page still holds its finished copy", async () => {
  let retried = false;
  const first = Array.from({ length: 10 }, (_, i) => finished(`f${i}`, `Finished ${i}`));
  mocks.roster = (input) => ({ entries: retried ? [entry({ id: "x", issueTitle: "Retried" })] : input.includeDone ? first : [], nextBefore: input.includeDone && !retried ? "c1" : null });
  mocks.call.mockResolvedValue({ entries: [finished("x", "Finished x")], nextBefore: null });
  await mount();
  await act(async () => buttonLabelled("Show 20 more").click());
  expect(rowTitles()).toContain("Finished x");
  retried = true;
  await act(async () => { root.render(<PipelineTab />); });
  expect(cardTitles()).toEqual(["Retried"]);
  expect(rowTitles()).not.toContain("Finished x");
  expect(container.textContent).not.toContain("Finished x");
});

it("reports a failed older page and keeps the button", async () => {
  mocks.roster = (input) => ({ entries: input.includeDone ? [finished("f1", "Finished one")] : [], nextBefore: input.includeDone ? "c1" : null });
  mocks.call.mockRejectedValue(new Error("history unavailable"));
  await mount();
  await act(async () => buttonLabelled("Show 20 more").click());
  expect(container.textContent).toContain("history unavailable");
  expect(buttonLabelled("Show 20 more").disabled).toBe(false);
});

it("loads one older page at a time", async () => {
  mocks.roster = (input) => ({ entries: input.includeDone ? [finished("f1", "Finished one")] : [], nextBefore: input.includeDone ? "c1" : null });
  let resolve!: (page: unknown) => void;
  mocks.call.mockImplementation(() => new Promise((r) => { resolve = r; }));
  await mount();
  const button = buttonLabelled("Show 20 more");
  await act(async () => { button.click(); button.click(); });
  expect(mocks.call).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  await act(async () => resolve({ entries: [finished("f2", "Finished two")], nextBefore: null }));
  expect(rowTitles()).toEqual(["Finished one", "Finished two"]);
});

it("says when nothing has finished yet, but not when the finished tasks failed to load", async () => {
  mocks.roster = () => ({ entries: [], nextBefore: null });
  await mount();
  expect(finishedPanel().textContent).toContain("No finished tasks yet");
  await act(async () => { root.unmount(); });
  root = createRoot(container);
  mocks.roster = null;
  mocks.failing = { cos_roster: "roster unavailable" };
  await act(async () => { root.render(<PipelineTab />); });
  expect(container.textContent).toContain("roster unavailable");
  expect(container.textContent).not.toContain("No finished tasks yet");
});

it("collapses and expands the Finished section", async () => {
  mocks.roster = (input) => ({ entries: input.includeDone ? [finished("f1", "Finished one")] : [], nextBefore: null });
  await mount();
  const toggle = buttonLabelled("Collapse");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await act(async () => toggle.click());
  expect(buttonLabelled("Expand").getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(buttonLabelled("Expand").getAttribute("aria-controls")!)!.hidden).toBe(true);
  // The heading and count stay, so the section is still found.
  expect(finishedPanel().querySelector("h2")!.textContent).toBe("Finished · 1");
  await act(async () => buttonLabelled("Expand").click());
  expect(rowTitles()).toEqual(["Finished one"]);
});

// ---------- Finished filters (#105) ----------

const searchBox = () => container.querySelector<HTMLInputElement>('input[aria-label="Search finished tasks"]')!;
const outcomeToggle = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Outcome"] button')).find((b) => b.textContent?.trim() === label)!;
const mixedHistory = () => [
  finished("m", "Merged login fix", "done", { outcome: "merged", issueNumber: 12, prNumber: 40 }),
  finished("d", "Marked docs", "done", { outcome: "marked_done", issueNumber: 13, repo: "acme/api" }),
  finished("x", "Broken deploy", "failed", { outcome: "pr_closed", issueNumber: 14, prNumber: 41 }),
  finished("y", "Hand failed", "failed", { outcome: "marked_failed", issueNumber: 15, repo: "acme/api" }),
];

it("filters finished tasks by outcome, several at once", async () => {
  mocks.roster = (input) => ({ entries: input.includeDone ? mixedHistory() : [], nextBefore: null });
  await mount();
  await act(async () => outcomeToggle("Failed").click());
  expect(outcomeToggle("Failed").getAttribute("aria-pressed")).toBe("true");
  expect(rowTitles()).toEqual(["Broken deploy", "Hand failed"]);
  await act(async () => outcomeToggle("Marked done").click());
  expect(rowTitles()).toEqual(["Marked docs", "Broken deploy", "Hand failed"]);
  await act(async () => outcomeToggle("Failed").click());
  await act(async () => outcomeToggle("Marked done").click());
  await act(async () => outcomeToggle("Shipped").click());
  expect(rowTitles()).toEqual(["Merged login fix"]);
});

it("filters finished tasks by repository, listing configured and loaded repositories", async () => {
  mocks.repos = [{ key: "acme/app" }, { key: "acme/web" }];
  mocks.roster = (input) => ({ entries: input.includeDone ? mixedHistory() : [], nextBefore: null });
  await mount();
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Repository"]')!;
  expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["All repositories", "acme/api", "acme/app", "acme/web"]);
  await setValue(select, "acme/api");
  expect(rowTitles()).toEqual(["Marked docs", "Hand failed"]);
  await setValue(select, "acme/web");
  expect(rowTitles()).toEqual([]);
  expect(finishedPanel().textContent).toContain("No finished tasks match");
});

it("finds finished tasks by title, issue number or PR number", async () => {
  mocks.roster = (input) => ({ entries: input.includeDone ? mixedHistory() : [], nextBefore: null });
  await mount();
  await setValue(searchBox(), "deploy");
  expect(rowTitles()).toEqual(["Broken deploy"]);
  await setValue(searchBox(), "#13");
  expect(rowTitles()).toEqual(["Marked docs"]);
  await setValue(searchBox(), "40");
  expect(rowTitles()).toEqual(["Merged login fix"]);
});

it("says when no finished task matches, and clears the filters", async () => {
  mocks.roster = (input) => ({ entries: input.includeDone ? mixedHistory() : [], nextBefore: null });
  await mount();
  await setValue(searchBox(), "nothing like this");
  expect(finishedGroup()).toBeNull();
  expect(finishedPanel().textContent).toContain("No finished tasks match");
  expect(finishedPanel().textContent).not.toContain("No finished tasks yet");
  expect(hasButton("Search older")).toBe(false);
  await act(async () => buttonLabelled("Clear filters").click());
  expect(searchBox().value).toBe("");
  expect(rowTitles()).toHaveLength(4);
});

it("says only the loaded finished tasks were searched, and searches older pages on request", async () => {
  mocks.roster = (input) => ({ entries: input.includeDone ? mixedHistory() : [], nextBefore: input.includeDone ? "c1" : null });
  mocks.call.mockImplementation(async (method: string, input: RosterInput) => {
    if (method !== "cos_roster") return {};
    if (input.before === "c1") return { entries: [finished("o", "Old migration", "done", { outcome: "completed" })], nextBefore: "c2" };
    return { entries: [], nextBefore: null };
  });
  await mount();
  await setValue(searchBox(), "migration");
  expect(finishedPanel().textContent).toContain("No finished tasks match");
  expect(finishedPanel().textContent).toContain("Searched the 4 most recently finished tasks.");
  await act(async () => buttonLabelled("Search older").click());
  expect(mocks.call).toHaveBeenCalledWith("cos_roster", { includeDone: true, before: "c1", withUsage: false });
  expect(rowTitles()).toEqual(["Old migration"]);
  // More pages remain: the note stays under the list, with the button.
  expect(finishedPanel().textContent).toContain("Searched the 5 most recently finished tasks.");
  expect(hasButton("Search older")).toBe(true);
  expect(hasButton("Show 20 more")).toBe(false);
});

it("starts paging over when a filter changes", async () => {
  const many = Array.from({ length: 40 }, (_, i) => finished(`f${i}`, `Task ${i}`, i % 2 ? "failed" : "done", { outcome: i % 2 ? "failed" : "merged" }));
  mocks.roster = (input) => ({ entries: input.includeDone ? many : [], nextBefore: null });
  await mount();
  await act(async () => buttonLabelled("Show 20 more").click());
  expect(rowTitles()).toHaveLength(30);
  await act(async () => outcomeToggle("Shipped").click());
  expect(rowTitles()).toHaveLength(10);
  expect(rowTitles()[0]).toBe("Task 0");
  await act(async () => buttonLabelled("Show 20 more").click());
  expect(rowTitles()).toHaveLength(20);
  expect(hasButton("Show 20 more")).toBe(false);
});

// ---------- Throughput opens the Finished section (#105) ----------

/** The UTC day `offset` days ago, and a time on it. */
const utcDay = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset: number, time = "12:00:00") => `${utcDay(offset)}T${time}.000Z`;
const window14 = () => Array.from({ length: 14 }, (_, i) => ({ date: utcDay(13 - i), started: 0, done: 0, failed: 0 }));
const fmt = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const finishedHeadingEl = () => finishedPanel().querySelector("h2")!;

it("opens a Throughput day's finished tasks from its column, clearing other filters, and focuses the section", async () => {
  mocks.daily = window14();
  mocks.roster = (input) => ({
    entries: input.includeDone ? [
      finished("a", "Today one", "done", { outcome: "merged", finishedAt: at(0, "01:00:00") }),
      finished("b", "Three days ago", "done", { outcome: "merged", finishedAt: at(3, "23:59:00") }),
      finished("c", "Three days ago too", "failed", { outcome: "failed", finishedAt: at(3, "00:00:00") }),
      finished("d", "Four days ago", "done", { outcome: "completed", finishedAt: at(4) }),
      finished("legacy", "No finish time", "done", { finishedAt: null }),
    ] : [],
    nextBefore: null,
  });
  await mount();
  await setValue(searchBox(), "Today");
  await act(async () => buttonLabelled("Collapse").click());
  const day = Array.from(container.querySelectorAll<HTMLButtonElement>("figure button[aria-label]")).find((b) => b.getAttribute("aria-label")!.startsWith(`${fmt(utcDay(3))}:`))!;
  await act(async () => day.click());
  expect(buttonLabelled("Collapse").getAttribute("aria-expanded")).toBe("true");
  expect(searchBox().value).toBe("");
  // Done and failed, like the bar: legacy rows without a finish time never match a day.
  expect(rowTitles()).toEqual(["Three days ago", "Three days ago too"]);
  const chip = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove the date filter"]')!;
  expect(chip.textContent).toBe(`Finished ${fmt(utcDay(3))}`);
  expect(document.activeElement).toBe(finishedHeadingEl());
  await act(async () => chip.click());
  expect(rowTitles()).toHaveLength(5);
});

it("opens a day from the table view, where each day is a button", async () => {
  mocks.daily = window14();
  mocks.roster = (input) => ({ entries: input.includeDone ? [finished("a", "Today one", "done", { finishedAt: at(0) }), finished("b", "Yesterday one", "done", { finishedAt: at(1) })] : [], nextBefore: null });
  await mount();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Table view"]')!.click());
  const dayButton = container.querySelector<HTMLButtonElement>(`table button[aria-label="Show tasks finished ${fmt(utcDay(1))}"]`)!;
  expect(dayButton.textContent).toBe(fmt(utcDay(1)));
  await act(async () => dayButton.click());
  expect(rowTitles()).toEqual(["Yesterday one"]);
  expect(document.activeElement).toBe(finishedHeadingEl());
});

it("opens the window's completed or failed tasks from the Throughput counts", async () => {
  mocks.daily = window14();
  mocks.roster = (input) => ({
    entries: input.includeDone ? [
      finished("m", "Merged", "done", { outcome: "merged", finishedAt: at(1) }),
      finished("h", "Hand done", "done", { outcome: "marked_done", finishedAt: at(2) }),
      finished("f", "Broke", "failed", { outcome: "failed", finishedAt: at(2) }),
      finished("old", "Too old", "done", { outcome: "merged", finishedAt: at(20) }),
    ] : [],
    nextBefore: null,
  });
  await mount();
  await act(async () => buttonLabelled("13 completed").click());
  expect(rowTitles()).toEqual(["Merged", "Hand done"]);
  expect(outcomeToggle("Shipped").getAttribute("aria-pressed")).toBe("true");
  expect(outcomeToggle("Marked done").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('button[aria-label^="Remove the date filter"]')!.textContent).toBe(`Finished ${fmt(utcDay(13))} – ${fmt(utcDay(0))}`);
  await act(async () => buttonLabelled("13 historical failed runs").click());
  expect(rowTitles()).toEqual(["Broke"]);
  expect(outcomeToggle("Failed").getAttribute("aria-pressed")).toBe("true");
  expect(outcomeToggle("Shipped").getAttribute("aria-pressed")).toBe("false");
});

it("loads older pages for a day until the loaded tasks reach past it", async () => {
  mocks.daily = window14();
  mocks.roster = (input) => ({ entries: input.includeDone ? [finished("a", "Today one", "done", { finishedAt: at(0) })] : [], nextBefore: input.includeDone ? "c1" : null });
  mocks.call.mockImplementation(async (method: string, input: RosterInput) => {
    if (method !== "cos_roster") return {};
    if (input.before === "c1") return { entries: [finished("b", "Five days ago", "done", { finishedAt: at(5) }), finished("legacy", "Legacy", "done", { finishedAt: null })], nextBefore: "c2" };
    if (input.before === "c2") return { entries: [finished("c", "Seven days ago", "done", { finishedAt: at(7) }), finished("d", "Eight days ago", "done", { finishedAt: at(8) })], nextBefore: "c3" };
    throw new Error(`unexpected cursor ${input.before}`);
  });
  await mount();
  const day = Array.from(container.querySelectorAll<HTMLButtonElement>("figure button[aria-label]")).find((b) => b.getAttribute("aria-label")!.startsWith(`${fmt(utcDay(7))}:`))!;
  await act(async () => day.click());
  await tick();
  expect(mocks.call.mock.calls.map(([, input]) => (input as RosterInput).before)).toEqual(["c1", "c2"]);
  expect(rowTitles()).toEqual(["Seven days ago"]);
});

it("stops loading older pages for a day when one fails", async () => {
  mocks.daily = window14();
  mocks.roster = (input) => ({ entries: input.includeDone ? [finished("a", "Today one", "done", { finishedAt: at(0) })] : [], nextBefore: input.includeDone ? "c1" : null });
  mocks.call.mockRejectedValue(new Error("history unavailable"));
  await mount();
  const day = Array.from(container.querySelectorAll<HTMLButtonElement>("figure button[aria-label]")).find((b) => b.getAttribute("aria-label")!.startsWith(`${fmt(utcDay(7))}:`))!;
  await act(async () => day.click());
  await tick();
  await tick();
  expect(mocks.call).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("history unavailable");
  // Asking again still works.
  await act(async () => buttonLabelled("Search older").click());
  expect(mocks.call).toHaveBeenCalledTimes(2);
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

it.each([
  ["Mark done", true, "Chief of Staff stops working on this task and its workflow ends. Its threads are archived and their workspace is removed: changes not pushed are lost."],
  ["Mark done", false, "Chief of Staff stops working on this task and its workflow ends. Its threads are left as they are."],
  ["Mark failed", true, "Chief of Staff stops working on this task and its workflow ends. The agent's thread is left as it is."],
])("says what %s does to the threads (archiving on done: %s)", async (label, archive, description) => {
  mocks.entries = [entry()];
  mocks.archiveThreadsOnDone = archive;
  await mount();
  await openMenu();
  await act(async () => menuItem(label).click());
  await tick();
  expect(confirmDialog()?.textContent).toContain(description);
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

it("links an issue-backed card to its GitHub issue and labels the PR chip", async () => {
  mocks.entries = [entry({ prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" })];
  await mount();
  const card = container.querySelector("article")!;
  const issue = card.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/app/issues/1"]')!;
  expect(issue.textContent).toBe("app issue #1");
  const pr = card.querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/app/pull/7"]')!;
  expect(pr.textContent).toBe("PR #7");
});

it("shows a standalone card's repository without an issue link", async () => {
  mocks.entries = [entry({ issueNumber: null, issueUrl: null })];
  await mount();
  const card = container.querySelector("article")!;
  expect(card.querySelector('a[href*="/issues/"]')).toBeNull();
  expect(card.querySelector('[title="acme/app"]')!.textContent).toBe("app");
});

it("links each pull request row to its PR and issue, with a Workflow button", async () => {
  mocks.entries = [entry({ prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" }), entry({ id: "two", issueNumber: null, issueUrl: null, issueTitle: "Tidy", prNumber: 8, prUrl: "https://github.com/acme/app/pull/8" })];
  await mount(<ReposTab />);
  const [linked, standalone] = Array.from(container.querySelectorAll("li"));
  expect(linked!.querySelector('a[href$="/pull/7"]')!.textContent).toBe("PR #7");
  expect(linked!.querySelector('a[href$="/issues/1"]')!.textContent).toBe("issue #1");
  expect(linked!.textContent).toContain("closes issue #1");
  expect(Array.from(linked!.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Workflow")).toBe(true);
  expect(standalone!.querySelector('a[href$="/pull/8"]')!.textContent).toBe("PR #8");
  expect(standalone!.querySelector('a[href*="/issues/"]')).toBeNull();
  expect(standalone!.textContent).not.toContain("closes");
  expect(Array.from(standalone!.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Workflow")).toBe(true);
});

it("pages older activity and resets the cursor when changing the server filter", async () => {
  mocks.logs = Array.from({ length: 201 }, (_, i) => ({ id: 201 - i, at: "2026-11-13T10:00:00Z", level: i === 200 ? "error" as const : "info" as const, kind: "test", message: `entry ${201 - i}`, actor: "test", repo: null, workItemId: null }));
  await mount(<ActivityFeed />);
  const click = async (label: string) => { await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === label)!.click()); };
  expect(container.querySelectorAll("li")).toHaveLength(60);
  await click("Show older");
  expect(container.textContent).toContain("entry 141");
  await click("Show older");
  await click("Show older");
  expect(container.querySelectorAll("li")).toHaveLength(21);
  expect(container.textContent).toContain("End of retained activity");
  expect(container.textContent).not.toContain("Show older");
  await click("Back to newest");
  await click("Problems only");
  expect(container.querySelectorAll("li")).toHaveLength(1);
  expect(container.textContent).toContain("entry 1");
  expect(container.textContent).not.toContain("Back to newest");
});

it("drops the cursor when the task filter changes, without a request that still carries it", async () => {
  mocks.logs = Array.from({ length: 130 }, (_, i) => ({ id: 130 - i, at: "2026-11-13T10:00:00Z", level: "info" as const, kind: "test", message: `entry ${130 - i}`, actor: "test", repo: null, workItemId: i % 2 ? "one" : "two", issueNumber: null, issueTitle: null }));
  await mount(<ActivityFeed task={null} onTaskChange={() => {}} />);
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Show older")!.click());
  expect(logQueries().at(-1)).toMatchObject({ before: 71 });
  const seen = logQueries().length;
  await act(async () => { root.render(<ActivityFeed task={{ id: "one", label: "Task one" }} onTaskChange={() => {}} />); });
  const after = logQueries().slice(seen);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((q) => (q as { before?: number }).before === undefined)).toBe(true);
  expect(after.at(-1)).toEqual({ limit: 60, onlyProblems: false, workItemId: "one" });
});

// ---------- Finished rows: how the task ended ----------

const finishedCard = (over: Partial<RosterEntry>) => entry({ detail: "done", status: "done", actor: "none", current: [], threadStatus: "idle", startedAt: "2026-11-05T10:00:00.000Z", finishedAt: "2026-11-05T11:12:00.000Z", ...over });

it.each([
  { outcome: "merged", label: "Merged", icon: "GitMerge" },
  { outcome: "pr_opened", label: "PR opened", icon: "GitPullRequest" },
  { outcome: "completed", label: "Completed", icon: "CircleCheck" },
  { outcome: "marked_done", label: "Marked done", icon: "UserCheck" },
  { outcome: "failed", label: "Failed", icon: "CircleX" },
  { outcome: "marked_failed", label: "Marked failed", icon: "UserX" },
  { outcome: "pr_closed", label: "PR closed", icon: "GitPullRequestClosed" },
] as const)("labels a finished card by how it ended: $outcome", async ({ outcome, label, icon }) => {
  const failed = outcome === "failed" || outcome === "marked_failed" || outcome === "pr_closed";
  mocks.entries = [finishedCard({ outcome, detail: failed ? "failed" : "done", status: failed ? "failed" : "done" })];
  await mount();
  const row = container.querySelector("article")!;
  const pill = row.querySelector("span.rounded-full")!;
  expect(pill.textContent).toBe(label);
  expect(pill.querySelector("[data-icon]")!.getAttribute("data-icon")).toBe(icon);
});

it("never calls a delivered task Closed and hides its stale error", async () => {
  mocks.entries = [finishedCard({ outcome: "pr_opened", prNumber: 7, prUrl: "https://github.com/acme/app/pull/7", lastError: "Cannot read properties of undefined (reading 'length')" })];
  await mount();
  const card = container.querySelector("article")!;
  expect(card.textContent).toContain("PR opened");
  expect(card.textContent).not.toContain("Closed");
  expect(card.textContent).not.toContain("Cannot read properties");
  expect(card.textContent).not.toContain("Why it ended");
});

it.each([
  { outcome: "failed", reason: "thread archived" },
  { outcome: "pr_closed", reason: "PR closed without merge" },
] as const)("shows why a $outcome task ended without opening the workflow", async ({ outcome, reason }) => {
  mocks.entries = [finishedCard({ outcome, detail: "failed", status: "failed", lastError: reason })];
  await mount();
  const line = Array.from(container.querySelectorAll("article p")).find((p) => p.textContent?.startsWith("Why it ended:"))!;
  expect(line.textContent).toBe(`Why it ended: ${reason}`);
  expect(line.querySelector("[title]")!.getAttribute("title")).toBe(reason);
});

it("does not present an old error as the cause of a task marked failed by hand", async () => {
  const stale = "Cannot read properties of undefined (reading 'length')";
  mocks.entries = [finishedCard({ outcome: "marked_failed", detail: "failed", status: "failed", lastError: stale })];
  await mount();
  const card = container.querySelector("article")!;
  expect(card.textContent).not.toContain("Why it ended");
  const line = Array.from(card.querySelectorAll("p")).find((p) => p.textContent?.startsWith("Last error:"))!;
  expect(line.textContent).toBe(`Last error: ${stale}`);
});

// The Pull requests list (components/cos/prState.tsx) labels a row by its PR's state as read from GitHub, not the task's outcome.
it("labels finished pull requests by their PR state", async () => {
  const pr = (state: "merged" | "closed") => ({ state, draft: false, checks: null, review: null, checkedAt: new Date().toISOString() });
  mocks.entries = [
    finishedCard({ outcome: "pr_closed", detail: "failed", status: "failed", prNumber: 7, lastError: "PR closed without merge", pr: pr("closed") }),
    finishedCard({ id: "two", outcome: "merged", prNumber: 8, pr: pr("merged") }),
  ];
  await mount(<ReposTab />);
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("All"))!.click());
  const row = (n: number) => Array.from(container.querySelectorAll("li")).find((li) => li.textContent?.includes(`PR #${n}`))!;
  expect(row(7).querySelector("[data-pr-state]")!.getAttribute("data-pr-state")).toBe("closed");
  expect(row(8).querySelector("[data-pr-state]")!.getAttribute("data-pr-state")).toBe("merged");
});

it("says when a finished task finished and how long it took", async () => {
  const finishedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const startedAt = new Date(Date.parse(finishedAt) - 72 * 60_000).toISOString();
  mocks.entries = [finishedCard({ outcome: "pr_opened", startedAt, finishedAt })];
  await mount();
  const timer = container.querySelector('article [aria-label^="Finished"]')!;
  expect(timer.getAttribute("aria-label")).toBe("Finished 2h ago, took 1.2h");
  expect(timer.textContent).toBe("Finished 2h ago · took 1.2h");
  expect(timer.getAttribute("title")).toBe(`Finished ${new Date(finishedAt).toLocaleString()} · started ${new Date(startedAt).toLocaleString()}`);
  expect(container.querySelector('article [aria-label^="Task age"]')).toBeNull();
});

it("says only when a finished task started when its finish time is unknown", async () => {
  mocks.entries = [finishedCard({ outcome: "completed", startedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), finishedAt: null })];
  await mount();
  const timer = container.querySelector('article [aria-label^="Started"]')!;
  expect(timer.getAttribute("aria-label")).toBe("Started 8d ago");
  expect(timer.textContent).toBe("Started 8d ago");
});

it("keeps the task age on active cards", async () => {
  mocks.entries = [entry({ startedAt: new Date(Date.now() - 30 * 60_000).toISOString() })];
  await mount();
  const timer = container.querySelector('article [aria-label^="Task age"]')!;
  expect(timer.getAttribute("aria-label")).toBe("Task age 30m");
  expect(timer.textContent).toBe("30m");
});

// ---------- Finished rows: actions that fit how the task ended (#108) ----------

const failed = () => entry({ detail: "failed", status: "failed", occupiesCapacity: false, threadStatus: "idle" });
const done = () => entry({ detail: "done", status: "done", occupiesCapacity: false, threadStatus: "idle" });

it("offers a failed card a restart and Mark done, never Mark failed", async () => {
  mocks.entries = [failed()];
  await mount();
  await openMenu();
  expect(menuItems().map((el) => el.textContent?.trim())).toEqual(["Restart on a new thread…", "Mark done…"]);
});

it("asks before restarting a failed task, and sends nothing on cancel", async () => {
  mocks.entries = [failed()];
  await mount();
  await openMenu();
  await act(async () => menuItem("Restart on a new thread").click());
  await tick();
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  expect(confirmDialog()?.textContent).toContain("Restart ‘Fix login’ on a new thread?");
  await act(async () => bodyButton("Cancel").click());
  await tick(5);
  expect(confirmDialog()).toBeNull();
  expect(mocks.call).not.toHaveBeenCalled();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(document.activeElement).toBe(moreActions());
});

it("restarts a failed task on confirm, naming the new thread and the task slot", async () => {
  mocks.entries = [failed()];
  mocks.call.mockResolvedValue({});
  await mount();
  await openMenu();
  await act(async () => menuItem("Restart on a new thread").click());
  await tick();
  expect(confirmDialog()!.textContent).toMatch(/new thread/);
  expect(confirmDialog()!.textContent).toMatch(/slot/);
  expect(actionCalls()).toHaveLength(0);
  await act(async () => bodyButton("Restart").click());
  await tick(5);
  expect(actionCalls()).toEqual([["cos_item_action", { id: "one", action: "retry" }]]);
  expect(confirmDialog()).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(document.activeElement).toBe(moreActions());
});

it("says what Mark done means for a failed task, and sends it on confirm", async () => {
  mocks.entries = [failed()];
  mocks.call.mockResolvedValue({});
  await mount();
  await openMenu();
  await act(async () => menuItem("Mark done").click());
  await tick();
  expect(confirmDialog()!.textContent).toContain("Mark ‘Fix login’ done?");
  expect(confirmDialog()!.textContent).toContain("recorded as done instead of failed");
  expect(confirmDialog()!.textContent).not.toContain("stops working on this task");
  await act(async () => bodyButton("Mark done").click());
  await tick(5);
  expect(actionCalls()).toEqual([["cos_item_action", { id: "one", action: "mark_done" }]]);
});

it("offers a done card only a step re-run", async () => {
  mocks.entries = [done()];
  await mount();
  await openMenu();
  expect(menuItems().map((el) => el.textContent?.trim())).toEqual(["Run a step again…"]);
});

it("opens a done task's workflow at the step list, and returns focus to More actions on close", async () => {
  mocks.entries = [done()];
  await mount();
  await openMenu();
  await act(async () => menuItem("Run a step again").click());
  await tick(5);
  const sheet = confirmDialog()!;
  expect(sheet.textContent).toContain("Where this task is");
  const toggle = (label: string) => Array.from(sheet.querySelectorAll('[aria-label="View"] button')).find((b) => b.textContent?.trim() === label)!;
  expect(toggle("List").getAttribute("aria-pressed")).toBe("true");
  expect(toggle("Canvas").getAttribute("aria-pressed")).toBe("false");
  expect(sheet.querySelector('ol[aria-label="Workflow steps"]')).not.toBeNull();
  expect(actionCalls()).toHaveLength(0);
  await act(async () => (sheet.querySelector('[aria-label="Close"]') as HTMLButtonElement).click());
  await tick(5);
  expect(confirmDialog()).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(document.activeElement).toBe(moreActions());
});

it("still opens the workflow on the canvas from the Workflow button", async () => {
  mocks.entries = [done()];
  await mount();
  await act(async () => buttonLabelled("Workflow").click());
  await tick(5);
  const sheet = confirmDialog()!;
  const toggle = (label: string) => Array.from(sheet.querySelectorAll('[aria-label="View"] button')).find((b) => b.textContent?.trim() === label)!;
  expect(toggle("Canvas").getAttribute("aria-pressed")).toBe("true");
  expect(sheet.querySelector('ol[aria-label="Workflow steps"]')).toBeNull();
});

it("keeps a failed task's Mark done text while the roster changes under the open confirm", async () => {
  mocks.entries = [failed()];
  await mount();
  await openMenu();
  await act(async () => menuItem("Mark done").click());
  await tick();
  // The same card, re-rendered from a refetched roster in which the task is no longer failed.
  mocks.entries = [entry({ detail: "agent", status: "running" })];
  await act(async () => { root.render(<PipelineTab />); });
  expect(container.querySelector("article")!.textContent).not.toContain("failed");
  expect(confirmDialog()!.textContent).toContain("recorded as done instead of failed");
});
