// Chief of Staff — BB plugin frontend entry: dashboard nav panel + settings section.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, definePluginApp, experimental_useRpcQuery, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./rpcContract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ColumnChart, DataTable, Meter, Panel, PaletteProvider, STATUS, StatusPill, ViewToggle, compact, duration, relative, toneColor, usePalette } from "@/components/cos/viz";
import type { Tone } from "@/components/cos/viz";
import { STAGES, stageColor, stageOf } from "@/components/cos/stages";
import { WorkflowCanvas, type LiveStatus } from "@/components/cos/workflowCanvas";
import type { Workflow } from "./src/workflow";
import type { StageKey } from "@/components/cos/stages";
import { Configurator } from "@/components/cos/configurator";
import { QuestionSheet } from "@/components/cos/question";
import { StepFlow } from "@/components/cos/stepFlow";
import { StateMark, StepMiniMap, QueueIllustration } from "./components/cos/taskVisuals";
import { activitySummary } from "./components/cos/activitySummary";
import { attentionKind, matchesTaskFilter, type TaskFilter } from "./components/cos/dashboardModel";
import { NewTaskForm } from "@/components/cos/newTaskForm";

type Contract = typeof rpcContract;
type RosterEntry = PluginRpcResult<Contract["cos_roster"]>["entries"][number];
type IntakeResult = PluginRpcResult<Contract["cos_intake_now"]>["results"][number];

