// @vitest-environment jsdom
// Keyboard path through the Pipeline tab (issue #115): named regions, the chart's day
// columns, the skip link past the task grid, and one tab stop group for the cards.
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/state";
import type { RosterEntry } from "../src/roster";
import { entry } from "./helpers/roster";
import { act } from "react";
import { click, container, mount, tabbables, tabbablesAfter, tick, unmount } from "./dom";

const DAYS = Array.from({ length: 14 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, started: 1, done: i % 3, failed: i === 2 ? 1 : 0 }));

const mocks = vi.hoisted(() => ({ entries: [] as RosterEntry[], logs: [] as LogEntry[], repos: [] as { key: string; active: number; maxConcurrent: number }[], call: vi.fn(), navigate: { toThread: vi.fn(), toPluginPanel: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method }: { method: string }) => ({
    data: method === "cos_log" ? { entries: mocks.logs } : method === "cos_roster" ? { entries: mocks.entries } : method === "cos_stats" ? { doneInWindow: 13, failedInWindow: 1, medianCycleMinutes: null, daily: DAYS } : { paused: false, repos: mocks.repos, occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 }, errors: [], warnings: [] },
    error: null, isLoading: false, isFetching: false, refetch: vi.fn(),
  }),
  ThreadTitle: () => null,
  // Spread the props, so a tabIndex on the PR link reaches the anchor as it does in the host.
  UrlLink: ({ href, ...props }: { href: string; children?: ReactNode }) => <a href={href} {...props} />,
}));
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} aria-hidden="true" /> }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({ ...(await original<typeof import("../components/cos/workflowCanvas")>()), WorkflowCanvas: () => null }));
import { ActivityFeed, PipelineTab } from "../app";

const step = (id: string, depth: number, status: "done" | "running" | "pending") => ({ id, name: id, depth, status, type: "agent" as const, phase: null, agents: 1, reported: 0, nudged: 0, attempts: 0, round: 1, waitingKind: null, retrying: false });

/** `count` tasks, each with every card control: workflow progress, Open thread, Workflow, the PR link and More actions. */
function tasks(count: number): RosterEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry({ id: `t${i}`, issueTitle: `Task ${i}`, issueNumber: i + 1, threadId: `thread-${i}`, prUrl: `https://github.com/acme/app/pull/${i + 1}`, prNumber: i + 1, steps: [step("Plan", 0, "done"), step("Build", 1, "running"), step("Ship", 2, "pending")] }),
  );
}

const page = () => mount(<><PipelineTab /><ActivityFeed /></>);
const heading = (text: string) => Array.from(container.querySelectorAll("h2")).find((h) => h.textContent?.trim() === text)!;

afterEach(async () => {
  await unmount();
  document.body.replaceChildren();
  mocks.entries = [];
  mocks.logs = [];
  mocks.repos = [];
  mocks.call.mockReset();
});

// ---------- M1: named regions ----------

it("names every Pipeline panel as a region by its heading", async () => {
  mocks.entries = tasks(3);
  await page();
  const regions = Array.from(container.querySelectorAll<HTMLElement>("section[aria-labelledby]"));
  const names = regions.map((section) => document.getElementById(section.getAttribute("aria-labelledby")!)?.textContent?.trim());
  expect(names).toEqual(expect.arrayContaining(["Active tasks", "Throughput · last 14 days", "Capacity", "Activity"]));
  for (const section of regions) expect(document.getElementById(section.getAttribute("aria-labelledby")!)?.tagName).toBe("H2");
});

// ---------- M3: chart days are images, not buttons ----------

it("shows chart days as images with their numbers, not as buttons or tab stops", async () => {
  mocks.entries = tasks(1);
  await page();
  const figure = container.querySelector("figure")!;
  expect(figure.querySelectorAll("button")).toHaveLength(0);
  expect(tabbables(figure)).toHaveLength(0);
  const days = Array.from(figure.querySelectorAll('[role="img"][aria-label]'));
  expect(days).toHaveLength(14);
  expect(days[2]!.getAttribute("aria-label")).toMatch(/^Nov 3: Done 2, Failed 1$/);
});

