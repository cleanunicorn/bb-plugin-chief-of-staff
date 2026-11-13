// @vitest-environment jsdom
// Keyboard path through the Pipeline tab (issue #115): named regions, the chart's day
// columns, the skip link past the task grid, and one tab stop group for the cards.
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/state";
import type { RosterEntry } from "../src/roster";
import { entry } from "./helpers/roster";
import { act } from "react";
import { container, mount, tabbables, unmount } from "./dom";

const DAYS = Array.from({ length: 14 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, started: 1, done: i % 3, failed: i === 2 ? 1 : 0 }));

const mocks = vi.hoisted(() => ({ entries: [] as RosterEntry[], logs: [] as LogEntry[], call: vi.fn(), navigate: { toThread: vi.fn(), toPluginPanel: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method }: { method: string }) => ({
    data: method === "cos_log" ? { entries: mocks.logs } : method === "cos_roster" ? { entries: mocks.entries } : method === "cos_stats" ? { doneInWindow: 13, failedInWindow: 1, medianCycleMinutes: null, daily: DAYS } : { paused: false, repos: [], occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 }, errors: [], warnings: [] },
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

afterEach(async () => {
  await unmount();
  document.body.replaceChildren();
  mocks.entries = [];
  mocks.logs = [];
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
