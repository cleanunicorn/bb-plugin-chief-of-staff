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
  ThreadTitle: () => null, UrlLink: () => null,
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
  mocks.call.mockReset().mockResolvedValue({});
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

const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
const confirm = () => document.querySelectorAll<HTMLElement>('[role="dialog"]')[1] ?? null;
const reruns = () => mocks.call.mock.calls.filter(([, input]) => (input as { action?: string }).action === "rerun_step");

it("asks before running a step again; Escape closes only the question", async () => {
  node("build").focus();
  await press("Enter");
  await act(async () => button("Run again from here").click());
  expect(reruns()).toHaveLength(0);
  expect(confirm()?.textContent).toContain("Run ‘Build’ again?");
  // Build is followed by Review and Ship in the default workflow.
  expect(confirm()?.textContent).toContain("This resets Build and the 2 steps after it");

  await press("Escape");
  expect(confirm()).toBeNull();
  expect(dialog()).not.toBeNull();
  expect(details()).toBe("Build");
  expect(reruns()).toHaveLength(0);

  await act(async () => button("Run again from here").click());
  await act(async () => button("Run again").click());
  expect(reruns()).toEqual([["cos_item_action", { id: "one", action: "rerun_step", step: "build" }]]);
  expect(confirm()).toBeNull();
  expect(dialog()).not.toBeNull();
});

it("sends nothing when running a step again is cancelled, and keeps the sheet as it was", async () => {
  node("ship").focus();
  await press("Enter");
  await act(async () => button("Run again from here").click());
  expect(confirm()?.textContent).toContain("This resets Ship and runs it again.");
  await act(async () => button("Cancel").click());
  expect(confirm()).toBeNull();
  expect(details()).toBe("Ship");
  expect(mocks.call).not.toHaveBeenCalled();
});
