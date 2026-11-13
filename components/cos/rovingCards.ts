// One tab stop group for a list of cards (issue #115): only the current card's controls
// are in the tab order, and the arrow keys move between cards. Without it, Tab visits
// every control of every card before reaching anything below the list.
import { useCallback, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";

/** Put this attribute, set to the card's id, on each card element inside the group. */
export const CARD_ATTRIBUTE = "data-roving-card";

const CONTROLS = "summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

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
 */
export function useRovingCards(ids: readonly string[]) {
  const [current, setCurrent] = useState<string | null>(null);
  const active = current !== null && ids.includes(current) ? current : (ids[0] ?? null);

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
    if (to !== from) cards[to]!.querySelector<HTMLElement>(CONTROLS)?.focus();
  }, []);

  return { current: active, groupProps: { onFocus, onKeyDown } };
}
