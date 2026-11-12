// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { clickOutside, mount, unmount } from "./dom";

vi.mock("../components/ui/icon", () => ({ Icon: () => null }));

const onConfirm = vi.fn();
const onCancel = vi.fn();
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
const press = (key: string) => act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

/** Open until either button is used, as a parent would wire it. */
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      title="Mark ‘Fix login’ done?"
      description="The task stops and its workflow ends."
      confirmLabel="Mark done"
      onConfirm={() => { onConfirm(); setOpen(false); }}
      onCancel={() => { onCancel(); setOpen(false); }}
    />
  );
}

afterEach(async () => { await unmount(); onConfirm.mockReset(); onCancel.mockReset(); document.body.replaceChildren(); });

it("is a dialog named by its title, with focus on the confirm button", async () => {
  await mount(<Harness />);
  const el = dialog()!;
  expect(el.getAttribute("role")).toBe("dialog");
  expect(document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent).toBe("Mark ‘Fix login’ done?");
  expect(document.getElementById(el.getAttribute("aria-describedby")!)?.textContent).toBe("The task stops and its workflow ends.");
  expect(document.activeElement).toBe(button("Mark done"));
});

it("calls onCancel, never onConfirm, from Cancel", async () => {
  await mount(<Harness />);
  await act(async () => button("Cancel").click());
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();
});

it("calls onCancel, never onConfirm, from Escape", async () => {
  await mount(<Harness />);
  await press("Escape");
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("calls onCancel, never onConfirm, from a click outside", async () => {
  await mount(<Harness />);
  await clickOutside();
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("calls onConfirm exactly once, even on a double click", async () => {
  await mount(<ConfirmDialog open title="Run ‘Build’ again?" confirmLabel="Run again" onConfirm={onConfirm} onCancel={onCancel} />);
  const confirm = button("Run again");
  await act(async () => { confirm.click(); confirm.click(); });
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
});
