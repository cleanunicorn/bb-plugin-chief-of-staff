// One tab stop group for a list of cards (issue #115): only the current card's controls
// are in the tab order, and the arrow keys move between cards. Without it, Tab visits
// every control of every card before reaching anything below the list.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";

/** Put this attribute, set to the card's id, on each card element inside the group. */
export const CARD_ATTRIBUTE = "data-roving-card";

/** Put this attribute on the one control the arrow keys should land on in a card; without one, they land on its first control. */
export const ENTRY_ATTRIBUTE = "data-roving-entry";

const CONTROLS = "summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

/** Where focus lands in a card: its entry control, else its first control. */
function focusCard(card: HTMLElement): void {
  (card.querySelector<HTMLElement>(`[${ENTRY_ATTRIBUTE}]`) ?? card.querySelector<HTMLElement>(CONTROLS))?.focus();
}

/** Fields where a letter key is typing, not a shortcut. */
const TYPING = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role=textbox]";

/**
 * An open dialog or menu. Some stay mounted when closed (the persistent phone drawer keeps a `role=dialog` in the
 * body, `data-state=closed`, inert and aria-hidden), so closed, inert and hidden ones, by either attribute, do not count.
 */
const OPEN_OVERLAY = ["dialog", "alertdialog", "menu"].map((role) => `[role=${role}]:not([data-state=closed]):not([inert]):not([aria-hidden=true]):not([hidden])`).join(", ");

/**
 * Whether a single-letter shortcut (j, k) of the view in `root` must leave this key alone: focus is elsewhere in
 * the app (outside `root`, and not on the page itself), a modifier is held, something handled it already, the user
 * is composing or typing in a field, or a dialog or menu is open over the page. The plugin shares the host's
 * document, so a window listener hears keys meant for the rest of BB.
 */
export function shortcutBlocked(event: globalThis.KeyboardEvent, root: Element | null): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
  const target = event.target;
  const onPage = target === document || target === document.body || target === document.documentElement;
  if (!onPage && !(target instanceof Node && root?.contains(target))) return true;
  if (target instanceof Element && target.closest(TYPING)) return true;
  return document.querySelector(OPEN_OVERLAY) !== null;
}

const STEP: Record<string, (from: number, last: number) => number> = {
  ArrowRight: (from) => from + 1,
  ArrowDown: (from) => from + 1,
  ArrowLeft: (from) => from - 1,
  ArrowUp: (from) => from - 1,
  Home: () => 0,
  End: (_, last) => last,
};

/**
 * `ids` are the cards in display order. Returns the current card's id (the one whose
 * controls are tabbable) and the handlers to spread on the group element.
 *
 * Movement follows DOM order, one card per key, whatever the grid's column count.
 * Focus landing on a card by any route (click, Tab, a sheet returning focus) makes it
 * current. When the current card leaves the list, the first card is current again.
 *
 * `move(delta)` serves page-wide keys (j, k): from inside a card it moves `delta` cards, clamped
 * at both ends; from anywhere else it focuses the current card. False when there is no card.
 */
export function useRovingCards(ids: readonly string[]) {
  const [current, setCurrent] = useState<string | null>(null);
  const active = current !== null && ids.includes(current) ? current : (ids[0] ?? null);
  const group = useRef<HTMLElement | null>(null);
  const latest = useRef(active);
  useEffect(() => {
    latest.current = active;
  }, [active]);

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    // React events bubble through portals (menus, dialogs); only DOM descendants count.
    if (!event.currentTarget.contains(event.target)) return;
    const id = event.target.closest(`[${CARD_ATTRIBUTE}]`)?.getAttribute(CARD_ATTRIBUTE);
    if (id) setCurrent(id);
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const step = STEP[event.key];
    // A control that handles the key itself (the More actions trigger opens on ArrowDown) wins.
    if (!step || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || target.closest("input, textarea, select, [contenteditable]")) return;
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[${CARD_ATTRIBUTE}]`));
    const from = cards.findIndex((card) => card.contains(target));
    if (from < 0) return;
    event.preventDefault();
    const to = Math.max(0, Math.min(cards.length - 1, step(from, cards.length - 1)));
    if (to !== from) focusCard(cards[to]!);
  }, []);

  const move = useCallback((delta: number): boolean => {
    const cards = Array.from(group.current?.querySelectorAll<HTMLElement>(`[${CARD_ATTRIBUTE}]`) ?? []);
    if (!cards.length) return false;
    const focused = document.activeElement;
    const from = focused ? cards.findIndex((card) => card.contains(focused)) : -1;
    if (from < 0) {
      focusCard(cards.find((card) => card.getAttribute(CARD_ATTRIBUTE) === latest.current) ?? cards[0]!);
      return true;
    }
    const to = Math.max(0, Math.min(cards.length - 1, from + delta));
    if (to !== from) focusCard(cards[to]!);
    return true;
  }, []);

  const ref = useCallback((el: HTMLElement | null) => {
    group.current = el;
  }, []);

  return { current: active, move, groupProps: { ref, onFocus, onKeyDown } };
}