it("still shows a day's tooltip on hover", async () => {
  mocks.entries = tasks(1);
  await page();
  const day = container.querySelectorAll('figure [role="img"]')[2]!;
  await act(async () => { day.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("Nov 3");
  await act(async () => { day.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
  expect(container.querySelector('[role="tooltip"]')).toBeNull();
});

it("names the chart and table view toggles on the buttons themselves", async () => {
  await page();
  const toggles = Array.from(container.querySelectorAll('[role="group"][aria-label="View"] button'));
  expect(toggles.map((b) => b.getAttribute("aria-label"))).toEqual(["Chart view", "Table view"]);
});

// ---------- M2: skip link past the task grid ----------

const LOGS: LogEntry[] = [
  { id: 1, at: new Date().toISOString(), level: "info", kind: "spawn", message: "spawned Review", actor: "event", repo: "acme/app", workItemId: "t0" },
  { id: 2, at: new Date().toISOString(), level: "error", kind: "check", message: "Build failed", actor: "job", repo: "acme/app", workItemId: "t1" },
];

it("skips from Work overview past 50 tasks to Throughput, then reaches Activity in three tabs", async () => {
  mocks.entries = tasks(50);
  mocks.logs = LOGS;
  await page();
  const [skip] = tabbablesAfter(heading("Work overview"));
  expect(skip?.tagName).toBe("A");
  expect(skip!.textContent?.trim()).toBe("Skip to throughput and activity");
  const target = document.getElementById(skip!.getAttribute("href")!.slice(1));
  expect(target?.tagName).toBe("SECTION");
  expect(target!.contains(heading("Throughput · last 14 days"))).toBe(true);

  await click(skip!);
  expect(document.activeElement).toBe(heading("Throughput · last 14 days"));

  const next = tabbablesAfter(document.activeElement!).slice(0, 3);
  expect(next.map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim())).toEqual(["Chart view", "Table view", "Problems only"]);
});

it("keeps the skip link when there are no tasks", async () => {
  await page();
  const [skip] = tabbablesAfter(heading("Work overview"));
  expect(skip?.textContent?.trim()).toBe("Skip to throughput and activity");
  await click(skip!);
  expect(document.activeElement).toBe(heading("Throughput · last 14 days"));
});

// ---------- M4: the task grid is one tab stop group ----------

const group = () => container.querySelector<HTMLElement>('[role="group"][aria-label="Tasks"]')!;
const cards = () => Array.from(group().querySelectorAll("article"));
const cardOf = (el: Element | null) => cards().indexOf(el?.closest("article") as HTMLElement);
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
/** The card whose controls are in the tab order; every tab stop in the grid must belong to it. */
const currentCard = () => {
  const owners = new Set(tabbables(group()).map(cardOf));
  expect(owners.size).toBe(1);
  return [...owners][0];
};

/** An approval-waiting card shows all eight controls: issue, progress, Answer, Open thread, Workflow, PR, Approve, More actions. */
function withApprovalFirst(list: RosterEntry[]): RosterEntry[] {
  list[0] = { ...list[0]!, detail: "waiting_on_human", status: "waiting on human", waitingKind: "approval", waitingReason: "Review the plan" };
  return list;
}

it("keeps the task grid to one card's tab stops, whether it shows 5 tasks or 50", async () => {
  mocks.entries = withApprovalFirst(tasks(5));
  await page();
  const five = tabbables(group()).length;
  expect(five).toBe(tabbables(cards()[0]!).length);
  expect(five).toBe(8);
  expect(cards().slice(1).every((card) => tabbables(card).length === 0)).toBe(true);

  mocks.entries = withApprovalFirst(tasks(50));
  await page();
  expect(cards()).toHaveLength(50);
  expect(tabbables(group())).toHaveLength(five);
  expect(currentCard()).toBe(0);
});

it("describes the arrow keys on the task group", async () => {
  mocks.entries = tasks(3);
  await page();
  const hint = document.getElementById(group().getAttribute("aria-describedby")!);
  expect(hint?.textContent).toBe("Arrow keys or j and k move between tasks.");
});

it("moves between cards with the arrow keys, Home and End", async () => {
  mocks.entries = tasks(6);
  await page();
  const first = (index: number) => cards()[index]!.querySelector("summary")!;
  first(0).focus();
  await press(document.activeElement!, "ArrowRight");
  expect(document.activeElement).toBe(first(1));
  expect(currentCard()).toBe(1);
  await press(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe(first(2));
  await press(document.activeElement!, "ArrowUp");
  await press(document.activeElement!, "ArrowLeft");
  expect(document.activeElement).toBe(first(0));
  await press(document.activeElement!, "ArrowLeft");
  expect(document.activeElement).toBe(first(0));
  await press(document.activeElement!, "End");
  expect(document.activeElement).toBe(first(5));
  expect(currentCard()).toBe(5);
  await press(document.activeElement!, "Home");
  expect(document.activeElement).toBe(first(0));
  expect(currentCard()).toBe(0);
});

it("moves from any control of a card, and ignores arrows with modifier keys", async () => {
  mocks.entries = tasks(3);
  await page();
  const workflow = Array.from(cards()[1]!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Workflow")!;
  workflow.focus();
  await act(async () => {});
  expect(currentCard()).toBe(1);
  await press(workflow, "ArrowRight", { altKey: true });
  expect(document.activeElement).toBe(workflow);
  await press(workflow, "ArrowRight");
  expect(document.activeElement).toBe(cards()[2]!.querySelector("summary"));
});

it("lands on Workflow progress, or on the Workflow button when a card has no steps", async () => {
  const list = tasks(3);
  list[1] = { ...list[1]!, steps: [] };
  mocks.entries = list;
  await page();
  const workflowButton = (card: Element) => Array.from(card.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Workflow")!;
  cards()[0]!.querySelector("summary")!.focus();
  await press(document.activeElement!, "ArrowRight");
  // The issue link comes first in the card, but it opens GitHub.
  expect(cards()[1]!.querySelector("summary")).toBeNull();
  expect(document.activeElement).toBe(workflowButton(cards()[1]!));
  await press(document.activeElement!, "ArrowRight");
  expect(document.activeElement).toBe(cards()[2]!.querySelector("summary"));
});

it("lets ArrowDown open More actions instead of moving to the next card", async () => {
  mocks.entries = tasks(3);
  await page();
  const more = cards()[0]!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
  more.focus();
  await press(more, "ArrowDown");
  await tick();
  expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  expect(currentCard()).toBe(0);
  await press(document.activeElement!, "ArrowDown");
  await tick();
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  expect(currentCard()).toBe(0);
  await press(document.activeElement!, "Escape");
  await tick();
  expect(document.activeElement).toBe(more);
});

it("falls back to the first card when the current one leaves the list", async () => {
  mocks.entries = tasks(3);
  await page();
  cards()[1]!.querySelector("summary")!.focus();
  await act(async () => {});
  expect(currentCard()).toBe(1);
  mocks.entries = tasks(3).filter((e) => e.id !== "t1");
  await page();
  expect(cards()).toHaveLength(2);
  expect(currentCard()).toBe(0);
});

// ---------- j and k (#110) ----------

/** Press a key and say whether anything claimed it (called preventDefault). */
const pressed = async (target: Element, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event.defaultPrevented;
};
const summaryOf = (index: number) => cards()[index]!.querySelector("summary")!;

it("moves to the next card with j and the previous one with k, clamped at both ends", async () => {
  mocks.entries = tasks(3);
  await page();
  summaryOf(0).focus();
  await press(document.activeElement!, "k");
  expect(document.activeElement).toBe(summaryOf(0));
  await press(document.activeElement!, "j");
  expect(document.activeElement).toBe(summaryOf(1));
  expect(currentCard()).toBe(1);
  await press(document.activeElement!, "j");
  await press(document.activeElement!, "j");
  expect(document.activeElement).toBe(summaryOf(2));
  await press(document.activeElement!, "k");
  expect(document.activeElement).toBe(summaryOf(1));
});

it("moves from any control of a card with j", async () => {
  mocks.entries = tasks(3);
  await page();
  const more = cards()[0]!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
  more.focus();
  await press(more, "j");
  expect(document.activeElement).toBe(summaryOf(1));
});

it("focuses the current card when j or k is pressed outside the grid", async () => {
  mocks.entries = tasks(3);
  await page();
  summaryOf(2).focus();
  await act(async () => {});
  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  await press(document.body, "j");
  expect(document.activeElement).toBe(summaryOf(2));
  heading("Work overview").focus();
  await press(document.activeElement!, "k");
  expect(document.activeElement).toBe(summaryOf(2));
});

it("focuses the first card from the page when no card has been current yet", async () => {
  mocks.entries = tasks(3);
  await page();
  await press(document.body, "j");
  expect(document.activeElement).toBe(summaryOf(0));
});

it("leaves j and k alone with a modifier held", async () => {
  mocks.entries = tasks(3);
  await page();
  summaryOf(0).focus();
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    await press(document.activeElement!, "j", init);
    expect(document.activeElement).toBe(summaryOf(0));
  }
});

it("lets j and k type into the New task form", async () => {
  mocks.entries = tasks(3);
  mocks.repos = [{ key: "acme/app", active: 1, maxConcurrent: 4 }];
  await page();
  await click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "New task")!);
  const fields = Array.from(container.querySelectorAll<HTMLElement>("#new-task input, #new-task textarea, #new-task select"));
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    field.focus();
    const event = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);
  }
});

it("does nothing with j and k while a menu or a dialog is open", async () => {
  mocks.entries = tasks(3);
  await page();
  const more = cards()[0]!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
  more.focus();
  await press(more, "ArrowDown");
  await tick();
  expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  const item = document.activeElement!;
  // Focus traps would pull focus back anyway; the shortcut must not even claim the key.
  expect(await pressed(item, "j")).toBe(false);
  expect(document.activeElement).toBe(item);
  await press(item, "Escape");
  await tick();

  // A confirm dialog (here a failed card's Restart) is open over the grid.
  const failed = tasks(3);
  failed[0] = { ...failed[0]!, detail: "failed", status: "failed", outcome: "failed", current: [], occupiesCapacity: false };
  mocks.entries = failed;
  await page();
  const trigger = cards()[0]!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
  trigger.focus();
  await press(trigger, "ArrowDown");
  await tick();
  const restart = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((m) => m.textContent?.includes("Restart"))!;
  await act(async () => { restart.click(); });
  await tick();
  expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).not.toBeNull();
  const inDialog = document.activeElement!;
  expect(await pressed(inDialog, "j")).toBe(false);
  expect(await pressed(inDialog, "k")).toBe(false);
  expect(document.activeElement).toBe(inDialog);
});

it("does nothing with j and k while the workflow sheet is open", async () => {
  mocks.entries = tasks(3);
  await page();
  await click(Array.from(cards()[0]!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Workflow")!);
  await tick();
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(await pressed(document.activeElement ?? document.body, "j")).toBe(false);
});
