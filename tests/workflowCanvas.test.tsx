// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../src/workflow";

vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("@xyflow/react/dist/style.css", () => ({}));
import { WorkflowCanvas, liveTone, selectionTarget, type LiveStatus } from "../components/cos/workflowCanvas";

const live = (extra: Partial<LiveStatus>): LiveStatus => ({ status: "pending", phase: null, reported: 0, agents: 1, waitingKind: null, retrying: false, attempts: 0, round: 1, ...extra });

it("maps a React Flow selection to the step to show", () => {
  expect(selectionTarget({ nodes: [{ id: "build" }], edges: [] })).toBe("build");
  expect(selectionTarget({ nodes: [], edges: [] })).toBeNull();
  // An arrow or several steps selected: leave the open step alone.
  expect(selectionTarget({ nodes: [], edges: [{ id: "next:plan:build" }] })).toBeUndefined();
  expect(selectionTarget({ nodes: [{ id: "plan" }, { id: "build" }], edges: [] })).toBeUndefined();
});

it("words live status the same for the canvas and the step list", () => {
  expect(liveTone(live({ status: "waiting", waitingKind: "approval" }))?.label).toBe("needs approval");
  expect(liveTone(live({ status: "waiting", waitingKind: "question" }))?.label).toBe("question");
  expect(liveTone(live({}))?.label).toBe("pending");
});

// React Flow needs these in jsdom (https://reactflow.dev/learn/advanced-use/testing).
class ResizeObserverStub {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) { this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  unobserve() {}
  disconnect() {}
}
class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? +scale : 1;
  }
}

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const onSelect = vi.fn();
const render = (selected: string | null) => act(async () => { root.render(<WorkflowCanvas workflow={DEFAULT_WORKFLOW} live={{ build: live({ status: "running", phase: "working" }) }} selected={selected} onSelect={onSelect} />); });
const node = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const press = (el: HTMLElement, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnlyStub);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return 100; } },
    offsetWidth: { configurable: true, get() { return 200; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
  document.body.append(container);
  root = createRoot(container);
  onSelect.mockReset();
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

it("selects a step with Enter and clears it with Escape, without a click", async () => {
  await render(null);
  expect(onSelect).not.toHaveBeenCalled();
  await press(node("build"), "Enter");
  expect(onSelect.mock.calls).toEqual([["build"]]);
  await render("build");
  expect(onSelect).toHaveBeenCalledTimes(1);
  await press(node("build"), "Escape");
  expect(onSelect.mock.calls).toEqual([["build"], [null]]);
});

it("does not undo a selection the parent makes", async () => {
  await render(null);
  await render("build");
  await render("plan");
  await render("build");
  await render(null);
  expect(onSelect).not.toHaveBeenCalled();
  expect(node("build").classList.contains("selected")).toBe(false);
});

it("names each step for screen readers with its type and live status", async () => {
  await render(null);
  expect(node("build").getAttribute("aria-label")).toBe("Build, Agent step, working");
  expect(node("plan").getAttribute("aria-label")).toBe("Plan, Agent step");
});
