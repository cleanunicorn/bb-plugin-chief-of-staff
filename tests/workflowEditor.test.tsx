// @vitest-environment jsdom
// The workflow editor's change handlers: each edit calls onChange with a new
// document and leaves the one it was given untouched. The canvas is replaced by
// a button that selects a step; its own handlers are not covered here.
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_DOCUMENT, DEFAULT_MODEL_INSTRUCTIONS, DEFAULT_WORKFLOW, type Step, type WorkflowsDocument } from "../src/workflow";
import { button, click, container, fields, mount, setValue, unmount } from "./dom";

vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_useRpcQuery: () => ({ data: { skills: [] }, error: null, refetch: vi.fn() }) }));
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} aria-hidden="true" /> }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({
  ...(await original<typeof import("../components/cos/workflowCanvas")>()),
  WorkflowCanvas: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <>
      <button onClick={() => onSelect("build")}>select build</button>
      <button onClick={() => onSelect("review")}>select review</button>
    </>
  ),
}));
import { WorkflowsEditor } from "../components/cos/workflowEditor";

afterEach(unmount);

/** Mount the editor on a copy of `doc`; `changed()` is the document of the last onChange. */
async function open(doc: WorkflowsDocument = DEFAULT_DOCUMENT) {
  const input = structuredClone(doc);
  const before = structuredClone(doc);
  const onChange = vi.fn<(d: WorkflowsDocument) => void>();
  await mount(<WorkflowsEditor doc={input} onChange={onChange} usedBy={{}} />);
  return {
    onChange,
    changed: () => onChange.mock.lastCall![0],
    /** The editor must build new documents, never edit the one it was given. */
    expectInputUntouched: () => expect(input).toEqual(before),
  };
}
const step = (doc: WorkflowsDocument, id: string) => doc.workflows[0]!.steps.find((s) => s.id === id)!;
const SECOND = { ...structuredClone(DEFAULT_WORKFLOW), id: "hotfix", name: "Hotfix" };

it("renames the workflow", async () => {
  const editor = await open();
  await setValue(fields("Name")[0]!, "Delivery");
  expect(editor.onChange).toHaveBeenCalledExactlyOnceWith({ default: "default", workflows: [{ ...DEFAULT_WORKFLOW, name: "Delivery" }] });
  editor.expectInputUntouched();
});

it("edits the selected step and leaves the other steps as they were", async () => {
  const editor = await open();
  await click(button("select build"));
  expect(editor.onChange).not.toHaveBeenCalled();

  await setValue(fields("Name")[1]!, "Implement");
  expect(editor.onChange).toHaveBeenCalledTimes(1);
  expect(editor.changed()).toEqual({
    default: "default",
    workflows: [{ ...DEFAULT_WORKFLOW, steps: DEFAULT_WORKFLOW.steps.map((s) => (s.id === "build" ? { ...s, name: "Implement" } : s)) }],
  });

  await click(button("Needs my approval"));
  expect(step(editor.changed(), "build")).toEqual({ ...step(DEFAULT_DOCUMENT, "build"), approval: true });
  editor.expectInputUntouched();
});

it("turning off the verdict of a step also drops its fail arrow", async () => {
  const editor = await open();
  await click(button("select review"));
  expect(step(DEFAULT_DOCUMENT, "review")).toMatchObject({ verdict: true, onFail: "build" });
  await click(button("Pass / fail verdict"));
  const review = step(editor.changed(), "review") as Extract<Step, { type: "agent" }>;
  expect([review.verdict, review.onFail]).toEqual([false, undefined]);
  editor.expectInputUntouched();
});

it("removes a step together with the arrows that pointed at it", async () => {
  const editor = await open();
  await click(button("select build"));
  await click(button("Remove Build"));
  expect(editor.onChange).not.toHaveBeenCalled();
  await click(button("Remove"));

  const steps = editor.changed().workflows[0]!.steps;
  expect(steps.map((s) => s.id)).toEqual(["plan", "review", "ship"]);
  expect(steps.map((s) => s.next)).toEqual([[], ["ship"], []]);
  expect(steps.map((s) => s.onFail)).toEqual([undefined, undefined, undefined]);
  editor.expectInputUntouched();
});

