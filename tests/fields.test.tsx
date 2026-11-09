// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmRemove, Field, ListInput, NumberInput, Problems, Select, Switch, TextInput, ToggleRow } from "../components/cos/fields";
import { blur, button, click, container, field, mount, setValue, unmount } from "./dom";

vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} aria-hidden="true" /> }));

afterEach(unmount);

it("Field ties its label to the control and shows the error instead of the hint", async () => {
  const onChange = vi.fn();
  await mount(<Field label="Model" hint="Empty uses the default.">{(id) => <TextInput id={id} value="opus" onChange={onChange} />}</Field>);
  expect((field("Model") as HTMLInputElement).value).toBe("opus");
  expect(container.textContent).toContain("Empty uses the default.");
  await setValue(field("Model"), "sonnet");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("sonnet");

  await mount(<Field label="Model" hint="Empty uses the default." error="Unknown model">{(id) => <TextInput id={id} value="opus" onChange={onChange} />}</Field>);
  expect(container.textContent).toContain("Unknown model");
  expect(container.textContent).not.toContain("Empty uses the default.");
});

it("NumberInput exposes its range, rounds what is typed and ignores an empty box", async () => {
  const onChange = vi.fn();
  await mount(<NumberInput id="n" value={3} min={1} max={10} onChange={onChange} />);
  const input = container.querySelector<HTMLInputElement>("#n")!;
  expect([input.type, input.min, input.max, input.value]).toEqual(["number", "1", "10", "3"]);

  await setValue(input, "7.6");
  expect(onChange).toHaveBeenCalledExactlyOnceWith(8);

  onChange.mockClear();
  await setValue(input, "");
  expect(onChange).not.toHaveBeenCalled();
  expect(input.value).toBe("");
  // Leaving the box empty puts the current value back.
  await blur(input);
  expect(input.value).toBe("3");
});

it("NumberInput follows a value changed from outside", async () => {
  await mount(<NumberInput id="n" value={3} onChange={() => {}} />);
  await mount(<NumberInput id="n" value={9} onChange={() => {}} />);
  expect(container.querySelector<HTMLInputElement>("#n")!.value).toBe("9");
});

it("ListInput parses the list, keeps the raw text while typing and tidies it on blur", async () => {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(["bug"]);
    return <ListInput id="l" value={value} onChange={(v) => { onChange(v); setValue(v); }} />;
  }
  await mount(<Harness />);
  const input = container.querySelector<HTMLInputElement>("#l")!;
  expect(input.value).toBe("bug");

  await setValue(input, "a, b ,,c,");
  expect(onChange).toHaveBeenLastCalledWith(["a", "b", "c"]);
  expect(input.value).toBe("a, b ,,c,");
  await blur(input);
  expect(input.value).toBe("a, b, c");

  await setValue(input, "");
  expect(onChange).toHaveBeenLastCalledWith([]);
});

it("ListInput follows a value changed from outside", async () => {
  await mount(<ListInput id="l" value={["a"]} onChange={() => {}} />);
  await mount(<ListInput id="l" value={["x", "y"]} onChange={() => {}} />);
  expect(container.querySelector<HTMLInputElement>("#l")!.value).toBe("x, y");
});

it("Select lists its options and reports the chosen value", async () => {
  const onChange = vi.fn();
  await mount(<Select id="s" value="squash" onChange={onChange} options={[{ value: "squash", label: "Squash" }, { value: "rebase", label: "Rebase" }]} />);
  const select = container.querySelector<HTMLSelectElement>("#s")!;
  expect(select.value).toBe("squash");
  expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([["squash", "Squash"], ["rebase", "Rebase"]]);
  await setValue(select, "rebase");
  expect(onChange).toHaveBeenCalledExactlyOnceWith("rebase");
});

it("Switch reports the opposite of its state and does nothing when disabled", async () => {
  const onChange = vi.fn();
  await mount(<Switch checked={false} onChange={onChange} label="Notify" />);
  const off = container.querySelector('[role="switch"]')!;
  expect([off.getAttribute("aria-checked"), off.getAttribute("aria-label")]).toEqual(["false", "Notify"]);
  await click(off);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true);

  onChange.mockClear();
  await mount(<Switch checked onChange={onChange} label="Notify" />);
  expect(container.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
  await click(container.querySelector('[role="switch"]')!);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(false);

  onChange.mockClear();
  await mount(<Switch checked onChange={onChange} label="Notify" disabled />);
  await click(container.querySelector('[role="switch"]')!);
  expect(onChange).not.toHaveBeenCalled();
});

it("ToggleRow shows its label and hint and toggles through its switch", async () => {
  const onChange = vi.fn();
  await mount(<ToggleRow label="Pick up issues" hint="Off: only tasks you start." checked onChange={onChange} />);
  expect(container.textContent).toBe("Pick up issuesOff: only tasks you start.");
  await click(button("Pick up issues"));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
});

it("Problems renders nothing when empty and one row per problem otherwise", async () => {
  await mount(<Problems items={[]} />);
  expect(container.innerHTML).toBe("");

  await mount(<Problems items={["first", "second"]} />);
  expect(Array.from(container.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["first", "second"]);
  expect(container.querySelectorAll('[data-icon="CircleX"]')).toHaveLength(2);

  await mount(<Problems items={["careful"]} tone="warning" />);
  expect(container.querySelectorAll('[data-icon="TriangleAlert"]')).toHaveLength(1);
});

it("ConfirmRemove removes only after the second click, and Keep backs out", async () => {
  const onConfirm = vi.fn();
  await mount(<ConfirmRemove label="Remove acme/app" onConfirm={onConfirm} />);
  await click(button("Remove acme/app"));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Remove?");

  await click(button("Keep"));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Remove?");

  await click(button("Remove acme/app"));
  await click(button("Remove"));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
