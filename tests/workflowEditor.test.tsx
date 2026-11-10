// @vitest-environment jsdom
// Workflow editor change handlers: every edit goes through onChange with a new
// document and leaves the one it was given untouched.
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkflowCanvasProps } from "../components/cos/workflowCanvas";

vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_useRpcQuery: () => ({ data: null, error: null, refetch: vi.fn() }) }));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
// The canvas is React Flow; stand in a button that selects the first step.
vi.mock("../components/cos/workflowCanvas", async (original) => ({
  ...(await original()),
  WorkflowCanvas: ({ workflow, onSelect }: WorkflowCanvasProps) => (
    <button type="button" onClick={() => onSelect?.(workflow.steps[0]!.id)}>
      select first step
    </button>
  ),
}));
import { StepPanel, WorkflowsEditor } from "../components/cos/workflowEditor";
import { DEFAULT_DOCUMENT, DEFAULT_WORKFLOW, type Workflow, type WorkflowsDocument } from "../src/workflow";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(content: ReactNode) {
  await act(async () => { root.render(content); });
}
const button = (label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
function fields(label: string): HTMLInputElement[] {
  return Array.from(container.querySelectorAll("label")).filter((l) => l.textContent === label).map((l) => document.getElementById(l.htmlFor) as HTMLInputElement);
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el: Element | null | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => { (el as HTMLElement).click(); });
}
function twoWorkflows(): WorkflowsDocument {
  const second: Workflow = { ...structuredClone(DEFAULT_WORKFLOW), id: "hotfix", name: "Hotfix" };
  return { workflows: [structuredClone(DEFAULT_WORKFLOW), second], default: DEFAULT_WORKFLOW.id };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

it("renames the selected workflow", async () => {
  const doc = structuredClone(DEFAULT_DOCUMENT);
  const before = structuredClone(doc);
  const onChange = vi.fn();
  await render(<WorkflowsEditor doc={doc} onChange={onChange} usedBy={{}} />);
  await type(fields("Name")[0]!, "Release flow");
  const next: WorkflowsDocument = onChange.mock.lastCall![0];
  expect(next).toEqual({ ...before, workflows: [{ ...before.workflows[0]!, name: "Release flow" }] });
  expect(doc).toEqual(before);
});

it("adds a new workflow as a copy of the default steps", async () => {
  const doc = structuredClone(DEFAULT_DOCUMENT);
  const before = structuredClone(doc);
  const onChange = vi.fn();
  await render(<WorkflowsEditor doc={doc} onChange={onChange} usedBy={{}} />);
  await click(button("New"));
  const next: WorkflowsDocument = onChange.mock.lastCall![0];
  expect(next.default).toBe(DEFAULT_WORKFLOW.id);
  expect(next.workflows.map((w) => [w.id, w.name])).toEqual([[DEFAULT_WORKFLOW.id, DEFAULT_WORKFLOW.name], ["new-workflow", "New workflow"]]);
  expect(next.workflows[1]!.steps).toEqual(DEFAULT_WORKFLOW.steps);
  expect(next.workflows[1]!.steps).not.toBe(DEFAULT_WORKFLOW.steps);
  expect(doc).toEqual(before);
});

it("removes a non-default workflow after confirmation", async () => {
  const doc = twoWorkflows();
  const before = structuredClone(doc);
  const onChange = vi.fn();
  await render(<WorkflowsEditor doc={doc} onChange={onChange} usedBy={{ hotfix: ["acme/app"] }} />);
  await click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Hotfix")));
  await click(container.querySelector('[aria-label="Delete Hotfix (repos using it fall back to the default)"]'));
  expect(onChange).not.toHaveBeenCalled();
  await click(button("Remove"));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.lastCall![0]).toEqual({ ...before, workflows: [before.workflows[0]] });
  expect(doc).toEqual(before);
});

it("edits a step selected on the canvas through the step panel", async () => {
  const doc = structuredClone(DEFAULT_DOCUMENT);
  const before = structuredClone(doc);
  const onChange = vi.fn();
  await render(<WorkflowsEditor doc={doc} onChange={onChange} usedBy={{}} />);
  await click(button("select first step"));
  // Workflow name first, then the step's name.
  await type(fields("Name")[1]!, "Investigate");
  const next: WorkflowsDocument = onChange.mock.lastCall![0];
  const steps = before.workflows[0]!.steps;
  expect(next.workflows[0]!.steps).toEqual([{ ...steps[0]!, name: "Investigate" }, ...steps.slice(1)]);
  expect(doc).toEqual(before);
});

it("StepPanel toggles a next step and changes the fail target", async () => {
  const workflow = structuredClone(DEFAULT_WORKFLOW);
  const review = workflow.steps.find((s) => s.id === "review")!;
  const before = structuredClone(review);
  const onChange = vi.fn();
  await render(<StepPanel workflow={workflow} step={review} onChange={onChange} onRemove={() => {}} />);
  await click(container.querySelector('button[aria-pressed="false"]'));
  expect(onChange.mock.lastCall![0]).toEqual({ ...before, next: ["ship", "plan"] });
  const failTarget = fields("On fail, go back to")[0]! as unknown as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(failTarget, "plan");
    failTarget.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange.mock.lastCall![0]).toEqual({ ...before, onFail: "plan" });
  expect(review).toEqual(before);
});

it("StepPanel removes the step only after confirmation", async () => {
  const workflow = structuredClone(DEFAULT_WORKFLOW);
  const onRemove = vi.fn();
  await render(<StepPanel workflow={workflow} step={workflow.steps[0]!} onChange={() => {}} onRemove={onRemove} />);
  await click(container.querySelector('[aria-label="Remove Plan"]'));
  expect(onRemove).not.toHaveBeenCalled();
  await click(button("Remove"));
  expect(onRemove).toHaveBeenCalledTimes(1);
});
