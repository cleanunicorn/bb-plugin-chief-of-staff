// Shared helpers for the jsdom component tests: mount with createRoot + act,
// and drive controlled inputs the way a browser would.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

export const container = document.createElement("div");
let root: Root | null = null;

export async function mount(content: ReactNode): Promise<void> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.append(container);
  root ??= createRoot(container);
  await act(async () => { root!.render(content); });
}

/** Call from afterEach. */
export async function unmount(): Promise<void> {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  vi.unstubAllGlobals();
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Set a controlled input, textarea or select and fire the event React listens to. */
export async function setValue(el: Control, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

export async function click(el: Element): Promise<void> {
  await act(async () => { (el as HTMLElement).click(); });
}

export async function blur(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
}

/** Every form control whose <label> reads exactly `label`, in document order. */
export function fields(label: string): Control[] {
  return Array.from(container.querySelectorAll("label"))
    .filter((l) => l.textContent?.trim() === label)
    .map((l) => document.getElementById(l.htmlFor) as Control);
}

export function field(label: string): Control {
  const [first] = fields(label);
  if (!first) throw new Error(`no field labelled "${label}"`);
  return first;
}

/** The first button whose text (or aria-label) is exactly `name`. */
export function button(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}
