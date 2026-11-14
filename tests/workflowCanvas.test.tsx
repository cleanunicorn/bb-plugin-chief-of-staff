// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW, blankStep, workflowSchema } from "../src/workflow";
import { stubReactFlowDom } from "./helpers/reactFlow";

vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("@xyflow/react/dist/style.css", () => ({}));
import { WorkflowCanvas, inView, layout, liveTone, selectionTarget, type LiveStatus } from "../components/cos/workflowCanvas";

const live = (extra: Partial<LiveStatus>): LiveStatus => ({ status: "pending", phase: null, reported: 0, agents: 1, waitingKind: null, retrying: false, attempts: 0, round: 1, ...extra });

it("maps a React Flow selection to the step to show", () => {
  expect(selectionTarget({ nodes: [{ id: "build" }], edges: [] })).toBe("build");
  expect(selectionTarget({ nodes: [], edges: [] })).toBeNull();
  // An arrow or several steps selected: leave the open step alone.
  expect(selectionTarget({ nodes: [], edges: [{ id: "next:plan:build" }] })).toBeUndefined();
  expect(selectionTarget({ nodes: [{ id: "plan" }, { id: "build" }], edges: [] })).toBeUndefined();
});

it("tells whether a step is fully inside the canvas at the current pan and zoom", () => {
  const frame = { width: 400, height: 300 };
  const step = { x: 100, y: 100, width: 200, height: 60 };
  expect(inView(step, { x: 0, y: 0, zoom: 1 }, frame)).toBe(true);
  // Pushed past the bottom edge by panning, or cut off by zooming in.
  expect(inView(step, { x: 0, y: 200, zoom: 1 }, frame)).toBe(false);
  expect(inView(step, { x: 0, y: 0, zoom: 2 }, frame)).toBe(false);
  expect(inView({ ...step, y: 600 }, { x: 0, y: 0, zoom: 0.5 }, frame)).toBe(false);
  expect(inView({ ...step, y: 400 }, { x: 0, y: 0, zoom: 0.5 }, frame)).toBe(true);
});

it("words live status the same for the canvas and the step list", () => {
  expect(liveTone(live({ status: "waiting", waitingKind: "approval" }))?.label).toBe("needs approval");
  expect(liveTone(live({ status: "waiting", waitingKind: "question" }))?.label).toBe("question");
  expect(liveTone(live({}))?.label).toBe("pending");
});

it("draws a step a finished task left behind as stopped, not live", () => {
  expect(liveTone(live({ status: "stopped" }))).toEqual({ color: "var(--muted-foreground)", label: "stopped" });
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

it("marks the steps with problems and names the count for screen readers", async () => {
  await act(async () => { root.render(<WorkflowCanvas workflow={DEFAULT_WORKFLOW} onChange={vi.fn()} problems={{ review: 2 }} selected={null} onSelect={onSelect} />); });
  expect(node("review").getAttribute("aria-label")).toBe("Review, Agent step, 2 to fix");
  expect(node("review").querySelector("[data-problems]")?.textContent).toBe("2");
  expect(node("plan").getAttribute("aria-label")).toBe("Plan, Agent step");
  expect(node("plan").querySelector("[data-problems]")).toBeNull();
});

it("keeps a step the parent selects together with a new workflow", async () => {
  const wider = { ...DEFAULT_WORKFLOW, id: "other", steps: [...DEFAULT_WORKFLOW.steps, blankStep("check", "new-check", "New check")] };
  await act(async () => { root.render(<WorkflowCanvas workflow={DEFAULT_WORKFLOW} onChange={vi.fn()} selected={null} onSelect={onSelect} />); });
  await act(async () => { root.render(<WorkflowCanvas workflow={wider} onChange={vi.fn()} selected="new-check" onSelect={onSelect} />); });
  expect(onSelect).not.toHaveBeenCalled();
  expect(node("new-check").classList.contains("selected")).toBe(true);
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

// Fitting (#97). The DOM stub makes the pane and every node 200 × 100, so a six-row graph is about 200 × 750
// and only fits below React Flow's default 0.5 zoom floor.
const SIX_STEPS = workflowSchema.parse({
  id: "six",
  name: "Six steps",
  steps: [
    { id: "model", name: "Select model", type: "model", mode: "auto", instructions: "Pick one.", next: ["plan"] },
    { id: "plan", name: "Plan", type: "agent", next: ["review-plan"] },
    { id: "review-plan", name: "Review plan", type: "agent", verdict: true, next: ["build"] },
    { id: "build", name: "Build", type: "agent", next: ["review"] },
    { id: "review", name: "Review implementation", type: "agent", verdict: true, onFail: "build", next: ["ship"] },
    { id: "ship", name: "Ship", type: "ship" },
  ],
});
/** Parallel review branches after Build, joined again at Ship. */
const PARALLEL = workflowSchema.parse({
  id: "parallel",
  name: "Parallel",
  steps: [
    { id: "plan", name: "Plan", type: "agent", next: ["build"] },
    { id: "build", name: "Build", type: "agent", next: ["review", "docs"] },
    { id: "review", name: "Review", type: "agent", verdict: true, onFail: "build", next: ["ship"] },
    { id: "docs", name: "Docs", type: "agent", next: ["ship"] },
    { id: "ship", name: "Ship", type: "ship" },
  ],
});
const PANE = { width: 200, height: 100 };
const MARGIN = 5;
const viewport = () => {
  const m = container.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform.match(/translate\((-?[\d.]+)px, ?(-?[\d.]+)px\) scale\(([\d.]+)\)/)!;
  return { x: +m[1], y: +m[2], zoom: +m[3] };
};
/** Every step lies inside the pane with some margin at the current viewport. */
const expectAllInView = (wf: typeof DEFAULT_WORKFLOW) => {
  const { x, y, zoom } = viewport();
  for (const [id, p] of layout(wf)) {
    const left = x + p.x * zoom, top = y + p.y * zoom;
    const right = left + 200 * zoom, bottom = top + 100 * zoom;
    expect({ id, left: left >= MARGIN, top: top >= MARGIN, right: right <= PANE.width - MARGIN, bottom: bottom <= PANE.height - MARGIN }).toEqual({ id, left: true, top: true, right: true, bottom: true });
  }
};
const zoomOut = () => container.querySelector<HTMLButtonElement>(".react-flow__controls-zoomout")!;
const settle = (ms = 50) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const pressFit = async () => {
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Fit all steps in view"]')!.click(); });
  await settle(400); // the button animates for 200 ms
};

for (const [label, wf, editable] of [
  ["six sequential steps", SIX_STEPS, false],
  ["parallel review branches", PARALLEL, false],
  ["six sequential steps in the editor", SIX_STEPS, true],
] as const) {
  it(`fits ${label} wholly in view on opening and after Fit, with Zoom Out still enabled`, async () => {
    await act(async () => {
      root.render(<WorkflowCanvas workflow={wf} selected={null} onSelect={onSelect} onChange={editable ? vi.fn() : undefined} />);
    });
    await settle(); // the opening fit waits for the steps to be measured
    expectAllInView(wf);
    expect(zoomOut().disabled).toBe(false);
    const opened = viewport();
    await pressFit();
    expectAllInView(wf);
    expect(zoomOut().disabled).toBe(false);
    const fitted = viewport();
    expect(fitted.zoom).toBeCloseTo(opened.zoom, 3);
    expect(fitted.x).toBeCloseTo(opened.x, 1);
    expect(fitted.y).toBeCloseTo(opened.y, 1);
  });
}
