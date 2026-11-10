// @vitest-environment jsdom
// The real canvas inside the real workflow sheet: Escape on a step must reach the sheet first.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import { stubReactFlowDom } from "./helpers/reactFlow";

const mocks = vi.hoisted(() => ({ entries: [] as unknown[], workflow: {} as unknown }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => ({ toThread: vi.fn() }),
  useRpc: () => ({ call: vi.fn() }),
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
