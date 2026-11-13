// @vitest-environment jsdom
// The Pull requests list on the Repos & PRs tab: each PR's own state, the
// "needs action" default, paging, and the empty states.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RosterEntry } from "../src/roster";
import { entry } from "./helpers/roster";

const mocks = vi.hoisted(() => ({ entries: [] as RosterEntry[], tokenSource: "setting" as string }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => ({ toThread: vi.fn() }),
  useRpc: () => ({ call: vi.fn() }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method }: { method: string }) => ({
    data: method === "cos_roster" ? { entries: mocks.entries } : { paused: false, repos: [], occupiedCapacity: 0, settings: { maxConcurrentTotal: 8 }, errors: [], warnings: [], tokenSource: mocks.tokenSource },
    error: null, refetch: vi.fn(),
  }),
  ThreadTitle: () => null,
  UrlLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} aria-hidden="true" />, hostIconName: (name: string) => name }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({ ...(await original<typeof import("../components/cos/workflowCanvas")>()), WorkflowCanvas: () => null }));
import { ReposTab } from "../app";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<ReposTab />); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); container.remove(); mocks.tokenSource = "setting"; vi.unstubAllGlobals(); });

type Pr = NonNullable<RosterEntry["pr"]>;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
/** A finished task whose PR is #n, in the given state. */
function prEntry(n: number, pr: Partial<Pr> | null, extra: Partial<RosterEntry> = {}): RosterEntry {
  return entry({
    id: `pr-${n}`, issueTitle: `Task ${n}`, detail: "done", status: "done", actor: "none", current: [], prNumber: n, prUrl: `https://github.com/acme/app/pull/${n}`,
    lastActivityAt: at(n), pr: pr ? { state: "open", draft: false, checks: null, review: null, checkedAt: at(1), ...pr } : null, ...extra,
  });
}
const rows = () => Array.from(container.querySelectorAll<HTMLLIElement>('[aria-label="Pull requests"] > li'));
const button = (text: RegExp) => Array.from(container.querySelectorAll("button")).find((b) => text.test(b.textContent ?? ""));
const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => (el as HTMLElement).click()); };
const icons = (li: Element) => Array.from(li.querySelectorAll("[data-icon]")).map((i) => i.getAttribute("data-icon"));

it("tells merged, failing and closed PRs apart by text and icon", async () => {
  mocks.entries = [prEntry(1, { state: "merged" }), prEntry(2, { checks: "failing", review: "changes_requested" }), prEntry(3, { state: "closed" })];
  await mount();
  await click(button(/^All/));
  const [merged, failing, closed] = [1, 2, 3].map((n) => rows().find((li) => li.textContent!.includes(`Task ${n}`))!);
  expect(merged.textContent).toContain("Merged");
  expect(failing.textContent).toContain("Open");
  expect(failing.textContent).toContain("Checks failing");
  expect(failing.textContent).toContain("Changes requested");
  expect(closed.textContent).toContain("Closed");
  const stateIcon = (li: Element) => li.querySelector("[data-pr-state] [data-icon]")!.getAttribute("data-icon");
  expect(new Set([stateIcon(merged), stateIcon(failing), stateIcon(closed)]).size).toBe(3);
  expect(icons(failing)).toContain("CircleX");
  expect(failing.querySelector("[data-pr-state]")!.getAttribute("aria-label")).toBe("Pull request open, checks failing, changes requested");
  // Finished tasks no longer say "Shipped": the PR's own state replaces it.
  expect(container.textContent).not.toContain("Shipped");
});

it("shows PRs that need action by default, with merged and closed one click away", async () => {
  mocks.entries = [prEntry(1, { state: "merged" }), prEntry(2, { checks: "passing" }), prEntry(3, { state: "closed" }), prEntry(4, null), prEntry(5, { draft: true })];
  await mount();
  expect(button(/^Needs action/)!.getAttribute("aria-pressed")).toBe("true");
  expect(button(/^Needs action/)!.textContent).toContain("3");
  expect(rows().map((li) => li.textContent!.match(/Task \d/)![0])).toEqual(["Task 2", "Task 4", "Task 5"]);
  expect(rows()[1]!.textContent).toContain("State unknown");
  expect(rows()[2]!.textContent).toContain("Draft");
  await click(button(/^Merged/));
  expect(rows().map((li) => li.textContent!.match(/Task \d/)![0])).toEqual(["Task 1"]);
  await click(button(/^Closed/));
  expect(rows().map((li) => li.textContent!.match(/Task \d/)![0])).toEqual(["Task 3"]);
});

it("puts failing checks and requested changes first among PRs needing action", async () => {
  mocks.entries = [prEntry(1, { checks: "passing" }), prEntry(2, { checks: "pending" }), prEntry(3, { checks: "passing", review: "changes_requested" }), prEntry(4, { checks: "failing" })];
  await mount();
  expect(rows().map((li) => li.textContent!.match(/Task \d/)![0])).toEqual(["Task 3", "Task 4", "Task 1", "Task 2"]);
});

it("pages ten rows at a time and starts over on a filter change", async () => {
  mocks.entries = Array.from({ length: 25 }, (_, i) => prEntry(i + 1, { checks: "passing" }));
  await mount();
  expect(rows()).toHaveLength(10);
  await click(button(/Show more/));
  expect(rows()).toHaveLength(20);
  expect(button(/Show more/)!.textContent).toContain("5 more");
  await click(button(/^All/));
  expect(rows()).toHaveLength(10);
});

it("offers the merged PRs when none need action", async () => {
  mocks.entries = [prEntry(1, { state: "merged" }), prEntry(2, { state: "merged" })];
  await mount();
  expect(container.textContent).toContain("No open pull requests");
  await click(button(/^Show merged \(2\)/));
  expect(rows()).toHaveLength(2);
  expect(button(/^Merged/)!.getAttribute("aria-pressed")).toBe("true");
});

it("keeps the task's stage on an active PR row and its read time in the row title", async () => {
  mocks.entries = [prEntry(1, { checks: "pending" }, { detail: "ci", status: "running", actor: "system" }), prEntry(2, { checks: "passing" })];
  await mount();
  const [active, finished] = rows();
  expect(active!.textContent).toContain("CI running");
  expect(finished!.textContent).not.toContain("Shipped");
  expect(active!.getAttribute("title")).toBe("PR state checked 1m ago");
});

it("says PR state needs GitHub auth when there is none", async () => {
  mocks.tokenSource = "none";
  mocks.entries = [prEntry(1, null)];
  await mount();
  expect(container.textContent).toContain("PR state needs GitHub auth");
  expect(rows()[0]!.textContent).toContain("State unknown");
});

it("says what the list shows when there are no PRs at all", async () => {
  mocks.entries = [];
  await mount();
  expect(container.textContent).toContain("No pull requests yet");
  expect(container.textContent).toContain("with their state, checks and review");
});
