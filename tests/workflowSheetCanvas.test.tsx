// @vitest-environment jsdom
// The real canvas inside the real workflow sheet: Escape on a step must reach the sheet first.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const node = (id: string) => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const details = () => dialog()?.querySelector('[aria-label="Step details"] h3')?.textContent ?? null;
const press = (key: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
/** Two frames: React Flow defers its blur to the next one. */
const frames = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubReactFlowDom();
  mocks.entries = [entry()];
  mocks.workflow = { title: "Fix login", workflow: DEFAULT_WORKFLOW, live: {} };
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<PipelineTab />); });
  await act(async () => { Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Workflow")!.click(); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("clears the selected step on Escape and keeps focus on it", async () => {
  node("build").focus();
  await press("Enter");
  expect(details()).toBe("Build");
  await press("Escape");
  await frames();
  expect(dialog()).not.toBeNull();
  expect(details()).toBeNull();
  expect(node("build").classList.contains("selected")).toBe(false);
  expect(document.activeElement).toBe(node("build"));
  await press("Escape");
  expect(dialog()).toBeNull();
});

it("closes on Escape from an unselected step instead of selecting it", async () => {
  node("plan").focus();
  await press("Enter");
  node("build").focus();
  await press("Escape");
  expect(dialog()).toBeNull();
});

it("keeps step details when leaving full screen by button or Escape", async () => {
  const button = (label: string) => Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
  node("build").focus();
  await press("Enter");
  await act(async () => { button("Full screen").click(); });
  expect(button("Exit full screen")).toBeDefined();
  expect(details()).toBe("Build");
  await act(async () => { button("Exit full screen").click(); });
  expect(button("Full screen")).toBeDefined();
  expect(details()).toBe("Build");
  await act(async () => { button("Full screen").click(); });
  node("build").focus();
  await press("Escape");
  expect(dialog()).not.toBeNull();
  expect(button("Full screen")).toBeDefined();
  expect(details()).toBe("Build");
});

it("shows the task, its loop-backs and history, and what a selected step received and produced", async () => {
  const at = new Date().toISOString();
  const step = (over: object = {}) => ({ startedAt: at, finishedAt: null, feedback: null, output: null, waitingReason: null, reports: [], threads: [], ...over });
  mocks.workflow = {
    title: "Fix login",
    workflow: DEFAULT_WORKFLOW,
    live: { review: { status: "running", phase: null, reported: 0, agents: 1, waitingKind: null, retrying: false, attempts: 1, round: 2 } },
    task: { repo: "acme/app", issueNumber: 12, issueUrl: "https://github.com/acme/app/issues/12", body: "Login breaks on Safari", status: "agent", branch: "cos/issue-12", prNumber: null, prUrl: null, threadId: "thr_1", waitingReason: null, lastError: null, createdAt: at, lastActivityAt: at, finishedAt: null },
    steps: { build: step({ reports: [{ agent: 0, outcome: "done", summary: "Added the null check", at }] }), review: step({ feedback: "Review failed:\n\nMissing a null check" }) },
    journal: [
      { id: 0, at, step: "review", round: 1, kind: "started", detail: null, actor: "tool:thr_2" },
      { id: 1, at, step: "review", round: 1, kind: "failed", from: "review", to: "build", detail: "Missing a null check", actor: "tool:thr_2" },
      { id: 2, at, step: "build", round: 2, kind: "passed", detail: null, actor: "tool:thr_1" },
    ],
  };
  await act(async () => { root.render(<PipelineTab />); });
  const overview = dialog()!.querySelector<HTMLElement>('[aria-label="Task overview"]')!;
  expect(overview.textContent).toContain("Login breaks on Safari");
  expect(overview.textContent).toContain("Review failed, sent back to Build");
  expect(dialog()!.querySelector('[aria-label="Task summary"]')!.textContent).toContain("Loop-backs1");
  expect(document.querySelector('.react-flow__edge[data-id="fail:review:build"]')?.textContent ?? document.body.textContent).toContain("on fail ×1");

  node("review").focus();
  await press("Enter");
  const panel = dialog()!.querySelector<HTMLElement>('[aria-label="Step details"]')!;
  expect(panel.textContent).toContain("Missing a null check");
  expect(panel.textContent).toContain("From Build");
  expect(panel.textContent).toContain("Added the null check");
  expect(panel.textContent).toContain("Failures1 (limit 2)");
});

it("loads the whole text of a long history entry when it is expanded", async () => {
  const at = new Date().toISOString();
  mocks.call.mockReset().mockResolvedValue({ detail: "1 failing\n\nthe whole log" });
  mocks.workflow = {
    title: "Fix login", workflow: DEFAULT_WORKFLOW, live: {},
    journal: [{ id: 9, at, step: "review", round: 1, kind: "failed", from: "review", to: "build", detail: "…the end of the log", truncated: true, actor: "tool:thr_2" }],
  };
  await act(async () => { root.render(<PipelineTab />); });
  const entry = dialog()!.querySelector<HTMLDetailsElement>('[aria-label="Task overview"] li details')!;
  await act(async () => { entry.open = true; entry.dispatchEvent(new Event("toggle")); });
  expect(mocks.call).toHaveBeenCalledWith("cos_journal_detail", { itemId: "one", id: 9 });
  expect(entry.textContent).toContain("the whole log");
  expect(entry.textContent).not.toContain("Loading");
});
