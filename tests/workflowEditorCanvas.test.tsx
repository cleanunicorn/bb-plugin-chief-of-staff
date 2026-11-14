// @vitest-environment jsdom
// The real canvas inside the real workflow editor, holding its document like the configurator does:
// adding a step from the toolbar (#122).
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_DOCUMENT, workflowProblems, type WorkflowsDocument } from "../src/workflow";
import { button, container, mount, unmount } from "./dom";
import { stubReactFlowDom } from "./helpers/reactFlow";

vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_useRpcQuery: () => ({ data: { skills: [] }, error: null, refetch: vi.fn() }) }));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("@xyflow/react/dist/style.css", () => ({}));
import { WorkflowsEditor } from "../components/cos/workflowEditor";

let doc: WorkflowsDocument;
function Editor() {
  const [current, setCurrent] = useState(DEFAULT_DOCUMENT);
  doc = current;
  return <WorkflowsEditor doc={current} onChange={setCurrent} usedBy={{}} />;
}
const node = (id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const press = (el: HTMLElement, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const add = (label: string) => act(async () => { container.querySelector<HTMLButtonElement>(`[aria-label^="Add ${label} step"]`)!.click(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

beforeEach(async () => {
  stubReactFlowDom();
  await mount(<Editor />);
  await settle();
});
afterEach(unmount);

it("focuses the Name field of a step added from the toolbar", async () => {
  await add("Check");
  await settle(); // the canvas pans to the new step meanwhile
  const names = Array.from(container.querySelectorAll("input")).filter((i) => i.value === "New check");
  expect(names).toHaveLength(1);
  expect(document.activeElement).toBe(names[0]);
});

it("does not move focus when a step is selected from the canvas", async () => {
  node("build").focus();
  await press(node("build"), "Enter");
  expect(button("Remove Build")).toBeTruthy();
  expect(document.activeElement).toBe(node("build"));
});

it("adds a check after the selected step that writes code with no problems shown", async () => {
  node("build").focus();
  await press(node("build"), "Enter");
  await add("Check");
  const build = doc.workflows[0]!.steps.find((s) => s.id === "build")!;
  expect(build.next).toEqual(["new-check"]);
  expect(workflowProblems(doc)).toEqual([]);
  expect(container.querySelector("ul li")).toBeNull();
});
