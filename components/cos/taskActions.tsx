// A task's More actions menu and the confirms it asks, shared by the active cards and the Finished rows.
// The confirm is held by the list, not the card or row: a task that moves between the active grid and the
// Finished list on a refetch keeps its open dialog and the text it asked with.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { taskLabel, type ActivityTask } from "./dashboardModel";

export type ItemAction = "retry" | "approve" | "mark_done" | "mark_failed";
export type Confirmable = "mark_done" | "mark_failed" | "restart";

/** What the menu needs to know about a task. */
export type MenuTask = { id: string; detail: string; issueNumber: number | null; issueTitle: string; threadTitle?: string | null };

export const taskTitle = (task: Pick<MenuTask, "issueTitle" | "threadTitle">) => task.issueTitle || task.threadTitle || "Untitled task";

/**
 * What each confirm says and sends. A failed task is no longer worked on, so its copy differs.
 * `archivesOnDone`: marking done archives the task's threads ("Archive threads when a task is done").
 */
export function confirmCopy(kind: Confirmable, title: string, failed: boolean, archivesOnDone: boolean): { title: string; description: string; confirmLabel: string; tone?: "destructive"; action: ItemAction } {
  switch (kind) {
    case "restart":
      return {
        title: `Restart ‘${title}’ on a new thread?`,
        // Server `retry` on a failed item reopens it, which usually takes a slot whether or not an agent starts. It
        // restarts an unfinished writing step on a fresh thread; steps not yet started then run through the scheduler.
        description: "This reopens the task, so it usually takes one of the task slots again, or waits for one to free up. Chief of Staff carries on from where it stopped: an unfinished writing step restarts on a new thread, and steps that had not started run as usual. The old thread is left as it is.",
        confirmLabel: "Restart",
        action: "retry",
      };
    case "mark_done":
      return {
        title: `Mark ‘${title}’ done?`,
        description: `${failed ? "The task is recorded as done instead of failed. No agent work starts." : "Chief of Staff stops working on this task and its workflow ends."} ${archivesOnDone ? "Its threads are archived and their workspace is removed: changes not pushed are lost." : "Its threads are left as they are."}`,
        confirmLabel: "Mark done",
        action: "mark_done",
      };
    case "mark_failed":
      return {
        title: `Mark ‘${title}’ failed?`,
        description: "Chief of Staff stops working on this task and its workflow ends. The agent's thread is left as it is.",
        confirmLabel: "Mark failed",
        tone: "destructive",
        action: "mark_failed",
      };
  }
}

/**
 * The More actions menu: done → "Run a step again…"; failed → Restart and Mark done; active → Retry, Mark done
 * and Mark failed; plus "Show activity" when the page has an Activity feed.
 */
export function TaskActionsMenu({ task, busy, tabIndex, onAction, onAsk, onRerun, onShowActivity }: { task: MenuTask; busy: boolean; tabIndex?: number; onAction: (id: string, action: ItemAction) => void; onAsk: (task: MenuTask, kind: Confirmable, trigger: HTMLButtonElement) => void; onRerun: (id: string, trigger: HTMLButtonElement) => void; onShowActivity?: (task: ActivityTask) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  // Set when "Show activity" is chosen: the menu hands focus to the Activity panel instead of back to its trigger.
  const showingActivity = useRef(false);
  const ask = (kind: Confirmable) => onAsk(task, kind, trigger.current!);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={trigger} size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0 pointer-coarse:size-10" aria-label="More actions" tabIndex={tabIndex} disabled={busy}>
          <Icon name="Ellipsis" fallback="MoreHorizontal" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        // Show the activity once the menu has closed: an open menu keeps focus inside itself.
        onCloseAutoFocus={(event) => {
          if (!showingActivity.current || !onShowActivity) return;
          showingActivity.current = false;
          event.preventDefault();
          onShowActivity({ id: task.id, label: taskLabel({ workItemId: task.id, issueNumber: task.issueNumber, issueTitle: task.issueTitle || null }) ?? taskTitle(task) });
        }}
      >
        {onShowActivity ? (
          <DropdownMenuItem onSelect={() => { showingActivity.current = true; }}>
            <Icon name="Activity" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
            Show activity
          </DropdownMenuItem>
        ) : null}
        {task.detail === "done" ? (
          // A re-run puts a done task back to work; the sheet asks before running it. Focus returns to More actions,
          // because this item is gone once the menu closes.
          <DropdownMenuItem onSelect={() => onRerun(task.id, trigger.current!)}>
            <Icon name="RotateCcw" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
            Run a step again…
          </DropdownMenuItem>
        ) : task.detail === "failed" ? (
          <>
            <DropdownMenuItem onSelect={() => ask("restart")}>
              <Icon name="RotateCcw" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
              Restart on a new thread…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ask("mark_done")}>
              <Icon name="CircleCheck" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
              Mark done…
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => onAction(task.id, "retry")}>
              <Icon name="RotateCcw" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
              Retry the stuck step
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ask("mark_done")}>
              <Icon name="CircleCheck" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
              Mark done…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ask("mark_failed")}>
              <Icon name="CircleX" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
              Mark failed…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Asked = { id: string; title: string; kind: Confirmable; failed: boolean; open: boolean; trigger: HTMLButtonElement | null };

/**
 * The confirm for every task in a list. `busy` holds the tasks with an action in flight (their triggers are
 * disabled meanwhile). Once the dialog closes, focus goes back to the More actions button that asked, as soon
 * as it is enabled again; when that button has gone (the task moved to another list), to `fallback`.
 */
export function useTaskConfirm({ archivesOnDone, busy, onAction, fallback }: { archivesOnDone: boolean; busy: ReadonlySet<string>; onAction: (id: string, action: ItemAction) => void; fallback: () => void }): { ask: (task: MenuTask, kind: Confirmable, trigger: HTMLButtonElement) => void; dialog: ReactNode } {
  // What was asked outlives the opening, so the dialog keeps its text while it animates closed, even after a
  // refetch has changed the task's outcome under it.
  const [asked, setAsked] = useState<Asked>({ id: "", title: "", kind: "mark_done", failed: false, open: false, trigger: null });
  const pending = useRef<HTMLButtonElement | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const ask = useCallback((task: MenuTask, kind: Confirmable, trigger: HTMLButtonElement) => {
    setAsked({ id: task.id, title: taskTitle(task), kind, failed: task.detail === "failed", open: true, trigger });
  }, []);
  const close = () => setAsked((a) => ({ ...a, open: false }));
  // A confirmed action disables its trigger while the call runs; focus it once the call is over, if focus is still lost.
  useEffect(() => {
    const trigger = pending.current;
    if (!trigger) return;
    if (trigger.isConnected && trigger.disabled) return;
    pending.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (trigger.isConnected) trigger.focus();
    else fallbackRef.current();
  }, [busy]);
  const restoreFocus = () => {
    const trigger = asked.trigger;
    if (trigger?.isConnected && !trigger.disabled) trigger.focus();
    else if (trigger?.isConnected) pending.current = trigger;
    else fallbackRef.current();
  };
  const copy = confirmCopy(asked.kind, asked.title, asked.failed, archivesOnDone);
  const dialog = (
    <ConfirmDialog
      open={asked.open}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      tone={copy.tone}
      onConfirm={() => {
        onAction(asked.id, copy.action);
        close();
      }}
      onCancel={close}
      restoreFocus={restoreFocus}
    />
  );
  return { ask, dialog };
}
