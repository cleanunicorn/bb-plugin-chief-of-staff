// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW, insertStepAfter, workflowSchema, type Step } from "../src/workflow";
import { stubReactFlowDom } from "./helpers/reactFlow";

vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("@xyflow/react/dist/style.css", () => ({}));
import { WorkflowCanvas, layout, liveTone, placeNewStep, selectionTarget, type LiveStatus } from "../components/cos/workflowCanvas";

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

// Adding a step (#122): it goes below the step it follows, and the steps after it make room.
const COL = 320, ROW = 130;
const tidied = (wf: typeof DEFAULT_WORKFLOW) => {
  const at = layout(wf, true);
  return { ...wf, steps: wf.steps.map((s) => ({ ...s, position: at.get(s.id) }) as Step) };
};
const expectNoOverlap = (wf: typeof DEFAULT_WORKFLOW) => {
  const at = [...layout(wf)];
  for (const [i, [a, p]] of at.entries()) for (const [b, q] of at.slice(i + 1)) expect({ a, b, overlap: Math.abs(p.x - q.x) < COL && Math.abs(p.y - q.y) < ROW }).toEqual({ a, b, overlap: false });
};

for (const [label, wf] of [["every step placed (after Tidy)", tidied(SIX_STEPS)], ["no step placed", SIX_STEPS]] as const) {
  it(`places a step inserted mid-flow directly below the one it follows, with ${label}`, () => {
    const { workflow, id } = insertStepAfter(wf, "agent", "build");
    const placed = placeNewStep(workflow, id);
    expectNoOverlap(placed);
    const at = layout(placed);
    expect(at.get(id)).toEqual({ x: at.get("build")!.x, y: at.get("build")!.y + ROW });
    // Steps before it stay where they were.
    for (const before of ["model", "plan", "review-plan", "build"]) expect(at.get(before)).toEqual(layout(wf).get(before));
  });
}

it("moves a new step aside when the spot below the step it follows is taken by a parallel branch", () => {
  const branches = tidied(workflowSchema.parse({
    id: "b",
    name: "b",
    steps: [
      { id: "a", name: "A", type: "agent", next: ["b", "c"] },
      { id: "b", name: "B", type: "agent" },
      { id: "c", name: "C", type: "agent", next: ["d"] },
      { id: "d", name: "D", type: "agent" },
    ],
  }));
  const { workflow, id } = insertStepAfter(branches, "agent", "b");
  expectNoOverlap(placeNewStep(workflow, id));
});

it("makes room below a step without a stored position when later steps have one", () => {
  // The old toolbar stored a position on the added step only, so saved workflows mix placed and unplaced steps.
  const mixed = { ...SIX_STEPS, steps: SIX_STEPS.steps.map((s) => (s.id === "ship" ? ({ ...s, position: { x: 0, y: 5 * ROW } } as Step) : s)) };
  const { workflow, id } = insertStepAfter(mixed, "agent", "build");
  const placed = placeNewStep(workflow, id);
  expectNoOverlap(placed);
  expect(layout(placed).get(id)).toEqual({ x: 0, y: 4 * ROW });
});

it("does not move a later step onto a parallel branch", () => {
  const branches = tidied(workflowSchema.parse({
    id: "b",
    name: "b",
    steps: [
      { id: "a", name: "A", type: "agent", next: ["b", "c"] },
      { id: "b", name: "B", type: "agent", next: ["d"] },
      { id: "c", name: "C", type: "agent", next: ["e"] },
      { id: "d", name: "D", type: "agent" },
      { id: "e", name: "E", type: "agent", next: ["f"] },
      { id: "f", name: "F", type: "agent" },
    ],
  }));
  const { workflow, id } = insertStepAfter(branches, "agent", "b");
  const placed = placeNewStep(workflow, id);
  expectNoOverlap(placed);
  expect(layout(placed).get(id)).toEqual({ x: 0, y: 2 * ROW });
});

/** The editor around the canvas: it holds the workflow and the selection, as the canvas is controlled. */
let current: typeof DEFAULT_WORKFLOW;
function Editor({ workflow, selected = null }: { workflow: typeof DEFAULT_WORKFLOW; selected?: string | null }) {
  const [wf, setWf] = useState(workflow);
  const [sel, setSel] = useState(selected);
  current = wf;
  return <WorkflowCanvas workflow={wf} onChange={setWf} selected={sel} onSelect={setSel} />;
}
const expectInView = (id: string) => {
  const { x, y, zoom } = viewport();
  const p = layout(current).get(id)!;
  const left = x + p.x * zoom, top = y + p.y * zoom;
  expect({ left: left >= 0, top: top >= 0, right: left + 200 * zoom <= PANE.width, bottom: top + 100 * zoom <= PANE.height }).toEqual({ left: true, top: true, right: true, bottom: true });
};

for (const [label, selected] of [["at the end", null], ["after the selected step", "review"]] as const) {
  it(`brings a step added ${label} into view, keeping the zoom`, async () => {
    await act(async () => { root.render(<Editor workflow={SIX_STEPS} selected={selected} />); });
    await settle();
    const zoom = viewport().zoom;
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label^="Add Agent step"]')!.click(); });
    await settle(400);
    expect(current.steps.at(-1)!.id).toBe("new-agent");
    expect(current.steps.find((s) => s.next.includes("new-agent"))!.id).toBe(selected ?? "ship");
    expectInView("new-agent");
    expect(viewport().zoom).toBeCloseTo(zoom, 3);
  });
}

it("pans to a step added after a selected step that is out of view, keeping the zoom", async () => {
  await act(async () => { root.render(<Editor workflow={SIX_STEPS} selected="ship" />); });
  await settle();
  for (let i = 0; i < 4; i++) {
    await act(async () => { container.querySelector<HTMLButtonElement>(".react-flow__controls-zoomin")!.click(); });
    await settle(400);
  }
  const zoom = viewport().zoom;
  // Zoomed in on the middle of the flow: the step after Ship starts outside the pane.
  const before = viewport();
  const below = { x: 0, y: layout(SIX_STEPS).get("ship")!.y + 130 };
  expect(before.y + below.y * zoom > PANE.height).toBe(true);
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label^="Add Check step"]')!.click(); });
  await settle(400);
  expect(layout(current).get("new-check")).toEqual(below);
  expectInView("new-check");
  expect(viewport().zoom).toBeCloseTo(zoom, 3);
});

it("keeps steps apart when inserting among dragged, off-grid positions", () => {
  const offsets: Record<string, { x: number; y: number }> = { model: { x: 13, y: -7 }, plan: { x: -40, y: 6 }, "review-plan": { x: 55, y: 9 }, build: { x: 7, y: 33 }, review: { x: -18, y: 41 }, ship: { x: 90, y: 57 } };
  const base = tidied(SIX_STEPS);
  const dragged = { ...base, steps: base.steps.map((s) => ({ ...s, position: { x: s.position!.x + offsets[s.id]!.x, y: s.position!.y + offsets[s.id]!.y } }) as Step) };
  expectNoOverlap(dragged);
  for (const after of ["plan", "build", "review", null]) {
    const { workflow, id } = insertStepAfter(dragged, "agent", after);
    expectNoOverlap(placeNewStep(workflow, id));
  }
});
