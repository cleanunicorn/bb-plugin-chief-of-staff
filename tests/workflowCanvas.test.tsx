// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import { stubReactFlowDom } from "./helpers/reactFlow";

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

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const onSelect = vi.fn();
const render = (selected: string | null) => act(async () => { root.render(<WorkflowCanvas workflow={DEFAULT_WORKFLOW} live={{ build: live({ status: "running", phase: "working" }) }} selected={selected} onSelect={onSelect} />); });
const node = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const press = (el: HTMLElement, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubReactFlowDom();
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

// Keyboard deletion. React Flow listens on the document, so the key goes to document.body, and a keyup
// follows each press: it only reacts when the key's pressed state changes.
const sendKey = (key: string) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
/** Focus an arrow and press Enter, as a keyboard user does; the keyup clears it from React Flow's pressed keys. */
const selectEdge = async (id: string) => {
  edge(id)!.focus();
  await press(edge(id)!, "Enter");
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
};
const edge = (id: string) => container.querySelector<HTMLElement>(`.react-flow__edge[data-id="${id}"]`);
const renderEditable = (onChange: (w: unknown) => void, workflow = DEFAULT_WORKFLOW, selected: string | null = "build") =>
  act(async () => { root.render(<WorkflowCanvas workflow={workflow} selected={selected} onSelect={onSelect} onChange={onChange} />); });

for (const key of ["Backspace", "Delete"]) {
  it(`${key} does not remove the selected step or its arrows`, async () => {
    const onChange = vi.fn();
    await renderEditable(onChange);
    expect(node("build").classList.contains("selected")).toBe(true);
    await sendKey(key);
    expect(onChange).not.toHaveBeenCalled();
    expect(node("build")).toBeTruthy();
    for (const id of ["next:plan:build", "next:build:review", "fail:review:build", "fail:ship:build"]) expect(edge(id)).toBeTruthy();
  });

  it(`${key} still removes a selected arrow`, async () => {
    const onChange = vi.fn();
    await renderEditable(onChange, DEFAULT_WORKFLOW, null);
    await selectEdge("next:plan:build");
    await sendKey(key);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as typeof DEFAULT_WORKFLOW;
    expect(next.steps.map((s) => s.id)).toEqual(DEFAULT_WORKFLOW.steps.map((s) => s.id));
    expect(next.steps.find((s) => s.id === "plan")!.next).toEqual([]);
    expect(next.steps.find((s) => s.id === "build")!.next).toEqual(["review"]);
  });
}

it("does not remove the arrows around a step when an arrow elsewhere is selected", async () => {
  const onChange = vi.fn();
  await renderEditable(onChange, DEFAULT_WORKFLOW, null);
  await selectEdge("next:build:review");
  await sendKey("Backspace");
  const next = onChange.mock.calls[0][0] as typeof DEFAULT_WORKFLOW;
  expect(next.steps.find((s) => s.id === "build")!.next).toEqual([]);
  expect(next.steps.find((s) => s.id === "plan")!.next).toEqual(["build"]);
  expect(next.steps.find((s) => s.id === "review")!.onFail).toBe("build");
});

it("keeps the only step on the canvas when a removal is attempted", async () => {
  const onChange = vi.fn();
  const one = { ...DEFAULT_WORKFLOW, steps: [{ ...DEFAULT_WORKFLOW.steps[1], next: [], position: undefined }] } as typeof DEFAULT_WORKFLOW;
  await renderEditable(onChange, one, "build");
  await sendKey("Backspace");
  expect(onChange).not.toHaveBeenCalled();
  expect(node("build")).toBeTruthy();
});
