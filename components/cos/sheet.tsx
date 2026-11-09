// The dashboard's modal sheets, on the vendored dialog: focus moves in, Tab
// stays inside, Escape and a backdrop click close, the page behind is hidden
// from assistive technology. The sheets open from state rather than from a
// DialogTrigger, so the dialog cannot return focus by itself: the opener is
// remembered with useSheetFocus and restored on close.
import { forwardRef, useCallback, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Dialog, DialogContent } from "../ui/dialog";
import { CompactViewportOverrideProvider } from "../ui/hooks/use-compact-viewport";
import { cn } from "../../lib/utils";

/** Remembers what opened a sheet. `restore` focuses it again, or `fallback` when it has left the page. */
export function useSheetFocus<Fallback extends HTMLElement = HTMLElement>() {
  const opener = useRef<HTMLElement | null>(null);
  const fallback = useRef<Fallback | null>(null);
  const remember = useCallback((element: HTMLElement | null) => {
    opener.current = element;
  }, []);
  const restore = useCallback(() => {
    (opener.current?.isConnected ? opener.current : fallback.current)?.focus();
    opener.current = null;
  }, []);
  return { fallback, remember, restore };
}

interface SheetProps {
  onClose: () => void;
  /** Runs once the sheet has closed; put focus back where it came from. */
  restoreFocus?: () => void;
  /** Call `event.preventDefault()` to keep the sheet open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** Name it with a DialogTitle inside; close buttons go in DialogClose. */
export const Sheet = forwardRef<HTMLDivElement, SheetProps>(({ onClose, restoreFocus, onEscapeKeyDown, className, style, children }, ref) => (
  // Always the centred dialog: the compact drawer closes on swipe, which fights canvas panning and scrolling.
  <CompactViewportOverrideProvider isCompactViewport={false}>
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={ref}
        hideCloseButton
        aria-describedby={undefined}
        style={style}
        // No transition: the dialog's `duration-200` would otherwise animate every size change (resize, maximize, full screen).
        className={cn("flex flex-col overflow-hidden border-border shadow-lg outline-none transition-none", className)}
        onEscapeKeyDown={onEscapeKeyDown}
        // Focus the sheet itself, so a screen reader starts at its title and Enter does not land on Close.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus?.();
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  </CompactViewportOverrideProvider>
));
Sheet.displayName = "Sheet";
