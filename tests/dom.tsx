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

/** The open dialog. Dialogs render in a portal on document.body, outside `container`. */
export function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

/** The button in the open dialog whose text or aria-label is exactly `name`. Scoped to the dialog, so it never finds a page button with the same label. */
export function dialogButton(name: string): HTMLButtonElement {
  const found = Array.from(dialog()?.querySelectorAll("button") ?? []).find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no dialog button "${name}"`);
  return found;
}

export async function keydown(target: Element, key: string): Promise<void> {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
}

/** Let pending timers run: Radix layers start listening for outside pointers one tick after they open. */
export async function tick(ms = 0): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** A pointer press and click on `target`, outside any open dialog or menu. Radix dismisses on the click that follows the press. */
export async function clickOutside(target: Element = document.body): Promise<void> {
  await tick();
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await tick();
}

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

/** `el` is the first <summary> child of its <details>, the one the browser makes focusable. */
function isDetailsSummary(el: Element): boolean {
  const details = el.parentElement;
  return el.tagName === "SUMMARY" && details instanceof HTMLDetailsElement && details.querySelector(":scope > summary") === el;
}

/**
 * The elements Tab visits inside `root`, in order. jsdom does not move focus on Tab, so the
 * order is computed from the DOM: focusable elements without a negative tabindex, skipping
 * disabled ones, anything under [inert] or [hidden], and the contents of a closed <details>
 * other than its summary. Positive tabindex values are not used in this app and not ordered.
 */
export function tabbables(root: ParentNode = container): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.closest("[inert], [hidden]")) return false;
    if (el.tagName === "SUMMARY") {
      // jsdom's default tabIndex for a summary may not be 0, so read the attribute.
      if (!isDetailsSummary(el)) return false;
      const attr = el.getAttribute("tabindex");
      if (attr !== null && Number(attr) < 0) return false;
    } else if (el.tabIndex < 0) return false;
    for (let details = el.parentElement?.closest("details"); details; details = details.parentElement?.closest("details")) {
      if (!details.open && !(isDetailsSummary(el) && el.parentElement === details)) return false;
    }
    return true;
  });
}

/** The tab stops after `from` in document order. */
export function tabbablesAfter(from: Element, root: ParentNode = container): HTMLElement[] {
  return tabbables(root).filter((el) => from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
}
