// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmRemove, ListInput, NumberInput, Problems, Select, ToggleRow } from "../components/cos/fields";

vi.mock("../components/ui/icon", () => ({ Icon: () => null }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(content: ReactNode) {
  await act(async () => { root.render(content); });
}
async function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const button = (text: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!;

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

it("NumberInput reports rounded numbers, tolerates an empty box and restores the value on blur", async () => {
  const onChange = vi.fn();
  await render(<NumberInput value={3} min={1} max={10} onChange={onChange} />);
  const input = container.querySelector("input")!;
  expect([input.value, input.min, input.max]).toEqual(["3", "1", "10"]);
  await type(input, "7");
  expect(onChange).toHaveBeenLastCalledWith(7);
  await type(input, "2.6");
  expect(onChange).toHaveBeenLastCalledWith(3);
  onChange.mockClear();
  await type(input, "");
  expect(onChange).not.toHaveBeenCalled();
  expect(input.value).toBe("");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(input.value).toBe("3");
});

it("NumberInput follows a new value from its parent", async () => {
  await render(<NumberInput value={3} onChange={() => {}} />);
  await render(<NumberInput value={9} onChange={() => {}} />);
  expect(container.querySelector("input")!.value).toBe("9");
});

it("ListInput parses a comma list, keeps the raw text while it matches, and normalises on blur", async () => {
  const onChange = vi.fn();
  await render(<ListInput value={["a", "b"]} onChange={onChange} />);
  const input = container.querySelector("input")!;
  expect(input.value).toBe("a, b");
  await type(input, "x, y,, z ");
  expect(onChange).toHaveBeenLastCalledWith(["x", "y", "z"]);
  // The parent echoes the parsed list back: the raw text stays while typing.
  await render(<ListInput value={["x", "y", "z"]} onChange={onChange} />);
  expect(input.value).toBe("x, y,, z ");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(input.value).toBe("x, y, z");
  // A different list from the parent replaces the text.
  await render(<ListInput value={["q"]} onChange={onChange} />);
  expect(input.value).toBe("q");
});

it("Select reports the chosen option value", async () => {
  const onChange = vi.fn();
  await render(<Select value="a" onChange={onChange} options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} />);
  const select = container.querySelector("select")!;
  expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([["a", "Alpha"], ["b", "Beta"]]);
  await type(select, "b");
  expect(onChange).toHaveBeenCalledWith("b");
});

it("ToggleRow's switch reports the flipped state and is labelled", async () => {
  const onChange = vi.fn();
  await render(<ToggleRow label="Pick up issues" hint="Off: only tasks you start." checked={false} onChange={onChange} />);
  const sw = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect([sw.getAttribute("aria-checked"), sw.getAttribute("aria-label")]).toEqual(["false", "Pick up issues"]);
  expect(container.textContent).toContain("Off: only tasks you start.");
  await act(async () => sw.click());
  expect(onChange).toHaveBeenCalledWith(true);
  await render(<ToggleRow label="Pick up issues" checked onChange={onChange} />);
  await act(async () => sw.click());
  expect(onChange).toHaveBeenLastCalledWith(false);
});

it("Problems renders nothing when empty and one item per problem otherwise", async () => {
  await render(<Problems items={[]} />);
  expect(container.innerHTML).toBe("");
  await render(<Problems items={["first", "second"]} />);
  expect(Array.from(container.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["first", "second"]);
});

it("ConfirmRemove needs a second click, and Keep backs out", async () => {
  const onConfirm = vi.fn();
  await render(<ConfirmRemove label="Remove acme/app" onConfirm={onConfirm} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove acme/app"]')!.click());
  expect(onConfirm).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Remove?");
  await act(async () => button("Keep").click());
  expect(container.textContent).not.toContain("Remove?");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove acme/app"]')!.click());
  await act(async () => button("Remove").click());
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
