// Chief of Staff — BB plugin frontend entry: dashboard nav panel + settings section.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { UrlLink, definePluginApp, experimental_useRpcQuery, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./rpcContract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ColumnChart, DataTable, Meter, Panel, PaletteProvider, STATUS, StatusPill, ViewToggle, compact, duration, relative, toneColor, usePalette } from "@/components/cos/viz";
import type { Tone } from "@/components/cos/viz";
import { STAGES, stageColor, stageOf } from "@/components/cos/stages";
import { STEP_TYPE_META, ShrinkGlyph, WorkflowCanvas, liveTone, type LiveStatus } from "@/components/cos/workflowCanvas";
import { descendants, topoOrder, type Workflow } from "./src/workflow";
import { OUTCOME_META, endReason } from "./src/outcome";
import { edgeCounts, loopBacks } from "@/components/cos/runModel";
import { StepPanel, TaskOverview, TaskSummary } from "@/components/cos/taskRunView";
import { Sheet, useSheetFocus } from "@/components/cos/sheet";
import { DialogClose, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog, useFocusWhenEnabled } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { StageKey } from "@/components/cos/stages";
import { Configurator } from "@/components/cos/configurator";
import { useConfigDrafts } from "@/components/cos/configDrafts";
import { QuestionSheet } from "@/components/cos/question";
import { StepFlow, StepProgress } from "@/components/cos/stepFlow";
import { StateMark, QueueIllustration } from "./components/cos/taskVisuals";
import { attentionKind, matchesTaskFilter, recentTasks, splitThreadIds, taskLabel, type ActivityTask, type TaskFilter } from "./components/cos/dashboardModel";
import { NewTaskForm } from "@/components/cos/newTaskForm";
import { PrStatePill, PullRequestList } from "@/components/cos/prState";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { CARD_ATTRIBUTE, ENTRY_ATTRIBUTE, shortcutBlocked, useRovingCards } from "@/components/cos/rovingCards";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import { useVisitBaseline } from "@/components/cos/lastVisit";
import { CardSkeleton, LoadingRegion, Skeleton } from "@/components/cos/skeleton";

type Contract = typeof rpcContract;
type RosterEntry = PluginRpcResult<Contract["cos_roster"]>["entries"][number];
type IntakeResult = PluginRpcResult<Contract["cos_intake_now"]>["results"][number];
type Since = PluginRpcResult<Contract["cos_since"]>;

const TABS = [
  { id: "agents", label: "Pipeline", icon: "Workflow" },
  { id: "issues", label: "Repos & PRs", icon: "GitPullRequest" },
  { id: "config", label: "Configure", icon: "SlidersHorizontal" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const WINDOW_DAYS = 14;

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ErrorLine({ error }: { error: { message: string } | string | null }) {
  if (!error) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
      <Icon name="CircleX" fallback="Circle" className="mt-0.5 size-4 shrink-0" style={{ color: STATUS.critical }} aria-hidden />
      {typeof error === "string" ? error : error.message}
    </p>
  );
}

type QueryError = { message: string } | string | null | undefined;

/** One line per distinct message, so two queries failing the same way do not repeat it. */
function QueryErrors({ errors }: { errors: readonly QueryError[] }) {
  const messages = new Set<string>();
  for (const e of errors) {
    const message = typeof e === "string" ? e : e?.message;
    if (message) messages.add(message);
  }
  return <>{Array.from(messages, (message) => <ErrorLine key={message} error={message} />)}</>;
}

function Empty({ icon, title, children, illustration = false }: { icon: string; title: string; children?: ReactNode; illustration?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-8 text-center">
      {illustration ? <QueueIllustration /> : <Icon name={icon} fallback="Circle" className="size-6 text-muted-foreground" aria-hidden />}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? <p className="max-w-md text-xs text-muted-foreground">{children}</p> : null}
    </div>
  );
}

// ---------- status helpers ----------

const WAITING_LABEL: Record<string, { label: string; icon: string }> = {
  approval: { label: "Approve", icon: "ClipboardCheck" },
  stalled: { label: "Stalled", icon: "Hourglass" },
  question: { label: "Question", icon: "MessageCircleQuestion" },
  escalation: { label: "Your call", icon: "Hand" },
  no_report: { label: "No report", icon: "MessageSquareWarning" },
  cos_error: { label: "CoS stuck", icon: "OctagonAlert" },
};

/** "acme/app" → "app". */
function repoName(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

function entryTone(e: RosterEntry): { tone: Tone; label: string; icon: string } {
  // A finished task reads by how it ended, never by whether an old error is still stored.
  if (e.outcome) return OUTCOME_META[e.outcome];
  if (e.detail === "done") return { tone: "good", label: "Done", icon: "CircleCheck" };
  if (e.detail === "failed") return { tone: "neutral", label: "Failed", icon: "CircleX" };
  if (e.detail === "blocked") return { tone: "warning", label: "Stalled", icon: "OctagonAlert" };
  if (e.detail === "waiting_on_human") {
    const w = WAITING_LABEL[e.waitingKind ?? "question"] ?? WAITING_LABEL.question!;
    return { tone: e.waitingKind === "cos_error" ? "serious" : "warning", ...w };
  }
  if (e.detail === "retrying") return { tone: "serious", label: `${e.current[0] ?? "Step"} · retrying`, icon: "RefreshCw" };
  if (e.detail === "agent" && e.current.length) return { tone: "info", label: e.current.join(" + "), icon: "Bot" };
  if (e.detail === "ready") return { tone: "good", label: "Ready to merge", icon: "GitMerge" };
  if (e.detail === "ci") return { tone: "info", label: "CI running", icon: "GitPullRequest" };
  const stage = stageOf(e);
  if (!stage) return { tone: "neutral", label: e.detail, icon: "Circle" };
  return { tone: stage.tone ?? "info", label: stage.label, icon: stage.icon };
}

function StagePill({ entry }: { entry: RosterEntry }) {
  const palette = usePalette();
  const t = entryTone(entry);
  const stage = stageOf(entry);
  const color = stage && !stage.tone && t.tone === "info" ? stageColor(stage, palette) : toneColor(t.tone, palette);
  const live = entry.actor === "agent" || entry.actor === "cos";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground">
      <span className="relative inline-flex">
        {live ? <span aria-hidden className="absolute inset-0 animate-ping rounded-full opacity-40" style={{ background: color }} /> : null}
        <Icon name={t.icon} fallback="Circle" className="relative size-3.5" style={{ color }} aria-hidden />
      </span>
      {t.label}
    </span>
  );
}

/** Preserve useful progress detail without repeating the stage's generic working label. */
function ActivityLine({ entry }: { entry: RosterEntry }) {
  const generic = entry.current.map((name) => `${name}: agent working`).join(" · ");
  if (!entry.activity || entry.activity === generic || entry.activity === "Working" || entry.activity === entry.waitingReason) return null;
  return <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{entry.activity}</p>;
}

/** What "Run again from here" resets: the step and every step reachable after it (the server's rerun does the same). */
function rerunEffect(wf: Workflow, stepId: string, name: string): string {
  const after = descendants(wf, stepId).size - 1;
  if (after <= 0) return `This resets ${name} and runs it again.`;
  return `This resets ${name} and the ${after === 1 ? "step" : `${after} steps`} after it, then runs ${name} again.`;
}

/**
 * Phone landscape and other short, wide viewports. The workflow sheet then puts the canvas beside the details
 * and drops the canvas's 16rem floor, which would otherwise push it past the dialog's bottom edge (#98).
 * Narrow windows keep the stacked layout: side by side, neither half would be usable.
 */
export const SHORT_VIEWPORT_QUERY = "(max-height: 32rem) and (min-width: 40rem)";

/**
 * Portrait phones: narrower than Tailwind's `sm`. The exact complement of SHORT_VIEWPORT_QUERY's width condition,
 * so the two never match together. The workflow sheet then gives the task line its own row, shows the view switch
 * as icons, and scrolls the canvas and the overview as one column instead of squeezing the overview into a box (#118).
 */
export const PHONE_VIEWPORT_QUERY = "not all and (min-width: 40rem)";
type SheetMode = "canvas" | "list";