it("adds a step at the end from the list view", async () => {
  const editor = await open();
  await click(button("List"));
  await click(button("Check step at the end"));

  const steps = editor.changed().workflows[0]!.steps;
  expect(steps.map((s) => s.id)).toEqual(["plan", "build", "review", "ship", "new-check"]);
  expect(steps.at(-1)).toMatchObject({ id: "new-check", name: "New check", type: "check", next: [] });
  expect(step(editor.changed(), "ship").next).toEqual(["new-check"]);
  editor.expectInputUntouched();
});

it("adds a new workflow from the built-in default and a copy of the current one", async () => {
  const editor = await open({ default: "hotfix", workflows: [SECOND] });
  await click(button("New"));
  expect(editor.onChange).toHaveBeenCalledExactlyOnceWith({ default: "hotfix", workflows: [SECOND, { ...DEFAULT_WORKFLOW, id: "new-workflow", name: "New workflow" }] });
  // A copy, so editing the new workflow cannot change the built-in default.
  expect(editor.changed().workflows[1]!.steps).not.toBe(DEFAULT_WORKFLOW.steps);

  await click(button("Duplicate"));
  expect(editor.changed()).toEqual({ default: "hotfix", workflows: [SECOND, { ...SECOND, id: "hotfix-copy", name: "Hotfix (copy)" }] });
  editor.expectInputUntouched();
});

it("makes another workflow the default, and deletes one after confirmation", async () => {
  const editor = await open({ default: "default", workflows: [DEFAULT_WORKFLOW, SECOND] });
  // The default workflow cannot be deleted.
  expect(container.querySelector('[aria-label^="Delete "]')).toBeNull();

  await click(button("Hotfix"));
  await click(button("Make default"));
  expect(editor.onChange).toHaveBeenCalledExactlyOnceWith({ default: "hotfix", workflows: [DEFAULT_WORKFLOW, SECOND] });

  await click(container.querySelector('[aria-label^="Delete Hotfix"]')!);
  expect(editor.onChange).toHaveBeenCalledTimes(1);
  await click(button("Remove"));
  expect(editor.changed()).toEqual({ default: "default", workflows: [DEFAULT_WORKFLOW] });
  editor.expectInputUntouched();
});

it("adds a model step that picks automatically, and switches it to fixed values", async () => {
  const editor = await open();
  await click(button("List"));
  await click(button("Model step at the end"));
  const doc = editor.changed();
  expect(doc.workflows[0]!.steps.at(-1)).toMatchObject({ id: "new-model", type: "model", mode: "auto", instructions: DEFAULT_MODEL_INSTRUCTIONS });

  // Re-render with the new document (the parent owns it) and open the step's panel.
  await mount(<WorkflowsEditor doc={doc} onChange={editor.onChange} usedBy={{}} />);
  await click(Array.from(container.querySelectorAll("button[aria-expanded]")).at(-1)!);
  expect(container.textContent).toContain("An agent reads the task and your instructions");
  expect(fields("Model")).toEqual([]);

  await setValue(fields("How the model is chosen")[0]!, "fixed");
  // The default choosing text goes: a fixed step chooses nothing.
  expect(editor.changed().workflows[0]!.steps.at(-1)).toMatchObject({ type: "model", mode: "fixed", instructions: "" });
  editor.expectInputUntouched();
  // Re-rendered fixed (its panel stays open), its text is notes that no agent sees.
  await mount(<WorkflowsEditor doc={editor.changed()} onChange={editor.onChange} usedBy={{}} />);
  expect(container.textContent).toContain("No agent sees them.");
  expect(fields("Model")).toHaveLength(1);
});

it("keeps edited choosing instructions when an automatic model step is switched to fixed", async () => {
  const doc: WorkflowsDocument = { default: "w", workflows: [{ id: "w", name: "W", steps: [
    { id: "pick", name: "Pick", type: "model", mode: "auto", instructions: "Prefer Claude for UI work.", next: ["build"] } as Step,
    { ...step(DEFAULT_DOCUMENT, "build"), next: [] },
  ] }] };
  const editor = await open(doc);
  await click(button("List"));
  await click(Array.from(container.querySelectorAll("button[aria-expanded]"))[0]!);
  await setValue(fields("How the model is chosen")[0]!, "fixed");
  expect(step(editor.changed(), "pick")).toMatchObject({ mode: "fixed", instructions: "Prefer Claude for UI work." });
  editor.expectInputUntouched();
});

