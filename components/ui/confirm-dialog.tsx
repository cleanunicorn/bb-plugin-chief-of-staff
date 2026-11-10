// A short "are you sure?" prompt on the vendored dialog. Controlled: the parent
// owns `open` and closes it from onConfirm / onCancel. Escape and a click
// outside count as Cancel. Always the centred dialog, never the swipe drawer,
// so there is no swipe-to-close path to handle.
import { useCallback, useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { CompactViewportOverrideProvider } from "./hooks/use-compact-viewport";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "destructive";
  onConfirm: () => void;
  onCancel: () => void;
  /** Where focus goes once the dialog has closed. Without it, the dialog returns focus to what had it when it opened. */
  restoreFocus?: () => void;
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = "Cancel", tone, onConfirm, onCancel, restoreFocus }: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // One answer per opening: a fast second click can land before the parent re-renders the dialog closed.
  const answered = useRef(false);
  const answer = (confirmed: boolean) => {
    if (answered.current) return;
    answered.current = true;
    if (confirmed) onConfirm();
    else onCancel();
  };
  return (
    <CompactViewportOverrideProvider isCompactViewport={false}>
      <Dialog open={open} onOpenChange={(next) => !next && answer(false)}>
        <DialogContent
          hideCloseButton
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            answered.current = false;
            event.preventDefault();
            confirmRef.current?.focus();
          }}
          onCloseAutoFocus={restoreFocus ? (event) => {
            event.preventDefault();
            restoreFocus();
          } : undefined}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => answer(false)}>{cancelLabel}</Button>
            <Button ref={confirmRef} size="sm" variant={tone === "destructive" ? "destructive" : "default"} onClick={() => answer(true)}>{confirmLabel}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CompactViewportOverrideProvider>
  );
}

/**
 * Returns a focus function for a ConfirmDialog's `restoreFocus`: it focuses `ref`
 * now, or once `disabled` turns false. A confirmed action usually disables the
 * button that asked while its call runs, and a disabled button cannot take focus.
 */
export function useFocusWhenEnabled(ref: RefObject<HTMLButtonElement | null>, disabled: boolean): () => void {
  const pending = useRef(false);
  useEffect(() => {
    if (disabled || !pending.current) return;
    pending.current = false;
    ref.current?.focus();
  }, [disabled, ref]);
  return useCallback(() => {
    if (ref.current?.disabled) pending.current = true;
    else ref.current?.focus();
  }, [ref]);
}