/** One task's run: the workflow coloured live (canvas or list), the task's details, loop-backs and history, and per step what it received and produced, with "run again from here". */
function WorkflowSheet({ id, initialMode = "canvas", onClose, onChanged, restoreFocus }: { id: string; initialMode?: SheetMode; onClose: () => void; onChanged: () => void; restoreFocus: () => void }) {
  const rpc = useRpc<Contract>();
  const view = experimental_useRpcQuery<Contract, "cos_item_workflow">({ contract: rpcContract, method: "cos_item_workflow", input: { id } });
  useLiveRefresh(async () => void (await view.refetch()));
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<SheetMode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const rerunButton = useRef<HTMLButtonElement>(null);
  const focusRerun = useFocusWhenEnabled(rerunButton, busy);
  const [error, setError] = useState<string | null>(null);
  // One class set or the other, never both: `md:` and a height query both match at 844×390.
  const short = useMediaQuery(SHORT_VIEWPORT_QUERY);
  const phone = useMediaQuery(PHONE_VIEWPORT_QUERY) && !short;
  // Full screen keeps the fill layout on a phone too: only the header (and the footer hint) differ there.
  const phoneColumn = phone && !expanded;
  const column = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const data = view.data;
  const wf = data?.workflow as Workflow | undefined;
  const live = useMemo(() => (data?.live ?? {}) as Record<string, LiveStatus>, [data?.live]);
  const step = wf?.steps.find((s) => s.id === selected);
  const journal = useMemo(() => data?.journal ?? [], [data?.journal]);
  const loops = useMemo(() => (wf ? loopBacks(wf, journal, live) : { total: 0, loops: [], approximate: true }), [wf, journal, live]);
  const counts = useMemo(() => (wf ? edgeCounts(wf, journal, loops) : {}), [wf, journal, loops]);
  const now = useNow();
  const statusLabel = (stepId: string) => liveTone(live[stepId])?.label ?? "pending";
  const rerun = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("cos_item_action", { id, action: "rerun_step", step: selected });
      onChanged();
      await view.refetch();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  // On a phone the step panel follows the canvas or a long list; bring its top into view when a selection puts it below the fold.
  useEffect(() => {
    if (!phoneColumn || !selected || !column.current || !aside.current) return;
    if (aside.current.getBoundingClientRect().top >= column.current.getBoundingClientRect().bottom) {
      aside.current.scrollIntoView?.({ block: "nearest" });
    }
  }, [phoneColumn, selected]);
  const taskLine = data ? `${data.title} · workflow “${wf?.name}”` : undefined;
  const controls = (
    <div className={cn("flex shrink-0 items-center gap-1.5", phone && "ml-auto")}>
      {expanded ? (
        <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2" onClick={() => setExpanded(false)}>
          <ShrinkGlyph /> Exit full screen
        </Button>
      ) : null}
      <div role="group" aria-label="View" className="flex rounded-md border border-border p-0.5">
        {(["canvas", "list"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={mode === v}
            onClick={() => {
              setMode(v);
              // The full-screen control lives on the canvas.
              if (v === "list") setExpanded(false);
            }}
            className={cn("flex items-center rounded text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", phone ? "size-9 justify-center" : "gap-1 px-2 py-1", mode === v ? "bg-state-active text-foreground" : "text-muted-foreground")}
          >
            <Icon name={v === "canvas" ? "Network" : "List"} fallback="Circle" className="size-3.5" aria-hidden />
            {/* Icons only on a phone; the text stays as the button's name. */}
            <span className={phone ? "sr-only" : undefined}>{v === "canvas" ? "Canvas" : "List"}</span>
          </button>
        ))}
      </div>
      <DialogClose asChild>
        <Button size="sm" variant="ghost" className="size-9 shrink-0 p-0 sm:size-7" aria-label="Close">
          <Icon name="X" fallback="Circle" aria-hidden />
        </Button>
      </DialogClose>
    </div>
  );
  return (
    <Sheet
      onClose={onClose}
      restoreFocus={restoreFocus}
      // Escape undoes one thing at a time: full screen, then the selection of the focused step, then the sheet.
      // The dialog sees Escape first (capture phase on the document). Stopping it there keeps React Flow's own
      // Escape handling out: that blurs a selected step, and selects an unselected one.
      onEscapeKeyDown={(event) => {
        const step = document.activeElement?.closest(".react-flow__node");
        if (step) event.stopPropagation();
        if (expanded) {
          event.preventDefault();
          setExpanded(false);
        } else if (step?.classList.contains("selected")) {
          event.preventDefault();
          setSelected(null);
        }
      }}
      className={cn(
        short || phone ? "gap-2 p-3" : "gap-3 p-4",
        expanded
          ? "h-dvh max-w-none rounded-none sm:rounded-none"
          : cn(short ? "h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)]" : "h-[90dvh] max-h-[calc(100dvh-2rem)]", "w-[calc(100%-2rem)] max-w-[96rem] rounded-xl sm:rounded-xl"),
      )}
    >
      {phone ? (
        // The task line gets the full width: beside the controls it kept only part of the repository's name.
        <header className="flex shrink-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Basis auto, not 0: the controls drop to a second line before the title is squeezed. */}
            <DialogTitle className="min-w-0 flex-auto leading-normal tracking-normal text-foreground">Where this task is</DialogTitle>
            {controls}
          </div>
          <p className="line-clamp-3 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={taskLine}>{taskLine ?? "Loading…"}</p>
        </header>
      ) : (
        <header className="flex shrink-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={cn(short ? "line-clamp-1" : "line-clamp-2", "text-xs text-muted-foreground")} title={taskLine}>{taskLine ?? "Loading…"}</p>
            <DialogTitle className="leading-normal tracking-normal text-foreground">Where this task is</DialogTitle>
          </div>
          {controls}
        </header>
      )}
      {wf ? <TaskSummary task={data?.task} workflow={wf} live={live} loops={loops} now={now} oneLine={short} /> : null}
      <ErrorLine error={view.error ?? error} />
      {/* On a phone the row is the one scroller: the canvas at a set height, then the list or overview at natural height. */}
      {wf && data ? <div ref={column} className={cn("flex min-h-0 flex-1", phoneColumn ? "flex-col gap-2 overflow-y-auto overscroll-contain" : short ? "flex-row gap-2" : "flex-col gap-3 md:flex-row")}>
        {mode === "canvas" ? (
          <WorkflowCanvas workflow={wf} live={live} edgeCounts={counts} selected={selected} onSelect={setSelected} expanded={expanded} onToggleExpanded={() => setExpanded((v) => !v)} className={phoneColumn ? "h-[min(45dvh,24rem)] min-h-[16rem] min-w-0 flex-none" : cn("h-auto min-w-0 flex-1", short ? "min-h-0" : "min-h-[16rem]")} />
        ) : (
          <ol aria-label="Workflow steps" className={cn("flex min-w-0 flex-col gap-1.5 p-px", phoneColumn ? "flex-none" : "min-h-0 flex-1 overflow-y-auto")}>
            {topoOrder(wf).map((stepId) => {
              const s = wf.steps.find((x) => x.id === stepId)!;
              const tone = liveTone(live[stepId]);
              return (
                <li key={stepId}>
                  <button
                    type="button"
                    aria-pressed={selected === stepId}
                    onClick={() => setSelected(selected === stepId ? null : stepId)}
                    className={cn("flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", selected === stepId ? "border-[color:var(--ring)] bg-muted" : "border-border")}
                  >
                    <Icon name={STEP_TYPE_META[s.type].icon} fallback="Circle" className="size-4 shrink-0 text-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{s.name}</span>
                      <span className="block text-xs text-muted-foreground">{STEP_TYPE_META[s.type].label}</span>
                    </span>
                    <span className="flex max-w-[45%] shrink-0 items-center gap-1.5 text-xs font-medium text-foreground">
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tone?.color ?? "var(--border)" }} />
                      <span className="truncate">{statusLabel(stepId)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <aside ref={aside} aria-label={step ? "Step details" : "Task overview"} className={cn("rounded-lg border border-border text-sm", phoneColumn ? "shrink-0 p-3" : cn("min-h-0 overflow-y-auto", short ? "w-[min(20rem,42%)] shrink-0 p-2.5" : "max-h-[45%] p-3 md:max-h-none md:w-[26rem] md:shrink-0"))}>
          {step ? (
            <StepPanel itemId={id} workflow={wf} step={step} live={live[step.id]} detail={data.steps?.[step.id]} steps={data.steps} journal={journal} now={now} />
          ) : (
            <TaskOverview itemId={id} title={data.title} workflow={wf} task={data.task} loops={loops} journal={journal} now={now} />
          )}
        </aside>
      </div> : null}
      {/* On a phone the overview already says "Select a step…"; the hint would only take two more lines. */}
      {step || !phone ? <footer className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {step ? (
          <>
            <span>
              <b className="text-foreground">{step.name}</b> · {statusLabel(step.id)}
            </span>
            <Button ref={rerunButton} size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => setConfirmRerun(true)}>
              <Icon name="RotateCcw" fallback="Circle" aria-hidden /> Run again from here
            </Button>
            <ConfirmDialog
              open={confirmRerun}
              title={`Run ‘${step.name}’ again?`}
              description={rerunEffect(wf!, step.id, step.name)}
              confirmLabel="Run again"
              onConfirm={() => {
                setConfirmRerun(false);
                void rerun();
              }}
              onCancel={() => setConfirmRerun(false)}
              restoreFocus={focusRerun}
            />
          </>
        ) : (
          <span>Select a step to run it (and everything after it) again.</span>
        )}
      </footer> : null}
    </Sheet>
  );
}

// ---------- agent card ----------

type ItemAction = "retry" | "approve" | "mark_done" | "mark_failed";
type Confirmable = "mark_done" | "mark_failed" | "restart";

/** Active cards count the task's age; finished cards say when it finished and how long it took. */
function cardTimer(entry: RosterEntry, finished: boolean, now: number): { text: string; label: string; title: string } {
  const started = new Date(entry.startedAt).toLocaleString();
  if (!finished) {
    const age = duration((now - Date.parse(entry.startedAt)) / 60_000);
    return { text: age, label: `Task age ${age}`, title: `Task started ${started}` };
  }
  // Some legacy rows have no finish time: say only what is known.
  if (!entry.finishedAt) {
    const text = `Started ${relative(entry.startedAt, now)}`;
    return { text, label: text, title: `Task started ${started}` };
  }
  const ago = relative(entry.finishedAt, now);
  const took = duration((Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)) / 60_000);
  return { text: `Finished ${ago} · took ${took}`, label: `Finished ${ago}, took ${took}`, title: `Finished ${new Date(entry.finishedAt).toLocaleString()} · started ${started}` };
}

/**
 * What each confirm on a card says and sends. A failed task is no longer worked on, so its copy differs.
 * `archivesOnDone`: marking done archives the task's threads ("Archive threads when a task is done").
 */
function cardConfirm(kind: Confirmable, title: string, failed: boolean, archivesOnDone: boolean): { title: string; description: string; confirmLabel: string; tone?: "destructive"; action: ItemAction } {
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

/** `tabbable`: this card's controls are in the tab order. Only the current card in the task group is. */
/** `archivesOnDone`: marking the task done archives its threads ("Archive threads when a task is done"). */
function AgentCard({ entry, busy, tabbable, archivesOnDone, onAction, onAnswer, onWorkflow, onShowActivity, now }: { entry: RosterEntry; busy: boolean; tabbable: boolean; archivesOnDone: boolean; onAction: (id: string, action: ItemAction) => void; onAnswer: (id: string, opener: HTMLElement) => void; onWorkflow: (id: string, opener: HTMLElement, mode?: SheetMode) => void; onShowActivity?: (task: ActivityTask) => void; now: number }) {
  const navigate = useBbNavigate();
  // What was asked outlives the opening, so the dialog keeps its text while it animates closed, even after a
  // refetch has changed the task's outcome under it.
  const [confirming, setConfirming] = useState<{ kind: Confirmable; failed: boolean; open: boolean }>({ kind: "mark_done", failed: false, open: false });
  const ask = (kind: Confirmable) => setConfirming({ kind, failed: entry.detail === "failed", open: true });
  const closeConfirm = () => setConfirming((c) => ({ ...c, open: false }));
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const focusTrigger = useFocusWhenEnabled(menuTrigger, busy);
  const title = entry.issueTitle || entry.threadTitle || "Untitled task";
  const finished = entry.detail === "done" || entry.detail === "failed";
  // Set when "Show activity" is chosen: the menu hands focus to the Activity panel instead of back to its trigger.
  const showingActivity = useRef(false);
  const confirmCopy = cardConfirm(confirming.kind, title, confirming.failed, archivesOnDone);
  const needsHuman = entry.status === "waiting on human" || entry.status === "blocked";
  const visual = entryTone(entry);
  const tabIndex = tabbable ? undefined : -1;
  const timer = cardTimer(entry, finished, now);
  // Why it ended, on tasks that did not deliver; a delivered task's stale error stays hidden.
  const reason = endReason(entry.outcome, entry.lastError);
  // A hand-failed task holding another error (stored before #146 wrote MARKED_FAILED) shows it as the last seen, not the cause.
  const reasonLead = entry.outcome === "marked_failed" ? "Last error:" : "Why it ended:";
  return (
    <article {...{ [CARD_ATTRIBUTE]: entry.id }} className={cn("flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3", entry.stalled || needsHuman ? "border-[color:var(--cos-attn)]" : "border-border")} style={{ ["--cos-attn" as string]: entry.stalled ? STATUS.serious : STATUS.warning }}>
      <header className="flex items-start gap-2">
        <StateMark icon={entry.stalled ? "Hourglass" : visual.icon} tone={entry.stalled ? "serious" : visual.tone} />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{title}</h3>
          <p className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            <Icon name="FolderGit2" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span title={entry.repo}>
              {entry.issueUrl ? (
                // The sr-only word tells this link apart from the PR chip: "app issue #12".
                <UrlLink href={entry.issueUrl} tabIndex={tabIndex}>{repoName(entry.repo)}<span className="sr-only"> issue</span> #{entry.issueNumber}</UrlLink>
              ) : (
                repoName(entry.repo)
              )}
            </span>
          </p>
        </div>
      </header>
      <div className={cn("flex items-start justify-between gap-2", finished && "flex-wrap gap-y-1")}>
        <div className="flex flex-wrap items-center gap-1.5">
          <StagePill entry={entry} />
          {entry.stalled ? <StatusPill tone="serious" label="Stalled" icon="Hourglass" /> : null}
        </div>
        <span className={cn("flex items-center gap-1 text-xs text-muted-foreground tabular-nums", finished ? "min-w-0" : "shrink-0")} title={timer.title} aria-label={timer.label}>
          <Icon name={finished ? "CalendarCheck" : "Timer"} fallback="Clock" className="size-3.5 shrink-0" aria-hidden />
          {timer.text}
        </span>
      </div>
      {!finished ? <ActivityLine entry={entry} /> : null}
      {reason ? (
        <p className="flex items-start gap-1.5 text-sm text-foreground">
          {/* Muted: a failed run is history, not an alarm (#22). */}
          <Icon name="Info" fallback="Circle" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]" title={reason}><span className="text-muted-foreground">{reasonLead}</span> {reason}</span>
        </p>
      ) : null}
      {entry.steps.length ? <details className="group text-xs">
        <summary {...{ [ENTRY_ATTRIBUTE]: "" }} tabIndex={tabIndex} className="flex cursor-pointer list-none items-center gap-2 rounded py-0.5 pointer-coarse:py-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <Icon name="ChevronRight" fallback="Circle" className="size-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
          {/* The sr-only text keeps the accessible name spaced: "Workflow progress: 3/6 steps complete". */}
          <span className="shrink-0">Workflow<span className="sr-only"> progress: </span></span>
          <StepProgress steps={entry.steps} />
          <span className="shrink-0 tabular-nums">
            {entry.steps.filter((step) => step.status === "done").length}/{entry.steps.length}
            <span className="sr-only"> steps complete</span>
          </span>
        </summary>
        <div className="pt-2 pb-1"><StepFlow entry={entry} /></div>
      </details> : null}
      {(entry.waitingReason || entry.status === "waiting on human") && entry.threadId && !finished ? (
        <button
          type="button"
          tabIndex={tabIndex}
          onClick={(event) => onAnswer(entry.id, event.currentTarget)}
          className="group flex items-start gap-1.5 rounded-md bg-muted px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={entry.waitingKind === "approval" ? "Open the report to approve it" : "Open the question to answer it"}
        >
          <Icon name="MessageCircleQuestion" fallback="MessageSquare" className="mt-0.5 size-3.5 shrink-0" style={{ color: STATUS.warning }} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-3" title={entry.waitingReason ?? undefined}>{entry.waitingReason ?? "Waiting on you"}</span>
            <span className="mt-1 inline-flex items-center gap-1 font-medium text-muted-foreground group-hover:text-foreground">
              {entry.waitingKind === "approval" ? "Review & approve" : entry.waitingKind === "escalation" || entry.waitingKind === "no_report" || entry.waitingKind === "stalled" ? "Decide" : entry.waitingKind === "cos_error" ? "Details" : "Answer here"} <Icon name="ChevronRight" fallback="Circle" className="size-3" aria-hidden />
            </span>
          </span>
        </button>
      ) : null}
      {entry.lastError && !finished && entry.detail !== "retrying" && entry.detail !== "ready" && entry.waitingKind !== "cos_error" ? (
        <p className="flex items-start gap-1.5 text-sm text-foreground">
          <Icon name="CircleAlert" fallback="Circle" className="mt-0.5 size-3.5 shrink-0" style={{ color: STATUS.serious }} aria-hidden />
          <span className="line-clamp-2">{entry.lastError}</span>
        </p>
      ) : null}
      <dl className="mt-auto flex flex-wrap gap-x-3 gap-y-1 text-xs [&>div]:flex [&>div]:items-center [&>div]:gap-1.5">
        <div className="min-w-0">
          <dt className="flex items-center gap-1.5 text-muted-foreground"><Icon name="Activity" className="size-3.5" aria-hidden />Last activity</dt>
          <dd className="font-medium text-foreground">{relative(entry.lastActivityAt ?? entry.startedAt, now)}</dd>
        </div>
        {entry.usage?.totalTokens != null ? <div>
          <dt className="flex items-center gap-1.5 text-muted-foreground"><Icon name="Coins" className="size-3.5" aria-hidden />Tokens</dt>
          <dd className="font-medium text-foreground tabular-nums">{compact(entry.usage.totalTokens)}</dd>
        </div> : null}
        {entry.usage?.cost != null ? <div>
          <dt className="flex items-center gap-1.5 text-muted-foreground"><Icon name="Coins" className="size-3.5" aria-hidden />Cost</dt>
          <dd className="font-medium text-foreground tabular-nums">{entry.usage.cost.amount.toFixed(2)} {entry.usage.cost.currency}</dd>
        </div> : null}
        {entry.fixAttempts > 0 ? <div>
          <dt className="flex items-center gap-1.5 text-muted-foreground"><Icon name="RefreshCw" className="size-3.5" aria-hidden />Fix cycles</dt>
          <dd className="font-medium text-foreground tabular-nums">{entry.fixAttempts}</dd>
        </div> : null}
      </dl>
      {/* More actions sits outside the wrapping group, so it stays at the end of the first row instead of wrapping onto a line of its own. */}
      <div className="flex items-start gap-1.5 border-t border-border pt-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {entry.threadId ? (
            <Button size="sm" className="h-7 px-2 pointer-coarse:h-10" tabIndex={tabIndex} onClick={() => navigate.toThread(entry.threadId!)}>
              <Icon name="MessageSquare" fallback="Circle" aria-hidden /> Open thread
            </Button>
          ) : null}
          {/* Without a Workflow progress row, the arrow keys land here rather than on the issue link, which leaves the plugin. */}
          <Button {...(entry.steps.length ? {} : { [ENTRY_ATTRIBUTE]: "" })} size="sm" variant="outline" className="h-7 px-2 pointer-coarse:h-10" tabIndex={tabIndex} onClick={(event) => onWorkflow(entry.id, event.currentTarget)}>
            <Icon name="Network" fallback="Workflow" aria-hidden /> Workflow
          </Button>
          {entry.prUrl ? (
            <UrlLink href={entry.prUrl} tabIndex={tabIndex} className="inline-flex h-7 items-center gap-1 rounded-md border border-input px-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-10">
              <Icon name="GitPullRequest" fallback="Circle" className="size-3.5" aria-hidden />
              PR #{entry.prNumber}
            </UrlLink>
          ) : null}
          {entry.prUrl && entry.pr ? <PrStatePill pr={entry.pr} compact /> : null}
          {entry.waitingKind === "approval" ? (
            <Button size="sm" className="h-7 px-2 pointer-coarse:h-10" tabIndex={tabIndex} disabled={busy} onClick={() => onAction(entry.id, "approve")}>
              <Icon name="Check" fallback="Circle" aria-hidden /> Approve
            </Button>
          ) : needsHuman && entry.waitingKind !== "question" ? (
            <Button size="sm" className="h-7 px-2 pointer-coarse:h-10" tabIndex={tabIndex} disabled={busy} onClick={() => onAction(entry.id, "retry")}>
              <Icon name={entry.waitingKind === "cos_error" ? "RotateCcw" : "Play"} fallback="Circle" aria-hidden /> {entry.waitingKind === "cos_error" ? "Retry step" : "Resume"}
            </Button>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={menuTrigger} size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0 pointer-coarse:size-10" aria-label="More actions" tabIndex={tabIndex} disabled={busy}>
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
              onShowActivity({ id: entry.id, label: taskLabel({ workItemId: entry.id, issueNumber: entry.issueNumber, issueTitle: entry.issueTitle || null }) ?? title });
            }}
          >
            {onShowActivity ? (
              <DropdownMenuItem onSelect={() => { showingActivity.current = true; }}>
                <Icon name="Activity" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
                Show activity
              </DropdownMenuItem>
            ) : null}
            {entry.detail === "done" ? (
              // A re-run puts a done task back to work; the sheet asks before running it. Focus returns to More actions,
              // because this item is gone once the menu closes.
              <DropdownMenuItem onSelect={() => onWorkflow(entry.id, menuTrigger.current!, "list")}>
                <Icon name="RotateCcw" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
                Run a step again…
              </DropdownMenuItem>
            ) : entry.detail === "failed" ? (
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
                <DropdownMenuItem onSelect={() => onAction(entry.id, "retry")}>
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
      </div>
      <ConfirmDialog
        open={confirming.open}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.confirmLabel}
        tone={confirmCopy.tone}
        onConfirm={() => {
          onAction(entry.id, confirmCopy.action);
          closeConfirm();
        }}
        onCancel={closeConfirm}
        restoreFocus={focusTrigger}
      />
    </article>
  );
}

// ---------- new task ----------

// ---------- pipeline tab ----------

/** The Throughput panel, the skip link's target. One Pipeline tab is mounted at a time. */
const THROUGHPUT_ID = "cos-throughput";
const TASK_KEYS_HINT_ID = "cos-task-keys";
/** cos_since's input on a first visit, when the query is off: valid, never sent. */
const FIRST_VISIT = "1970-01-01T00:00:00.000Z";
const isFinished = (e: RosterEntry) => e.detail === "done" || e.detail === "failed";
/** Each item of the stage filter row: keeps its width in the phone's single scrolling row. */
const FILTER_CHIP = "shrink-0 whitespace-nowrap";

/** What the header knows about changes since the last visit. `baseline` is null on a first visit. */
type SinceState = { baseline: string | null; data: Since | undefined; pending: boolean };

/** Reasons can be whole error messages; the header keeps them to one short phrase. */
const REASON_MAX = 80;
function clip(text: string, max = REASON_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Why a failure ended, in the header: the card's reason, or the outcome's label when it has none. */
function failureWhy(failure: Since["failures"][number]): string {
  return failure.reason ?? OUTCOME_META[failure.outcome].label;
}

const SINCE_LINK = "rounded font-medium text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * "Since you were here (3h ago): 3 shipped · 1 failed (Thread archived) · Nothing waits on you" (#110). Only the
 * non-zero counts show; each opens the finished tasks. Two or more failures are listed below, three at most.
 */
function SinceLine({ baseline, data, nothingWaits, onShowFinished, now }: { baseline: string; data: Since; nothingWaits: boolean; onShowFinished: () => void; now: number }) {
  const [first] = data.failures;
  const listed = data.failed >= 2 ? data.failures : [];
  return (
    <div className="flex flex-col gap-1">
      {/* Inline text with real spaces, so it wraps as a sentence and reads as one. */}
      <p className="text-sm text-foreground [overflow-wrap:anywhere]">
        <Icon name="History" fallback="Clock" className="mr-1.5 inline size-3.5 align-[-2px] text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">Since you were here (<time dateTime={baseline} title={new Date(baseline).toLocaleString()}>{relative(baseline, now)}</time>):</span>{" "}
        {data.shipped ? <button type="button" className={SINCE_LINK} onClick={onShowFinished}>{data.shipped} shipped</button> : null}
        {data.shipped && data.failed ? " · " : null}
        {data.failed ? <button type="button" className={SINCE_LINK} onClick={onShowFinished}>{data.failed} failed</button> : null}
        {data.failed === 1 && first ? <> (<span title={failureWhy(first)}>{clip(failureWhy(first))}</span>)</> : null}
        {nothingWaits ? <span className="text-muted-foreground"> · Nothing waits on you</span> : null}
      </p>
      {listed.length ? (
        <ul className="flex flex-col gap-0.5 pl-5 text-xs text-muted-foreground">
          {listed.map((f) => (
            <li key={f.id} className="truncate" title={`${taskLabel({ workItemId: f.id, issueNumber: f.issueNumber, issueTitle: f.issueTitle })} — ${failureWhy(f)}`}>
              <span className="text-foreground">{taskLabel({ workItemId: f.id, issueNumber: f.issueNumber, issueTitle: f.issueTitle })}</span> — {clip(failureWhy(f))}
            </li>
          ))}
          {data.failed > listed.length ? <li>and {data.failed - listed.length} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/** The agents line: "1 agent working", "3 agents working", "no agents working". */
function agentsWorking(n: number): string {
  return n === 0 ? "no agents working" : `${n} ${n === 1 ? "agent" : "agents"} working`;
}

/**
 * The top of the Pipeline tab (#110): what waits on you, or "All clear" with the agents working. The waiting part
 * is the former Needs attention row, unchanged; it drills into the matching filter. Nothing is called clear before
 * the tasks have loaded.
 */
function PipelineSummary({ loaded, loading, agents, failures, stalled, humanInput, filter, onFilter, since, onShowFinished, now }: { loaded: boolean; loading: boolean; agents: number; failures: number; stalled: number; humanInput: number; filter: TaskFilter; onFilter: (filter: TaskFilter) => void; since: SinceState; onShowFinished: () => void; now: number }) {
  const waiting = failures + stalled + humanInput;
  const changed = since.data !== undefined && since.data.shipped + since.data.failed > 0;
  // All clear needs the tasks loaded, nothing waiting, and nothing finished since the last visit. The since counts
  // count once known; on a first visit or when they fail to load, the current state decides alone.
  const clear = loaded && waiting === 0 && !since.pending && !changed;
  const shown = changed || waiting > 0 || clear;
  // Still loading with nothing to say yet: one line of skeleton. Failed with nothing to say: no empty box.
  if (!shown) {
    if (!loading && !since.pending) return null;
    return (
      <section aria-label="Summary" className="rounded-lg border border-border bg-card px-3 py-2">
        <LoadingRegion label="Loading the summary…" className="flex items-center gap-2">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <Skeleton className="h-4 w-full max-w-sm" />
        </LoadingRegion>
      </section>
    );
  }
  return (
    <section aria-label="Summary" className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2">
      {changed && since.baseline ? <SinceLine baseline={since.baseline} data={since.data!} nothingWaits={loaded && waiting === 0} onShowFinished={onShowFinished} now={now} /> : null}
      {waiting > 0 ? (
        <div role="group" aria-label="Needs attention" className="flex flex-wrap items-center gap-2">
          <span className="mr-2 flex items-center gap-2 text-sm font-semibold text-foreground"><StateMark icon="Hand" tone="warning" />Needs attention</span>
          {failures ? <Button size="sm" className="h-auto min-h-8 max-w-full whitespace-normal text-left" variant="ghost" aria-pressed={filter === "failures"} onClick={() => onFilter("failures")}>
            <Icon name="CircleAlert" style={{ color: STATUS.critical }} aria-hidden /> {failures} {failures === 1 ? "failure" : "failures"} needing a decision
          </Button> : null}
          {stalled ? <Button size="sm" variant="ghost" aria-pressed={filter === "stalled"} onClick={() => onFilter("stalled")}>
            <Icon name="Hourglass" style={{ color: STATUS.serious }} aria-hidden /> {stalled} stalled
          </Button> : null}
          {humanInput ? <Button size="sm" className="h-auto min-h-8 max-w-full whitespace-normal text-left" variant="ghost" aria-pressed={filter === "input"} onClick={() => onFilter("input")}>
            <Icon name="Hand" style={{ color: STATUS.warning }} aria-hidden /> {humanInput} questions or approvals
          </Button> : null}
        </div>
      ) : clear ? (
        <p className="flex items-center gap-2 text-sm text-foreground">
          <StateMark icon="CircleCheck" tone="good" />
          <span><span className="font-semibold">All clear</span> — {agentsWorking(agents)}</span>
        </p>
      ) : null}
    </section>
  );
}

export function PipelineTab({ onShowActivity }: { onShowActivity?: (task: ActivityTask) => void } = {}) {
  const rpc = useRpc<Contract>();
  const now = useNow();
  const [includeDone, setIncludeDone] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [throughputTable, setThroughputTable] = useState(false);
  const roster = experimental_useRpcQuery<Contract, "cos_roster">({ contract: rpcContract, method: "cos_roster", input: { includeDone, withUsage: true } });
  const stats = experimental_useRpcQuery<Contract, "cos_stats">({ contract: rpcContract, method: "cos_stats", input: { windowDays: WINDOW_DAYS } });
  const overview = experimental_useRpcQuery<Contract, "cos_overview">({ contract: rpcContract, method: "cos_overview", input: null });
  // This browser tab's last visit (#110); null on a first visit, which asks for no since counts.
  const baseline = useVisitBaseline();
  const since = experimental_useRpcQuery<Contract, "cos_since">({ contract: rpcContract, method: "cos_since", input: { since: baseline ?? FIRST_VISIT }, enabled: baseline !== null });
  const refetchAll = useCallback(async () => {
    await Promise.all([roster.refetch(), stats.refetch(), overview.refetch(), ...(baseline !== null ? [since.refetch()] : [])]);
  }, [roster, stats, overview, since, baseline]);
  useLiveRefresh(refetchAll);
  const sinceState: SinceState = baseline === null
    ? { baseline: null, data: undefined, pending: false }
    : { baseline, data: since.data, pending: since.data === undefined && !since.error };
  const tasksHeading = useRef<HTMLHeadingElement>(null);
  const [pausing, setPausing] = useState(false);
  // Every task with an action in flight: one finishing must not re-enable another's buttons.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [answering, setAnswering] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [viewing, setViewing] = useState<{ id: string; mode: SheetMode } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Closing a sheet returns focus to the card button that opened it, or to the heading when that button is gone.
  const sheetFocus = useSheetFocus<HTMLHeadingElement>();
  const throughputHeading = useRef<HTMLHeadingElement>(null);
  const act = useCallback(
    async (id: string, action: ItemAction) => {
      setBusy((ids) => new Set(ids).add(id));
      setActionError(null);
      try {
        await rpc.call("cos_item_action", { id, action });
        await refetchAll();
      } catch (error) {
        setActionError(errorText(error));
      } finally {
        setBusy((ids) => {
          const next = new Set(ids);
          next.delete(id);
          return next;
        });
      }
    },
    [rpc, refetchAll],
  );

  const live = roster.data?.entries;
  const liveEntries = useMemo(() => live ?? [], [live]);
  // Counts and attention come from the live query's active items, never from finished pages.
  const active = liveEntries.filter((e) => !isFinished(e));
  // Finished pages loaded with "Show older finished": the live query's finished
  // items at the first click, then each older page. The live query wins on
  // duplicates (a retried item is active again).
  const [older, setOlder] = useState<{ entries: RosterEntry[]; before: string | null } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderRequest = useRef<{ generation: number; inFlight: boolean }>({ generation: 0, inFlight: false });
  const olderCursor = !includeDone ? null : older ? older.before : (roster.data?.nextBefore ?? null);
  const entries = useMemo(() => {
    if (!older) return liveEntries;
    const ids = new Set(liveEntries.map((e) => e.id));
    return [...liveEntries, ...older.entries.filter((e) => !ids.has(e.id))];
  }, [liveEntries, older]);
  const toggleFinished = () => {
    olderRequest.current = { generation: olderRequest.current.generation + 1, inFlight: false };
    setOlder(null);
    setLoadingOlder(false);
    setIncludeDone((v) => !v);
  };
  // The since counts open the finished tasks: all of them, with the task list in view (#110).
  const showFinished = () => {
    if (!includeDone) toggleFinished();
    setFilter("all");
    tasksHeading.current?.focus({ preventScroll: true });
    tasksHeading.current?.scrollIntoView?.({ block: "start" });
  };
  const loadOlder = async () => {
    const request = olderRequest.current;
    if (!olderCursor || request.inFlight) return;
    request.inFlight = true;
    setLoadingOlder(true);
    setActionError(null);
    const snapshot = liveEntries.filter(isFinished);
    try {
      const page = await rpc.call("cos_roster", { includeDone: true, before: olderCursor, withUsage: true });
      if (olderRequest.current !== request) return;
      setOlder((prev) => {
        const base = prev?.entries ?? snapshot;
        const seen = new Set(base.map((e) => e.id));
        return { entries: [...base, ...page.entries.filter((e) => !seen.has(e.id))], before: page.nextBefore ?? null };
      });
    } catch (error) {
      if (olderRequest.current === request) setActionError(errorText(error));
    } finally {
      request.inFlight = false;
      if (olderRequest.current === request) setLoadingOlder(false);
    }
  };
  const byStage = useMemo(() => {
    const counts = Object.fromEntries(STAGES.map((s) => [s.key, 0])) as Record<StageKey, number>;
    for (const e of active) {
      const s = stageOf(e);
      if (s) counts[s.key]++;
    }
    return counts;
  }, [active]);
  const s = stats.data;
  const maxTotal = overview.data?.settings.maxConcurrentTotal ?? 0;
  // The setting defaults to on; until the overview loads, assume it.
  const archivesOnDone = overview.data?.settings.archiveThreadsOnDone ?? true;
  const running = overview.data?.occupiedCapacity ?? active.filter((e) => e.occupiesCapacity).length;
  const stalled = active.filter((e) => attentionKind(e) === "stalled").length;
  const failures = active.filter((e) => attentionKind(e) === "failures").length;
  const humanInput = active.filter((e) => attentionKind(e) === "human").length;
  const visible = entries.filter((e) => matchesTaskFilter(e, filter));
  const roving = useRovingCards(visible.map((e) => e.id));
  const moveCard = roving.move;
  // j and k move between task cards from anywhere on the page, like the arrow keys inside the grid (#110).
  // Off while a sheet is open; shortcutBlocked covers typing, modifiers, menus and confirm dialogs.
  const sheetOpen = answering !== null || viewing !== null;
  useEffect(() => {
    if (sheetOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "j" && event.key !== "k") || shortcutBlocked(event)) return;
      if (moveCard(event.key === "j" ? 1 : -1)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sheetOpen, moveCard]);
  const filterLabel = filter === "failures" ? "Failures needing a decision" : filter === "stalled" ? "Stalled work" : filter === "input" ? "Questions and approvals" : STAGES.find((st) => st.key === filter)?.label;
  const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="flex flex-col gap-4">
      <QueryErrors errors={[roster.error, stats.error, overview.error, baseline !== null ? since.error : null, actionError]} />
      <div className="relative flex flex-wrap items-center justify-between gap-2">
        <h2 ref={sheetFocus.fallback} tabIndex={-1} className="rounded text-base font-semibold text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Work overview</h2>
        {/* The first tab stop after the heading: past the filters and every task card (issue #115).
            Focus moves by script; the hash is a fallback and must not reach the host's routing.
            Visible on focus, positioned so it does not push the heading row around. */}
        <a
          href={`#${THROUGHPUT_ID}`}
          onClick={(event) => {
            event.preventDefault();
            throughputHeading.current?.focus();
          }}
          className="sr-only rounded-md border border-border bg-card text-xs font-medium text-foreground focus:not-sr-only focus:absolute focus:top-full focus:left-0 focus:z-10 focus:mt-1 focus:px-2 focus:py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Skip to throughput and activity
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" aria-describedby="automation-scope" disabled={pausing || !overview.data} onClick={async () => {
            setPausing(true);
            setActionError(null);
            try {
              await rpc.call("cos_set_paused", { paused: !overview.data!.paused });
              await refetchAll();
            } catch (error) {
              setActionError(errorText(error));
            } finally {
              setPausing(false);
            }
          }}>
            <Icon name={overview.data?.paused ? "Play" : "Pause"} fallback="Circle" aria-hidden />{overview.data?.paused ? "Resume everything" : "Pause everything"}
          </Button>
          <Button size="sm" aria-expanded={newTask} aria-controls="new-task" onClick={() => setNewTask((v) => !v)}>
            <Icon name="Plus" fallback="Circle" aria-hidden /> New task
          </Button>
        </div>
      </div>
      <p id="automation-scope" className={cn("text-xs text-muted-foreground", !overview.data?.paused && "sr-only")}>
        {overview.data?.paused ? <strong className="text-foreground">Chief of Staff is paused. </strong> : null}
        {overview.data?.paused ? "New workflow actions are held until you resume." : "Pause intake and hold new workflow actions."} Already running agents and jobs can continue.
      </p>
      <PipelineSummary loaded={roster.data !== undefined} loading={roster.isLoading} agents={byStage.agent} failures={failures} stalled={stalled} humanInput={humanInput} filter={filter} onFilter={setFilter} since={sinceState} onShowFinished={showFinished} now={now} />
      {newTask ? (
        <div id="new-task">
          <NewTaskForm startTask={(input) => rpc.call("cos_start_task", input)} repos={(overview.data?.repos ?? []).map((r) => r.key)} onCancel={() => setNewTask(false)} onStarted={async () => { setNewTask(false); await refetchAll(); }} />
        </div>
      ) : null}
      {/* One row on a phone, scrolling sideways, so the first task is near the top (#110); from sm up the chips wrap.
          The padding keeps focus rings inside the scroller, which clips them; a focused chip scrolls into view. */}
      <nav aria-label="Filter active tasks" className="-mx-1 flex flex-nowrap items-center gap-1 overflow-x-auto p-1 text-xs sm:flex-wrap sm:overflow-visible">
        <Button size="sm" variant="ghost" className={FILTER_CHIP} aria-pressed={filter === "all"} onClick={() => setFilter("all")}><Icon name="LayoutGrid" aria-hidden />All tasks</Button>
        {STAGES.map((st) => <Button key={st.key} size="sm" variant="ghost" className={FILTER_CHIP} aria-pressed={filter === st.key} onClick={() => setFilter(filter === st.key ? "all" : st.key)}>
          <Icon name={st.icon} aria-hidden /> {st.key === "pr" ? "Awaiting CI / merge" : st.key === "agent" ? "Tasks with agents" : st.label} <strong className="tabular-nums">{byStage[st.key]}</strong>
        </Button>)}
        <span className={cn(FILTER_CHIP, "flex items-center gap-1.5 px-2 py-1 text-muted-foreground")}><Icon name="Layers" className="size-4" aria-hidden />Task slots: {running}{maxTotal ? ` / ${maxTotal}` : ""}</span>
      </nav>
      {/* Agents */}
      <Panel
        className="border-0 bg-transparent [&>header]:px-0 [&>header]:flex-wrap [&>div]:px-0"
        title={filter === "all" ? (includeDone ? "All tasks" : "Active tasks") : filterLabel ?? "Active tasks"}
        icon="Bot"
        headingRef={tasksHeading}
        dim={roster.isFetching && !roster.isLoading}
        actions={
          <>
            {filter !== "all" ? (
              <Button size="sm" variant="ghost" onClick={() => setFilter("all")}>
                <Icon name="X" fallback="Circle" aria-hidden /> Clear filter
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" aria-pressed={includeDone} onClick={toggleFinished}>
              <Icon name={includeDone ? "EyeOff" : "History"} fallback="Circle" aria-hidden />
              {includeDone ? "Hide finished" : "Show finished"}
            </Button>
          </>
        }
      >
        {roster.isLoading ? (
          <LoadingRegion label="Loading tasks…" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => <CardSkeleton key={i} />)}
          </LoadingRegion>
        ) : null}
        {!roster.isLoading && !visible.length && (!roster.error || roster.data) ? (
          <Empty icon="Bot" illustration={filter === "all"} title={filter === "all" ? "No active tasks" : "Nothing in this stage"}>
            {filter === "all" ? "Start a described task above, or use intake to pick up matching issues." : "Pick another stage, or clear the filter."}
          </Empty>
        ) : null}
        {visible.length ? (
          // One tab stop group: Tab visits the current card's controls only, arrows move between cards (issue #115).
          <div role="group" aria-label="Tasks" aria-describedby={TASK_KEYS_HINT_ID} className="group/tasks flex flex-col gap-1.5" {...roving.groupProps}>
            {/* Above the cards, so it is on screen with the first one. Its space is kept while hidden, so
                focus entering the grid does not shift the cards. Always the group's description. */}
            <p id={TASK_KEYS_HINT_ID} className="invisible text-xs text-muted-foreground group-focus-within/tasks:visible">Arrow keys or j and k move between tasks.</p>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((e) => (
                <AgentCard key={e.id} entry={e} now={now} busy={busy.has(e.id)} tabbable={e.id === roving.current} archivesOnDone={archivesOnDone} onAction={(id, action) => void act(id, action)} onAnswer={(id, opener) => { sheetFocus.remember(opener); setAnswering(id); }} onWorkflow={(id, opener, mode = "canvas") => { sheetFocus.remember(opener); setViewing({ id, mode }); }} onShowActivity={onShowActivity} />
              ))}
            </div>
          </div>
        ) : null}
        {/* Stage and attention filters never match finished tasks. */}
        {olderCursor && filter === "all" ? (
          <div className="mt-3 flex justify-center">
            <Button size="sm" variant="outline" disabled={loadingOlder} aria-busy={loadingOlder} onClick={() => void loadOlder()}>
              <Icon name="History" fallback="Circle" aria-hidden />Show older finished
            </Button>
          </div>
        ) : null}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-5">
        <Panel id={THROUGHPUT_ID} headingRef={throughputHeading} className="lg:col-span-3" title={`Throughput · last ${WINDOW_DAYS} days`} icon="ChartColumn" dim={stats.isFetching && !stats.isLoading} actions={<ViewToggle table={throughputTable} onChange={setThroughputTable} />}>
          {s ? <p className="mb-4 text-sm text-muted-foreground">
            {s.doneInWindow} completed · {s.failedInWindow} historical failed runs
            {s.medianCycleMinutes != null ? ` · Median completion ${duration(s.medianCycleMinutes)}` : ""}
          </p> : null}
          {!s ? (
            // A failed first load is reported above the page; no placeholder waits for it.
            stats.error ? null : (
              <LoadingRegion label="Loading throughput…" className="flex flex-col gap-4">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-[120px] w-full" />
                <Skeleton className="h-3 w-full" />
              </LoadingRegion>
            )
          ) : throughputTable ? (
            <DataTable columns={["Day", "Started", "Done", "Failed"]} rows={s.daily.map((d) => [fmtDay(d.date), d.started, d.done, d.failed])} />
          ) : (
            <ColumnChart
              label={`Issues finished per day over the last ${WINDOW_DAYS} days`}
              onShowTable={() => setThroughputTable(true)}
              rows={s.daily.map((d) => ({ date: d.date, done: d.done, failed: d.failed }))}
              xKey="date"
              formatX={fmtDay}
              series={[
                { key: "done", label: "Done", color: STATUS.good, icon: "CircleCheck" },
                { key: "failed", label: "Failed", color: STATUS.critical, icon: "CircleX" },
              ]}
            />
          )}
        </Panel>
        <Panel className="lg:col-span-2" title="Capacity" icon="Gauge" dim={overview.isFetching && !overview.isLoading}>
          {!overview.data && !overview.error ? (
            <LoadingRegion label="Loading capacity…" className="flex flex-col gap-3">
              {["w-16", "w-24"].map((w) => (
                <div key={w} className="flex flex-col gap-1.5">
                  <div className="flex justify-between"><Skeleton className={cn("h-3", w)} /><Skeleton className="h-3 w-8" /></div>
                  <Skeleton className="h-2 w-full rounded-full" />
                </div>
              ))}
            </LoadingRegion>
          ) : null}
          <div className="flex flex-col gap-3">
            {/* With one repository its own meter says the same; the global cap stays in Task slots (#110). */}
            {maxTotal && overview.data?.repos.length !== 1 ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium text-foreground">All repos</span>
                  <span className="text-muted-foreground tabular-nums">
                    {overview.data?.repos.reduce((a, r) => a + r.active, 0) ?? 0} / {maxTotal}
                  </span>
                </div>
                <Meter value={overview.data?.repos.reduce((a, r) => a + r.active, 0) ?? 0} max={maxTotal} label="All repos" />
              </div>
            ) : null}
            {(overview.data?.repos ?? []).map((r) => (
              <div key={r.key} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between text-xs">
                  <span className="truncate text-foreground">{r.key}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {r.active} / {r.maxConcurrent}
                  </span>
                </div>
                <Meter size="sm" value={r.active} max={r.maxConcurrent} label={r.key} />
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {answering ? <QuestionSheet itemId={answering} onClose={() => setAnswering(null)} onAnswered={() => void refetchAll()} restoreFocus={sheetFocus.restore} /> : null}
      {viewing ? <WorkflowSheet id={viewing.id} initialMode={viewing.mode} onClose={() => setViewing(null)} onChanged={() => void refetchAll()} restoreFocus={sheetFocus.restore} /> : null}
    </div>
  );
}

// ---------- repos & PRs tab ----------

function IntakeSummary({ results, dryRun }: { results: IntakeResult[]; dryRun: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {results.map((r) => (
        <div key={r.repo} className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground">{r.repo}</span>
            {r.error ? <StatusPill tone="critical" label="Error" /> : <StatusPill tone={dryRun ? "info" : "good"} label={dryRun ? "Dry run" : "Done"} icon={dryRun ? "Eye" : undefined} />}
          </div>
          {r.error ? <p className="text-xs text-foreground">{r.error}</p> : null}
          <div className="grid grid-cols-3 gap-2 text-center">
            {(
              [
                ["Matched", r.considered],
                [dryRun ? "Would start" : "Started", r.started.length],
                ["Skipped", r.skipped.length],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-md bg-muted px-2 py-1.5">
                <div className="text-xl font-semibold text-foreground tabular-nums">{n}</div>
                <div className="text-[11px] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
          {r.started.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {r.started.map((s) => (
                <li key={s.issue}>
                  <StatusPill tone="info" icon="Play" label={`#${s.issue}`} />
                </li>
              ))}
            </ul>
          ) : null}
          {r.skipped.length ? (
            <ul className="flex flex-col gap-1 text-xs">
              {r.skipped.map((s) => (
                <li key={s.issue} className="flex gap-2">
                  <span className="font-medium text-foreground tabular-nums">#{s.issue}</span>
                  <span className="text-muted-foreground">{s.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ReposTab() {
  const rpc = useRpc<Contract>();
  const now = useNow();
  const overview = experimental_useRpcQuery<Contract, "cos_overview">({ contract: rpcContract, method: "cos_overview", input: null });
  const roster = experimental_useRpcQuery<Contract, "cos_roster">({ contract: rpcContract, method: "cos_roster", input: { includeDone: true, finishedLimit: 200, withUsage: false } });
  const refetchAll = useCallback(async () => {
    await Promise.all([overview.refetch(), roster.refetch()]);
  }, [overview, roster]);
  useLiveRefresh(refetchAll);
  const [intake, setIntake] = useState<{ results: IntakeResult[]; dryRun: boolean } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  // Closing the workflow sheet returns focus to the row's Workflow button, or to the panel heading when the row is gone.
  const sheetFocus = useSheetFocus<HTMLHeadingElement>();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runIntake = async (repo?: string, dryRun = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await rpc.call("cos_intake_now", repo ? { repo, dryRun } : { dryRun });
      setIntake({ results: result.results, dryRun });
      await refetchAll();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const setRepoPaused = async (repo: string, paused: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      await rpc.call("cos_set_repo_paused", { repo, paused });
      await refetchAll();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const prs = (roster.data?.entries ?? []).filter((e) => e.prNumber);
  const data = overview.data;
  const authOk = data?.tokenSource !== "none";
  return (
    <div className="flex flex-col gap-4">
      <QueryErrors errors={[overview.error, roster.error, message]} />
      {data?.errors.map((e) => <ErrorLine key={e} error={e} />)}
      {data?.warnings.length ? (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2">
          {data.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 text-xs text-foreground">
              <Icon name="TriangleAlert" fallback="Circle" className="mt-0.5 size-3.5 shrink-0" style={{ color: STATUS.warning }} aria-hidden />
              {w}
            </p>
          ))}
        </div>
      ) : null}
      <Panel
        title="Repositories"
        icon="FolderGit2"
        dim={overview.isFetching && !overview.isLoading}
        actions={
          <>
            {data ? <StatusPill tone={authOk ? "good" : "critical"} label={data.tokenSource === "setting" ? "GitHub token" : data.tokenSource === "gh-cli" ? "gh CLI auth" : "No GitHub auth"} icon={authOk ? "KeyRound" : "CircleX"} /> : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void runIntake(undefined, true)}>
              <Icon name="Eye" fallback="Circle" aria-hidden /> Dry-run intake
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void runIntake()}>
              <Icon name="Play" fallback="Circle" aria-hidden /> Run intake now
            </Button>
          </>
        }
      >
        {data && !data.repos.length ? <Empty icon="FolderGit2" title="No repositories configured">
            <ConfigureLink section="repos" label="Add a repository" />
          </Empty> : null}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(data?.repos ?? []).map((r) => (
            <article key={r.key} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-foreground">{r.key}</h3>
                  <p className="flex flex-wrap gap-1 pt-1">
                    {r.labels.length ? (
                      r.labels.map((l) => (
                        <span key={l} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground">
                          <Icon name="Tag" fallback="Circle" className="size-3 text-muted-foreground" aria-hidden />
                          {l}
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-muted-foreground">no label filter</span>
                    )}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-2xl font-semibold leading-none text-foreground tabular-nums">
                    {r.active}
                    <span className="text-sm font-normal text-muted-foreground">/{r.maxConcurrent}</span>
                  </div>
                  <div className="text-[11px] whitespace-nowrap text-muted-foreground">tasks using capacity</div>
                </div>
              </div>
              <Meter size="sm" value={r.active} max={r.maxConcurrent} label={`${r.key} task slots`} />
              <ol className="flex flex-wrap items-center gap-1 text-[11px]" aria-label="Workflow">
                <li className="flex items-center gap-1 pr-1 font-medium text-foreground">
                  <Icon name="Workflow" fallback="Circle" className="size-3" aria-hidden /> {r.workflowName}:
                </li>
                {r.stepNames.map((st, i) => (
                  <li key={`${st}-${i}`} className="flex items-center gap-1">
                    <span className="rounded-md border border-border px-1.5 py-0.5 text-foreground">{st}</span>
                    {i < r.stepNames.length - 1 ? <Icon name="ChevronRight" fallback="Circle" className="size-3 text-muted-foreground" aria-hidden /> : null}
                  </li>
                ))}
              </ol>
              {r.paused ? <StatusPill tone="neutral" icon="Pause" label="Project paused" /> : null}
              {!r.intake ? <StatusPill tone="neutral" icon="Pause" label="Intake paused" /> : null}
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy || r.paused} onClick={() => void runIntake(r.key)}>
                  <Icon name="Inbox" fallback="Circle" aria-hidden /> Intake
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} aria-label={`${r.paused ? "Resume" : "Pause"} project ${r.key}`} onClick={() => void setRepoPaused(r.key, !r.paused)}>
                  <Icon name={r.paused ? "Play" : "Pause"} fallback="Circle" aria-hidden /> {r.paused ? "Resume" : "Pause"}
                </Button>
              </div>
            </article>
          ))}
        </div>
      </Panel>
      {intake ? (
        <Panel title={intake.dryRun ? "Intake preview" : "Intake result"} icon="Inbox" actions={<Button size="sm" variant="ghost" onClick={() => setIntake(null)}><Icon name="X" fallback="Circle" aria-hidden /> Close</Button>}>
          <IntakeSummary results={intake.results} dryRun={intake.dryRun} />
        </Panel>
      ) : null}
      <Panel title="Pull requests" icon="GitPullRequest" headingRef={sheetFocus.fallback} dim={roster.isFetching && !roster.isLoading}>
        <PullRequestList
          entries={prs}
          now={now}
          authOk={authOk}
          stage={(e) => <StagePill entry={e} />}
          action={(e) => (
            <Button size="sm" variant="outline" className="ml-auto h-7 px-2" onClick={(event) => { sheetFocus.remember(event.currentTarget); setViewing(e.id); }}>
              <Icon name="Network" fallback="Workflow" aria-hidden /> Workflow
            </Button>
          )}
          empty={roster.error && !roster.data ? null : <Empty icon="GitPullRequest" title="No pull requests yet">Pull requests opened by Chief of Staff agents show up here with their state, checks and review.</Empty>}
        />
      </Panel>
      {viewing ? <WorkflowSheet id={viewing} onClose={() => setViewing(null)} onChanged={() => void refetchAll()} restoreFocus={sheetFocus.restore} /> : null}
    </div>
  );
}

// ---------- activity feed ----------

const LEVEL: Record<string, { tone: Tone; icon: string; label: string }> = {
  info: { tone: "info", icon: "Info", label: "Info" },
  warn: { tone: "warning", icon: "TriangleAlert", label: "Warning" },
  error: { tone: "critical", icon: "CircleX", label: "Error" },
};

const MOBILE_ACTIVITY_ROWS = 12;

/** Activity text as written, with each thread id a link to its thread. */
function ThreadLinkedText({ text, onThread }: { text: string; onThread: (id: string) => void }) {
  return (
    <>
      {splitThreadIds(text).map((part, i) =>
        typeof part === "string" ? (
          part
        ) : (
          <button
            key={i}
            type="button"
            className="rounded underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`Open thread ${part.thread}`}
            onClick={() => onThread(part.thread)}
          >
            {part.thread}
          </button>
        ),
      )}
    </>
  );
}

/**
 * The latest activity, newest first. It can be narrowed to one task: pass `task` and `onTaskChange` to hold that
 * choice outside (a card's "Show activity" sets it), or leave them out and the feed keeps it itself.
 */
export function ActivityFeed({ task: taskProp, onTaskChange, headingRef }: { task?: ActivityTask | null; onTaskChange?: (task: ActivityTask | null) => void; headingRef?: RefObject<HTMLHeadingElement | null> } = {}) {
  const palette = usePalette();
  const navigate = useBbNavigate();
  const toThread = useCallback((id: string) => navigate.toThread(id), [navigate]);
  const now = useNow();
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [ownTask, setOwnTask] = useState<ActivityTask | null>(null);
  const task = onTaskChange ? (taskProp ?? null) : ownTask;
  const setTask = onTaskChange ?? setOwnTask;
  const taskTrigger = useRef<HTMLButtonElement>(null);
  // Set by the clear button: once the feed has re-rendered, focus the Task menu, or the heading when it is gone.
  const focusAfterClear = useRef(false);
  // Phones get no nested scroll box: show the latest rows and expand in place.
  const [showAll, setShowAll] = useState(false);
  // A cursor belongs to the task filter it was read under: choosing or clearing a task (here or from a card)
  // returns to that filter's newest page in the same render, so no request goes out with another filter's cursor.
  const taskId = task?.id ?? null;
  const [cursor, setCursor] = useState<{ taskId: string | null; before: number } | null>(null);
  const before = cursor && cursor.taskId === taskId ? cursor.before : undefined;
  const setBefore = (next: number | undefined) => setCursor(next === undefined ? null : { taskId, before: next });
  // A task's own rows come from the server, so its older rows are not lost behind the latest 60 of every task.
  const log = experimental_useRpcQuery<Contract, "cos_log">({ contract: rpcContract, method: "cos_log", input: { limit: 60, onlyProblems, ...(before === undefined ? {} : { before }), ...(task ? { workItemId: task.id } : {}) } });
  useEffect(() => setShowAll(false), [taskId]);
  useLiveRefresh(log.refetch);
  // With one repository its name on every row says nothing; rows of any other (removed) repository keep theirs.
  // Unknown or failed: keep every name (the tab beside the feed shows the error, and refreshes this query).
  const overview = experimental_useRpcQuery<Contract, "cos_overview">({ contract: rpcContract, method: "cos_overview", input: null });
  const onlyRepo = overview.data?.repos.length === 1 ? overview.data.repos[0]!.key : null;
  // The tasks to offer: every task seen while the feed is open, so the list survives narrowing.
  const [seen, setSeen] = useState<ActivityTask[]>([]);
  useEffect(() => {
    if (!log.data) return;
    setSeen((before) => {
      const next = recentTasks(log.data!.entries, before);
      return next.length === before.length && next.every((t, i) => t.id === before[i]!.id && t.label === before[i]!.label) ? before : next;
    });
  }, [log.data]);
  const taskOptions = task && !seen.some((t) => t.id === task.id) ? [task, ...seen] : seen;
  // The feed opens a task's workflow itself: it sits beside the tabs, not inside the Pipeline tab.
  const [viewing, setViewing] = useState<string | null>(null);
  const sheetFocus = useSheetFocus<HTMLHeadingElement>();
  const heading = useCallback(
    (element: HTMLHeadingElement | null) => {
      sheetFocus.fallback.current = element;
      if (headingRef) headingRef.current = element;
    },
    [sheetFocus.fallback, headingRef],
  );
  useEffect(() => {
    if (task || !focusAfterClear.current) return;
    focusAfterClear.current = false;
    (taskTrigger.current?.isConnected ? taskTrigger.current : sheetFocus.fallback.current)?.focus();
  }, [task, sheetFocus.fallback]);
  const entries = log.data?.entries ?? [];
  return (
    <Panel
      title="Activity"
      icon="Activity"
      headingRef={heading}
      dim={log.isFetching && !log.isLoading}
      actions={
        <>
          {taskOptions.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button ref={taskTrigger} size="sm" variant="ghost" className="max-w-full">
                  <Icon name="ListFilter" fallback="Filter" aria-hidden />
                  {task ? (
                    <span className="flex min-w-0">
                      Task:&nbsp;<span className="max-w-[12rem] truncate" title={task.label}>{task.label}</span>
                    </span>
                  ) : (
                    "Task"
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-[min(24rem,90vw)]">
                {taskOptions.map((t) => (
                  <DropdownMenuItem key={t.id} onSelect={() => setTask(t)}>
                    <span className="truncate" title={t.label}>{t.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {task ? (
            <Button
              size="sm"
              variant="ghost"
              className="w-8 p-0"
              aria-label="Show all activity"
              onClick={() => {
                focusAfterClear.current = true;
                setTask(null);
              }}
            >
              <Icon name="X" fallback="Circle" aria-hidden />
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-pressed={onlyProblems} onClick={() => { setOnlyProblems((v) => !v); setBefore(undefined); setShowAll(false); }}>
            <Icon name="TriangleAlert" fallback="Circle" aria-hidden /> Problems only
          </Button>
        </>
      }
    >
      <ErrorLine error={log.error} />
      {log.isLoading && !log.data ? (
        <LoadingRegion label="Loading activity…" className="flex flex-col gap-2.5">
          {["w-4/5", "w-3/5", "w-2/3"].map((w) => <Skeleton key={w} className={cn("h-3.5", w)} />)}
        </LoadingRegion>
      ) : null}
      {log.data && !entries.length ? <p className="text-sm text-muted-foreground">{before !== undefined ? "No older activity remains within retention." : onlyProblems ? "No warnings or errors within retention." : task ? "No activity for this task." : "No activity yet."}</p> : null}
      {entries.length > 0 ? <p className="mb-2 text-xs text-muted-foreground">
        {entries.length} entries · {new Date(entries.at(-1)!.at).toLocaleString()} – {new Date(entries[0]!.at).toLocaleString()}
      </p> : null}
      <ol className="sm:max-h-80 sm:overflow-auto">
        {entries.map((e, i) => {
          const l = LEVEL[e.level] ?? LEVEL.info!;
          const rowTask = taskLabel(e);
          return (
            <li key={e.id} className={cn("flex-wrap items-start gap-x-2.5 gap-y-0.5 py-1.5 text-xs sm:flex-nowrap", !showAll && i >= MOBILE_ACTIVITY_ROWS ? "hidden sm:flex" : "flex")}>
              <Icon name={l.icon} fallback="Circle" className="mt-0.5 size-3.5 shrink-0" style={{ color: toneColor(l.tone, palette) }} aria-label={l.label} />
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{e.kind}</span>
              <time className="ml-auto shrink-0 text-muted-foreground tabular-nums sm:order-last sm:ml-0" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                {relative(e.at, now)}
              </time>
              <span className="min-w-0 basis-full pl-6 text-foreground [overflow-wrap:anywhere] sm:flex-1 sm:basis-0 sm:pl-0">
                {e.repo && e.repo !== onlyRepo ? <span className="font-medium">{e.repo.split("/")[1] ?? e.repo} </span> : null}
                {rowTask && e.workItemId ? (
                  <>
                    <button
                      type="button"
                      className="inline-block max-w-[16rem] truncate rounded align-bottom font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      title={rowTask}
                      aria-label={`Open task ${rowTask}`}
                      onClick={(event) => {
                        sheetFocus.remember(event.currentTarget);
                        setViewing(e.workItemId);
                      }}
                    >
                      {rowTask}
                    </button>{" "}
                  </>
                ) : null}
                <ThreadLinkedText text={e.message} onThread={toThread} />
                <span className="text-muted-foreground"> · <ThreadLinkedText text={e.actor} onThread={toThread} /></span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex gap-2">
        {before !== undefined ? <Button size="sm" variant="ghost" onClick={() => { setBefore(undefined); setShowAll(false); }}>Back to newest</Button> : null}
        {log.data?.nextCursor != null ? <Button size="sm" variant="ghost" disabled={log.isFetching} onClick={() => { setBefore(log.data!.nextCursor!); setShowAll(false); }}>Show older</Button> : null}
        {log.data && log.data.nextCursor === null && entries.length > 0 ? <span className="text-xs text-muted-foreground">End of retained activity</span> : null}
      </div>
      {!showAll && entries.length > MOBILE_ACTIVITY_ROWS ? (
        <Button size="sm" variant="ghost" className="mt-1 w-full sm:hidden" onClick={() => setShowAll(true)}>
          Show {entries.length - MOBILE_ACTIVITY_ROWS} more
        </Button>
      ) : null}
      {viewing ? <WorkflowSheet id={viewing} onClose={() => setViewing(null)} onChanged={() => void log.refetch()} restoreFocus={sheetFocus.restore} /> : null}
    </Panel>
  );
}

// ---------- shell ----------

export function Dashboard({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  // Held here, above the tab switch, so unsaved configuration survives leaving Configure.
  const configDrafts = useConfigDrafts();
  const tab = useMemo<Tab>(() => {
    const first = decodeURIComponent(subPath.split("/")[0] ?? "");
    return TABS.some((t) => t.id === first) ? (first as Tab) : "agents";
  }, [subPath]);
  const goTab = useCallback((t: Tab) => navigate.toPluginPanel("cos", { subPath: t }), [navigate]);
  const [alert, setAlert] = useState<{ title: string; body: string } | null>(null);
  // Held here so a task card's "Show activity" can narrow the feed, and the choice survives switching tabs.
  const [activityTask, setActivityTask] = useState<ActivityTask | null>(null);
  const activityHeading = useRef<HTMLHeadingElement | null>(null);
  const showActivity = useCallback((task: ActivityTask) => {
    setActivityTask(task);
    const heading = activityHeading.current;
    heading?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    heading?.focus({ preventScroll: true });
  }, []);
  useRealtime("cos-alert", (payload) => {
    const p = payload as { title?: string; body?: string };
    if (p?.title) setAlert({ title: p.title, body: p.body ?? "" });
  });
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(null), 15_000);
    return () => clearTimeout(timer);
  }, [alert]);
  return (
    <PaletteProvider className="h-full overflow-auto bg-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4 md:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-card">
              <Icon name="ChefHat" fallback="Circle" className="size-5 text-foreground" aria-hidden />
            </span>
            <div>
              <h1 className="text-lg leading-tight font-semibold text-foreground">Chief of Staff</h1>
              <p className="text-xs text-muted-foreground">Plan, build, verify, review, ship. Live view of every agent.</p>
            </div>
          </div>
          <nav className="flex w-full min-w-0 overflow-x-auto rounded-lg border border-border bg-card p-1 sm:w-auto" aria-label="Dashboard tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                onClick={() => goTab(t.id)}
                className={cn("flex flex-auto shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:flex-none sm:px-3", tab === t.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                <Icon name={t.icon} fallback="Circle" className="hidden size-4 sm:block" aria-hidden />
                {t.label}
                {t.id === "config" && configDrafts.dirty ? <span aria-label="unsaved" className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS.warning }} /> : null}
              </button>
            ))}
          </nav>
        </header>
        {alert ? (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            <Icon name="BellRing" fallback="Bell" className="mt-0.5 size-4 shrink-0" style={{ color: STATUS.warning }} aria-hidden />
            <span>
              <strong className="text-foreground">{alert.title}</strong> <span className="text-muted-foreground">{alert.body}</span>
            </span>
            <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Dismiss" onClick={() => setAlert(null)}>
              <Icon name="X" fallback="Circle" className="size-4" aria-hidden />
            </button>
          </div>
        ) : null}
        {tab === "agents" ? <PipelineTab onShowActivity={showActivity} /> : tab === "issues" ? <ReposTab /> : <Configurator drafts={configDrafts} initialSection={configSection(subPath)} />}
        {tab === "config" ? null : <ActivityFeed task={activityTask} onTaskChange={setActivityTask} headingRef={activityHeading} />}
      </div>
    </PaletteProvider>
  );
}

function configSection(subPath: string): "workflow" | "repos" | "general" | "access" | "advanced" {
  const second = decodeURIComponent(subPath.split("/")[1] ?? "");
  return second === "repos" || second === "general" || second === "access" || second === "advanced" ? second : "workflow";
}

function ConfigureLink({ section, label }: { section: "repos"; label: string }) {
  const navigate = useBbNavigate();
  return (
    <Button size="sm" className="mt-2" onClick={() => navigate.toPluginPanel("cos", { subPath: `config/${section}` })}>
      <Icon name="Plus" fallback="Circle" aria-hidden /> {label}
    </Button>
  );
}

function SettingsSection() {
  const navigate = useBbNavigate();
  return (
    <PaletteProvider className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">Everything below saves to this plugin's settings. The dashboard has the same editor under Configure.</p>
        <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("cos", { subPath: "config" })}>
          Open dashboard
        </Button>
      </div>
      <Configurator compact />
    </PaletteProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "cos-dashboard", title: "Chief of Staff", icon: "chief-of-staff/chef-hat", path: "cos", component: Dashboard });
  app.slots.settingsSection({ id: "cos-config", title: "Configure Chief of Staff", description: "Workflow stages, repositories, limits and GitHub access, edited visually and validated before saving.", component: SettingsSection });
});