it("drops the default choosing text when an automatic model step becomes another type", async () => {
  const doc: WorkflowsDocument = { default: "w", workflows: [{ id: "w", name: "W", steps: [
    { id: "pick", name: "Pick", type: "model", mode: "auto", instructions: DEFAULT_MODEL_INSTRUCTIONS, next: ["build"] } as Step,
    { ...step(DEFAULT_DOCUMENT, "build"), next: [] },
  ] }] };
  const editor = await open(doc);
  await click(button("List"));
  await click(Array.from(container.querySelectorAll("button[aria-expanded]"))[0]!);
  await setValue(fields("Type")[0]!, "agent");
  expect(step(editor.changed(), "pick")).toMatchObject({ type: "agent", instructions: "" });
  editor.expectInputUntouched();
});

it("keeps a model step saved before modes existed fixed while its last value is cleared", async () => {
  const legacy: WorkflowsDocument = { default: "w", workflows: [{ id: "w", name: "W", steps: [
    { id: "pin", name: "Pin", type: "model", instructions: "", next: ["build"], providerId: "claude-code" } as Step,
    { ...step(DEFAULT_DOCUMENT, "build"), next: [] },
  ] }] };
  const editor = await open(legacy);
  await click(button("List"));
  await click(Array.from(container.querySelectorAll("button[aria-expanded]"))[0]!);
  await setValue(fields("Agent (provider)")[0]!, "");
  const pin = step(editor.changed(), "pin");
  expect(pin).toMatchObject({ type: "model", mode: "fixed", providerId: undefined });
  editor.expectInputUntouched();
});

/** An editor that applies its own changes, as the configurator does. */
function Stateful({ initial, usedBy = {}, onDelete }: { initial: WorkflowsDocument; usedBy?: Record<string, string[]>; onDelete?: (id: string) => void }) {
  const [doc, setDoc] = useState(initial);
  return <WorkflowsEditor doc={doc} onChange={setDoc} usedBy={usedBy} onDelete={onDelete} />;
}

it("does not carry an armed Remove? from one selected step to the next", async () => {
  await mount(<Stateful initial={DEFAULT_DOCUMENT} />);
  await click(button("select build"));
  await click(button("Remove Build"));
  expect(container.textContent).toContain("Remove?");
  await click(button("select review"));
  expect(container.textContent).not.toContain("Remove?");
  expect(button("Remove Review")).toBeTruthy();
});

it("keeps each model choice's confirmation with that choice when another is removed", async () => {
  const doc = structuredClone(DEFAULT_DOCUMENT);
  const build = step(doc, "build") as Extract<Step, { type: "agent" }>;
  build.chooses = [{ id: "small", when: "small change" }, { id: "large", when: "large change" }];
  await mount(<Stateful initial={doc} />);
  await click(button("select build"));
  // Arm "large", then remove "small": "large" moves up and must still be the armed one.
  await click(button("Remove choice large"));
  await click(button("Remove choice small"));
  await click(button("Remove"));
  expect(() => button("Remove choice small")).toThrow();
  expect(() => button("Remove choice large")).toThrow();
  expect(container.textContent).toContain("Remove?");
});

it("names the repositories that fall back to the default before deleting a workflow, then reports the deletion", async () => {
  const onDelete = vi.fn();
  await mount(<Stateful initial={{ default: "default", workflows: [DEFAULT_WORKFLOW, SECOND] }} usedBy={{ hotfix: ["acme/app", "acme/api"] }} onDelete={onDelete} />);
  await click(button("Hotfix"));
  expect(container.textContent).not.toContain("will use the default workflow");
  await click(button("Delete Hotfix"));
  expect(container.textContent).toContain("acme/app, acme/api will use the default workflow.");
  await click(button("Remove"));
  expect(onDelete).toHaveBeenCalledExactlyOnceWith("hotfix");
});

it("deletes an unused workflow without a notice", async () => {
  await mount(<Stateful initial={{ default: "default", workflows: [DEFAULT_WORKFLOW, SECOND] }} />);
  await click(button("Hotfix"));
  await click(button("Delete Hotfix"));
  expect(container.textContent).not.toContain("will use the default workflow");
});