const TABS = [
  { id: "agents", label: "Pipeline", icon: "Workflow" },
  { id: "issues", label: "Repos & PRs", icon: "GitPullRequest" },
  { id: "config", label: "Configure", icon: "SlidersHorizontal" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const WINDOW_DAYS = 14;

function useLiveRefresh(refetch: () => Promise<void>) {
  useRealtime("cos-changed", () => {
    void refetch();
  });
}

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

function entryTone(e: RosterEntry): { tone: Tone; label: string; icon: string } {
  if (e.detail === "done") return { tone: "good", label: e.lastError ? "Closed" : "Shipped", icon: "CircleCheck" };
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

/** One task's workflow on the canvas, coloured live, with "run again from here". */
function WorkflowSheet({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const rpc = useRpc<Contract>();
  const view = experimental_useRpcQuery<Contract, "cos_item_workflow">({ contract: rpcContract, method: "cos_item_workflow", input: { id } });
  useLiveRefresh(async () => void (await view.refetch()));
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = view.data;
  const wf = data?.workflow as Workflow | undefined;
  const step = wf?.steps.find((s) => s.id === selected);
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
  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/40", !expanded && "p-4")} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Task workflow" className={cn("flex w-full flex-col gap-3 overflow-hidden border border-border bg-background p-4 shadow-lg", expanded ? "h-full" : "h-[85vh] max-w-6xl rounded-xl")}>
        <header className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{data ? `${data.title} · workflow “${wf?.name}”` : "Loading…"}</p>
            <h2 className="text-base font-semibold text-foreground">Where this task is</h2>
          </div>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Close" onClick={onClose}>
            <Icon name="X" fallback="Circle" aria-hidden />
          </Button>
        </header>
        <ErrorLine error={view.error ?? error} />
        {wf && data ? <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <WorkflowCanvas workflow={wf} live={data.live as Record<string, LiveStatus>} selected={selected} onSelect={setSelected} expanded={expanded} onToggleExpanded={() => setExpanded((v) => !v)} className="min-h-0 flex-1" />
          {step ? <aside aria-label="Step details" className="max-h-[35%] overflow-y-auto rounded-lg border border-border p-3 text-sm md:max-h-none md:w-72 md:shrink-0">
            <h3 className="font-semibold">{step.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{step.type} · {data.live[step.id]?.status ?? "pending"}</p>
            {step.instructions ? <p className="mt-3 whitespace-pre-wrap break-words">{step.instructions}</p> : null}
            {step.type === "check" ? <p className="mt-3 break-all"><b>Command:</b> {step.command}</p> : null}
            {step.type === "ship" ? <p className="mt-3"><b>Action:</b> {step.action}</p> : null}
            {step.type === "model" ? <p className="mt-3"><b>Sets:</b> {[step.providerId, step.model, step.reasoningLevel].filter(Boolean).join(" · ") || "nothing"}</p> : null}
            {step.type === "agent" ? <p className="mt-3">{step.writes ? "Writes code" : "Read-only"} · {step.agents} {step.agents === 1 ? "agent" : "agents"}{step.approval ? " · Approval required" : ""}{step.verdict ? " · Pass/fail" : ""}</p> : null}
          </aside> : null}
        </div> : null}
        <footer className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {step ? (
            <>
              <span>
                <b className="text-foreground">{step.name}</b> · {data?.live[step.id]?.status ?? "pending"}
              </span>
              <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => void rerun()}>
                <Icon name="RotateCcw" fallback="Circle" aria-hidden /> Run again from here
              </Button>
            </>
          ) : (
            <span>Select a step to run it (and everything after it) again.</span>
          )}
        </footer>
      </div>
    </div>
  );
}

// ---------- agent card ----------

type ItemAction = "retry" | "approve" | "mark_done" | "mark_failed";

function AgentCard({ entry, busy, onAction, onAnswer, onWorkflow, now }: { entry: RosterEntry; busy: boolean; onAction: (id: string, action: ItemAction) => void; onAnswer: (id: string) => void; onWorkflow: (id: string) => void; now: number }) {
  const navigate = useBbNavigate();
  const [menu, setMenu] = useState(false);
  const finished = entry.detail === "done" || entry.detail === "failed";
  const elapsedMin = (now - Date.parse(entry.startedAt)) / 60_000;
  const needsHuman = entry.status === "waiting on human" || entry.status === "blocked";
  const visual = entryTone(entry);
  return (
    <article className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4", entry.stalled || needsHuman ? "border-[color:var(--cos-attn)]" : "border-border")} style={{ ["--cos-attn" as string]: entry.stalled ? STATUS.serious : STATUS.warning }}>
      <header className="flex items-start gap-3">
        <StateMark icon={entry.stalled ? "Hourglass" : visual.icon} tone={entry.stalled ? "serious" : visual.tone} />
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">{entry.issueTitle || entry.threadTitle || "Untitled task"}</h3>
          <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            <Icon name="FolderGit2" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span title={entry.repo}>
            {entry.repo.split("/")[1] ?? entry.repo}
            {entry.issueNumber ? ` #${entry.issueNumber}` : ""}
            </span>
          </p>
        </div>
      </header>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <StagePill entry={entry} />
          {entry.stalled ? <StatusPill tone="serious" label="Stalled" icon="Hourglass" /> : null}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground tabular-nums" title={`Task started ${new Date(entry.startedAt).toLocaleString()}`} aria-label={`Task age ${duration(elapsedMin)}`}>
          <Icon name="Timer" fallback="Clock" className="size-3.5" aria-hidden />
          {finished ? relative(entry.startedAt, now) : duration(elapsedMin)}
        </span>
      </div>
      {!finished ? <ActivityLine entry={entry} /> : null}
      {entry.steps.length ? <details className="text-sm">
        <summary className="cursor-pointer rounded py-1 text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          Workflow progress · {entry.steps.filter((step) => step.status === "done").length}/{entry.steps.length} complete
          <StepMiniMap steps={entry.steps} />
        </summary>
        <div className="pt-2"><StepFlow entry={entry} /></div>
      </details> : null}
      {(entry.waitingReason || entry.status === "waiting on human") && entry.threadId && !finished ? (
        <button
          type="button"
          onClick={() => onAnswer(entry.id)}
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
      <dl className="mt-auto flex flex-wrap gap-x-5 gap-y-2 pt-2 text-sm">
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
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {entry.threadId ? (
          <Button onClick={() => navigate.toThread(entry.threadId!)}>
            <Icon name="MessageSquare" fallback="Circle" aria-hidden /> Open thread
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => onWorkflow(entry.id)}>
          <Icon name="Network" fallback="Workflow" aria-hidden /> Workflow
        </Button>
        {entry.prUrl ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-input px-2 text-sm font-medium">
            <Icon name="GitPullRequest" fallback="Circle" className="size-3.5" aria-hidden />
            <UrlLink href={entry.prUrl}>#{entry.prNumber}</UrlLink>
          </span>
        ) : null}
        {entry.waitingKind === "approval" ? (
          <Button size="sm" className="text-sm" disabled={busy} onClick={() => onAction(entry.id, "approve")}>
            <Icon name="Check" fallback="Circle" aria-hidden /> Approve
          </Button>
        ) : needsHuman && entry.waitingKind !== "question" ? (
          <Button size="sm" className="text-sm" disabled={busy} onClick={() => onAction(entry.id, "retry")}>
            <Icon name={entry.waitingKind === "cos_error" ? "RotateCcw" : "Play"} fallback="Circle" aria-hidden /> {entry.waitingKind === "cos_error" ? "Retry step" : "Resume"}
          </Button>
        ) : null}
        {!finished || entry.detail === "failed" ? (
          <div className="relative ml-auto">
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="More actions" aria-expanded={menu} disabled={busy} onClick={() => setMenu((v) => !v)}>
              <Icon name="Ellipsis" fallback="MoreHorizontal" aria-hidden />
            </Button>
            {menu ? (
              <div role="menu" className="absolute right-0 bottom-full z-20 mb-1 flex w-44 flex-col rounded-lg border border-border p-1 shadow-md" style={{ background: "var(--popover, var(--card))" }} onMouseLeave={() => setMenu(false)}>
                {(
                  [
                    ["retry", "Retry the stuck step", "RotateCcw"],
                    ["mark_done", "Mark done", "CircleCheck"],
                    ["mark_failed", "Mark failed", "CircleX"],
                  ] as const
                ).map(([action, label, icon]) => (
                  <button
                    key={action}
                    role="menuitem"
                    type="button"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-state-hover"
                    onClick={() => {
                      setMenu(false);
                      onAction(entry.id, action);
                    }}
                  >
                    <Icon name={icon} fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

// ---------- new task ----------

// ---------- pipeline tab ----------

export function PipelineTab() {
  const rpc = useRpc<Contract>();
  const now = useNow();
  const [includeDone, setIncludeDone] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [throughputTable, setThroughputTable] = useState(false);
  const roster = experimental_useRpcQuery<Contract, "cos_roster">({ contract: rpcContract, method: "cos_roster", input: { includeDone, withUsage: true } });
  const stats = experimental_useRpcQuery<Contract, "cos_stats">({ contract: rpcContract, method: "cos_stats", input: { windowDays: WINDOW_DAYS } });
  const overview = experimental_useRpcQuery<Contract, "cos_overview">({ contract: rpcContract, method: "cos_overview", input: null });
  const refetchAll = useCallback(async () => {
    await Promise.all([roster.refetch(), stats.refetch(), overview.refetch()]);
  }, [roster, stats, overview]);
  useLiveRefresh(refetchAll);
  const [pausing, setPausing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = useCallback(
    async (id: string, action: ItemAction) => {
      setBusy(id);
      setActionError(null);
      try {
        await rpc.call("cos_item_action", { id, action });
        await refetchAll();
      } catch (error) {
        setActionError(errorText(error));
      } finally {
        setBusy(null);
      }
    },
    [rpc, refetchAll],
  );

  const entries = roster.data?.entries ?? [];
  const active = entries.filter((e) => e.detail !== "done" && e.detail !== "failed");
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
  const running = overview.data?.occupiedCapacity ?? active.filter((e) => e.occupiesCapacity).length;
  const stalled = active.filter((e) => attentionKind(e) === "stalled").length;
  const failures = active.filter((e) => attentionKind(e) === "failures").length;
  const humanInput = active.filter((e) => attentionKind(e) === "human").length;
  const visible = entries.filter((e) => matchesTaskFilter(e, filter));
  const filterLabel = filter === "failures" ? "Failures needing a decision" : filter === "stalled" ? "Stalled work" : filter === "input" ? "Questions and approvals" : STAGES.find((st) => st.key === filter)?.label;
  const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="flex flex-col gap-4">
      <ErrorLine error={roster.error ?? stats.error ?? actionError} />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-700/50 bg-red-950/20 p-4">
        <div><div className="font-semibold">{overview.data?.paused ? "Chief of Staff is paused" : "Automation control"}</div><p className="text-sm text-muted-foreground">{overview.data?.paused ? "New workflow actions are held until you resume. Already running agents and jobs can continue." : "Pause intake and hold new workflow actions. Already running agents and jobs can continue."}</p></div>
        <Button size="lg" className="bg-red-700 text-white hover:bg-red-800" disabled={pausing || !overview.data} onClick={async () => { setPausing(true); setActionError(null); try { await rpc.call("cos_set_paused", { paused: !overview.data!.paused }); await refetchAll(); } catch (error) { setActionError(errorText(error)); } finally { setPausing(false); } }}><Icon name={overview.data?.paused ? "Play" : "Pause"} fallback="Circle" aria-hidden />{overview.data?.paused ? "Resume everything" : "Pause everything"}</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Work overview</h2>
          <p className="text-sm text-muted-foreground">Start a task in a configured repository, with or without an issue.</p>
        </div>
        <Button aria-expanded={newTask} aria-controls="new-task" onClick={() => setNewTask((v) => !v)}>
          <Icon name="Plus" fallback="Circle" aria-hidden /> New task
        </Button>
      </div>
      {newTask ? (
        <div id="new-task">
          <NewTaskForm startTask={(input) => rpc.call("cos_start_task", input)} repos={(overview.data?.repos ?? []).map((r) => r.key)} onCancel={() => setNewTask(false)} onStarted={async () => { setNewTask(false); await refetchAll(); }} />
        </div>
      ) : null}
      {failures + stalled + humanInput > 0 ? (
        <section aria-label="Needs attention" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
          <span className="mr-2 flex items-center gap-2 text-sm font-semibold text-foreground"><StateMark icon="Hand" tone="warning" />Needs attention</span>
          {failures ? <Button className="h-auto max-w-full whitespace-normal text-left" variant="ghost" aria-pressed={filter === "failures"} onClick={() => setFilter("failures")}>
            <Icon name="CircleAlert" style={{ color: STATUS.critical }} aria-hidden /> {failures} {failures === 1 ? "failure" : "failures"} needing a decision
          </Button> : null}
          {stalled ? <Button variant="ghost" aria-pressed={filter === "stalled"} onClick={() => setFilter("stalled")}>
            <Icon name="Hourglass" style={{ color: STATUS.serious }} aria-hidden /> {stalled} stalled
          </Button> : null}
          {humanInput ? <Button className="h-auto max-w-full whitespace-normal text-left" variant="ghost" aria-pressed={filter === "input"} onClick={() => setFilter("input")}>
            <Icon name="Hand" style={{ color: STATUS.warning }} aria-hidden /> {humanInput} questions or approvals
          </Button> : null}
        </section>
      ) : null}
      <nav aria-label="Filter active tasks" className="flex flex-wrap items-center gap-1 text-sm">
        <Button variant="ghost" aria-pressed={filter === "all"} onClick={() => setFilter("all")}><Icon name="LayoutGrid" aria-hidden />All tasks</Button>
        {STAGES.map((st) => <Button key={st.key} variant="ghost" aria-pressed={filter === st.key} onClick={() => setFilter(filter === st.key ? "all" : st.key)}>
          <Icon name={st.icon} aria-hidden /> {st.key === "pr" ? "Awaiting CI / merge" : st.key === "agent" ? "Tasks with agents" : st.label} <strong className="tabular-nums">{byStage[st.key]}</strong>
        </Button>)}
        <span className="flex items-center gap-2 px-3 py-2 text-muted-foreground"><Icon name="Layers" className="size-4" aria-hidden />Task slots: {running}{maxTotal ? ` / ${maxTotal}` : ""}</span>
      </nav>
      {/* Agents */}
      <Panel
        className="border-0 bg-transparent [&>header]:px-0 [&>header]:flex-wrap [&>div]:px-0"
        title={filter === "all" ? (includeDone ? "All tasks" : "Active tasks") : filterLabel ?? "Active tasks"}
        icon="Bot"
        dim={roster.isFetching && !roster.isLoading}
        actions={
          <>
            {filter !== "all" ? (
              <Button size="sm" variant="ghost" onClick={() => setFilter("all")}>
                <Icon name="X" fallback="Circle" aria-hidden /> Clear filter
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" aria-pressed={includeDone} onClick={() => setIncludeDone((v) => !v)}>
              <Icon name={includeDone ? "EyeOff" : "History"} fallback="Circle" aria-hidden />
              {includeDone ? "Hide finished" : "Show finished"}
            </Button>
          </>
        }
      >
        {roster.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {!roster.isLoading && !visible.length ? (
          <Empty icon="Bot" illustration={filter === "all"} title={filter === "all" ? "No active tasks" : "Nothing in this stage"}>
            {filter === "all" ? "Start a described task above, or use intake to pick up matching issues." : "Pick another stage, or clear the filter."}
          </Empty>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((e) => (
            <AgentCard key={e.id} entry={e} now={now} busy={busy === e.id} onAction={(id, action) => void act(id, action)} onAnswer={setAnswering} onWorkflow={setViewing} />
          ))}
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-5">
        <Panel className="lg:col-span-3" title={`Throughput · last ${WINDOW_DAYS} days`} icon="ChartColumn" dim={stats.isFetching && !stats.isLoading} actions={<ViewToggle table={throughputTable} onChange={setThroughputTable} />}>
          {s ? <p className="mb-4 text-sm text-muted-foreground">
            {s.doneInWindow} completed · {s.failedInWindow} historical failed runs
            {s.medianCycleMinutes != null ? ` · Median completion ${duration(s.medianCycleMinutes)}` : ""}
          </p> : null}
          {!s ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : throughputTable ? (
            <DataTable columns={["Day", "Started", "Done", "Failed"]} rows={s.daily.map((d) => [fmtDay(d.date), d.started, d.done, d.failed])} />
          ) : (
            <ColumnChart
              label={`Issues finished per day over the last ${WINDOW_DAYS} days`}
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
          <div className="flex flex-col gap-3">
            {maxTotal ? (
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

      {answering ? <QuestionSheet itemId={answering} onClose={() => setAnswering(null)} onAnswered={() => void refetchAll()} /> : null}
      {viewing ? <WorkflowSheet id={viewing} onClose={() => setViewing(null)} onChanged={() => void refetchAll()} /> : null}
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

function ReposTab() {
  const rpc = useRpc<Contract>();
  const now = useNow();
  const overview = experimental_useRpcQuery<Contract, "cos_overview">({ contract: rpcContract, method: "cos_overview", input: null });
  const roster = experimental_useRpcQuery<Contract, "cos_roster">({ contract: rpcContract, method: "cos_roster", input: { includeDone: true, withUsage: false } });
  const refetchAll = useCallback(async () => {
    await Promise.all([overview.refetch(), roster.refetch()]);
  }, [overview, roster]);
  useLiveRefresh(refetchAll);
  const [intake, setIntake] = useState<{ results: IntakeResult[]; dryRun: boolean } | null>(null);
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
  const prs = (roster.data?.entries ?? []).filter((e) => e.prNumber);
  const data = overview.data;
  const authOk = data?.tokenSource !== "none";
  return (
    <div className="flex flex-col gap-4">
      <ErrorLine error={overview.error ?? message} />
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
        <div className="grid gap-3 md:grid-cols-2">
          {(data?.repos ?? []).map((r) => (
            <article key={r.key} className="flex flex-col gap-3 rounded-lg border border-border p-3.5">
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
                <div className="text-right">
                  <div className="text-2xl font-semibold leading-none text-foreground tabular-nums">
                    {r.active}
                    <span className="text-sm font-normal text-muted-foreground">/{r.maxConcurrent}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">tasks using capacity</div>
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
              {!r.intake ? <StatusPill tone="neutral" icon="Pause" label="Intake paused" /> : null}
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => void runIntake(r.key)}>
                  <Icon name="Inbox" fallback="Circle" aria-hidden /> Intake
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
      <Panel title="Pull requests" icon="GitPullRequest" dim={roster.isFetching && !roster.isLoading}>
        {!prs.length ? (
          <Empty icon="GitPullRequest" title="No pull requests yet">Pull requests opened by Chief of Staff agents show up here with their CI and review state.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {prs.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <StagePill entry={e} />
                <span className="inline-flex items-center gap-1 font-medium tabular-nums">{e.prUrl ? <UrlLink href={e.prUrl}>#{e.prNumber}</UrlLink> : `#${e.prNumber}`}</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{e.issueTitle}</span>
                {e.fixAttempts ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={`${e.fixAttempts} CI fix cycles`}>
                    <Icon name="Wrench" fallback="Circle" className="size-3.5" aria-hidden />
                    {e.fixAttempts}
                  </span>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {e.repo.split("/")[1]}
                  {e.issueNumber ? ` · closes #${e.issueNumber}` : ""} · {relative(e.lastActivityAt ?? e.startedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// ---------- activity feed ----------

const LEVEL: Record<string, { tone: Tone; icon: string; label: string }> = {
  info: { tone: "info", icon: "Info", label: "Info" },
  warn: { tone: "warning", icon: "TriangleAlert", label: "Warning" },
  error: { tone: "critical", icon: "CircleX", label: "Error" },
};

export function ActivityFeed() {
  const palette = usePalette();
  const now = useNow();
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const log = experimental_useRpcQuery<Contract, "cos_log">({ contract: rpcContract, method: "cos_log", input: { limit: 60 } });
  useLiveRefresh(log.refetch);
  const entries = (log.data?.entries ?? []).filter((e) => !onlyProblems || e.level !== "info");
  return (
    <Panel
      title="Activity"
      icon="Activity"
      dim={log.isFetching && !log.isLoading}
      actions={
        <Button size="sm" variant="ghost" aria-pressed={onlyProblems} onClick={() => setOnlyProblems((v) => !v)}>
          <Icon name="TriangleAlert" fallback="Circle" aria-hidden /> Problems only
        </Button>
      }
    >
      <ErrorLine error={log.error} />
      {log.data && !entries.length ? <p className="text-sm text-muted-foreground">{onlyProblems ? "No warnings or errors." : "No activity yet."}</p> : null}
      <ol className="max-h-80 overflow-auto">
        {entries.map((e) => {
          const l = LEVEL[e.level] ?? LEVEL.info!;
          return (
            <li key={e.id} className="flex items-start gap-2.5 border-b border-border py-3 text-sm last:border-0">
              <Icon name={l.icon} fallback="Circle" className="mt-0.5 size-4 shrink-0" style={{ color: toneColor(l.tone, palette) }} aria-label={l.label} />
              <div className="min-w-0 flex-1">
                <p className="text-foreground [overflow-wrap:anywhere]">{activitySummary(e)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  {e.repo ? <span className="[overflow-wrap:anywhere]">{e.repo}</span> : null}
                  <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>{relative(e.at, now)}</time>
                  {e.workItemId ? <button type="button" className="rounded text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => setViewing(e.workItemId)}>View task</button> : null}
                </div>
                <details className="mt-1 text-muted-foreground">
                  <summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Technical details</summary>
                  <dl className="mt-2 space-y-1 [overflow-wrap:anywhere]">
                    <div><dt className="inline font-medium">Event: </dt><dd className="inline">{e.kind}</dd></div>
                    <div><dt className="inline font-medium">Actor: </dt><dd className="inline">{e.actor}</dd></div>
                    {e.workItemId ? <div><dt className="inline font-medium">Task: </dt><dd className="inline">{e.workItemId}</dd></div> : null}
                    <div><dt className="inline font-medium">Message: </dt><dd className="inline whitespace-pre-wrap">{e.message}</dd></div>
                  </dl>
                </details>
              </div>
            </li>
          );
        })}
      </ol>
      {viewing ? <WorkflowSheet id={viewing} onClose={() => setViewing(null)} onChanged={() => void log.refetch()} /> : null}
    </Panel>
  );
}

// ---------- shell ----------

function Dashboard({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const tab = useMemo<Tab>(() => {
    const first = decodeURIComponent(subPath.split("/")[0] ?? "");
    return TABS.some((t) => t.id === first) ? (first as Tab) : "agents";
  }, [subPath]);
  const goTab = useCallback((t: Tab) => navigate.toPluginPanel("cos", { subPath: t }), [navigate]);
  const [alert, setAlert] = useState<{ title: string; body: string } | null>(null);
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
          <nav className="flex rounded-lg border border-border bg-card p-1" aria-label="Dashboard tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                onClick={() => goTab(t.id)}
                className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors", tab === t.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                <Icon name={t.icon} fallback="Circle" className="size-4" aria-hidden />
                {t.label}
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
        {tab === "agents" ? <PipelineTab /> : tab === "issues" ? <ReposTab /> : <Configurator initialSection={configSection(subPath)} />}
        {tab === "config" ? null : <ActivityFeed />}
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
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Everything below saves to this plugin's settings. The dashboard has the same editor under Configure.</p>
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
