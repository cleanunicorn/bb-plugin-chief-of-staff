// Chief of Staff — BB plugin frontend entry: dashboard nav panel + settings section.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ThreadTitle, UrlLink, definePluginApp, experimental_useRpcQuery, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./rpcContract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ColumnChart, DataTable, Legend, Meter, Panel, PaletteProvider, STATUS, SegmentedBar, StatTile, StatusPill, Swatch, ViewToggle, compact, duration, relative, toneColor, usePalette } from "@/components/cos/viz";
import type { Tone } from "@/components/cos/viz";
import { ACTOR, STAGES, STEP_LABEL as STAGE_STEP_LABEL, stageColor, stageOf, stepIndex, steps } from "@/components/cos/stages";
import type { StageKey } from "@/components/cos/stages";
import { Configurator } from "@/components/cos/configurator";
import { QuestionSheet } from "@/components/cos/question";

type Contract = typeof rpcContract;
type RosterEntry = PluginRpcResult<Contract["cos_roster"]>["entries"][number];
type Run = PluginRpcResult<Contract["cos_runs"]>["runs"][number];
type Routine = PluginRpcResult<Contract["cos_routines"]>["routines"][number];
type IntakeResult = PluginRpcResult<Contract["cos_intake_now"]>["results"][number];
type MergeDecision = PluginRpcResult<Contract["cos_merge_preview"]>["decisions"][number];

const TABS = [
  { id: "agents", label: "Pipeline", icon: "Workflow" },
  { id: "issues", label: "Repos & PRs", icon: "GitPullRequest" },
  { id: "routines", label: "Routines", icon: "CalendarClock" },
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

function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <Icon name={icon} fallback="Circle" className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children ? <p className="max-w-md text-xs text-muted-foreground">{children}</p> : null}
    </div>
  );
}

// ---------- status helpers ----------

const WAITING_LABEL: Record<string, { label: string; icon: string }> = {
  plan_approval: { label: "Approve plan", icon: "ClipboardCheck" },
  question: { label: "Question", icon: "MessageCircleQuestion" },
  escalation: { label: "Your call", icon: "Hand" },
  no_report: { label: "No report", icon: "MessageSquareWarning" },
  cos_error: { label: "CoS stuck", icon: "OctagonAlert" },
};

function entryTone(e: RosterEntry): { tone: Tone; label: string; icon: string } {
  if (e.detail === "done") return { tone: "good", label: e.lastError ? "Closed" : "Shipped", icon: "CircleCheck" };
  if (e.detail === "failed") return { tone: "critical", label: "Failed", icon: "CircleX" };
  if (e.detail === "blocked") return { tone: "warning", label: "Stalled", icon: "OctagonAlert" };
  if (e.detail === "waiting_on_human") {
    const w = WAITING_LABEL[e.waitingKind ?? "question"] ?? WAITING_LABEL.question!;
    return { tone: e.waitingKind === "cos_error" ? "serious" : "warning", ...w };
  }
  if (e.detail === "retrying") return { tone: "serious", label: `${STAGE_STEP_LABEL[e.stage] ?? e.stage} · retrying`, icon: "RefreshCw" };
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

/** Who holds the ball and what is happening, in one line. */
function ActivityLine({ entry }: { entry: RosterEntry }) {
  const a = ACTOR[entry.actor] ?? ACTOR.none!;
  if (!a.label) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground" title={entry.activity}>
      <Icon name={a.icon} fallback="Circle" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium text-foreground">{a.label}</span> · <span className="line-clamp-2 inline">{entry.activity}</span>
      </span>
    </p>
  );
}

const RUN_TONE: Record<string, { tone: Tone; label: string }> = {
  succeeded: { tone: "good", label: "Succeeded" },
  failed: { tone: "critical", label: "Failed" },
  partial: { tone: "warning", label: "Partial" },
  running: { tone: "info", label: "Running" },
};
const STEP_TONE: Record<string, { tone: Tone; label: string; icon: string }> = {
  succeeded: { tone: "good", label: "succeeded", icon: "CircleCheck" },
  failed: { tone: "critical", label: "failed", icon: "CircleX" },
  skipped: { tone: "neutral", label: "skipped", icon: "CircleMinus" },
  dry_run: { tone: "info", label: "dry run", icon: "Eye" },
};
const STEP_ICON: Record<string, string> = { batch_merge: "GitMerge", release: "Tag", deploy: "Rocket", run_agent: "Bot", notify: "Bell" };
const STEP_LABEL: Record<string, string> = { batch_merge: "Batch merge", release: "Release", deploy: "Deploy", run_agent: "Run agent", notify: "Notify" };

// ---------- stepper ----------

function Stepper({ entry }: { entry: RosterEntry }) {
  const palette = usePalette();
  const labels = steps(entry).map((k) => STAGE_STEP_LABEL[k] ?? k);
  const current = stepIndex(entry);
  const t = entryTone(entry);
  const attention = t.tone === "warning" || t.tone === "serious" || t.tone === "critical";
  const doneAll = entry.detail === "done";
  const markColor = attention ? toneColor(t.tone, palette) : doneAll ? STATUS.good : palette.accent;
  return (
    <ol className="flex items-center" aria-label={`Progress: ${labels[current]} (${t.label})`}>
      {labels.map((label, i) => {
        const reached = i < current || (i === current && doneAll);
        const isCurrent = i === current && !doneAll;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none" title={label}>
            <span className="flex flex-col items-center gap-1">
              <span
                className={cn("flex size-4 items-center justify-center rounded-full border-2", !reached && !isCurrent && "border-border bg-background")}
                style={reached ? { background: doneAll ? STATUS.good : palette.accent, borderColor: doneAll ? STATUS.good : palette.accent } : isCurrent ? { borderColor: markColor, background: "var(--background)" } : undefined}
              >
                {reached ? <Icon name="Check" fallback="Circle" className="size-2.5 text-white" aria-hidden /> : isCurrent ? <span className="size-1.5 rounded-full" style={{ background: markColor }} /> : null}
              </span>
              <span className={cn("text-[10px] leading-none", isCurrent ? "font-semibold text-foreground" : "text-muted-foreground")}>{label}</span>
            </span>
            {i < labels.length - 1 ? <span aria-hidden className="mx-1 mb-3.5 h-0.5 flex-1 rounded-full" style={{ background: i < current || doneAll ? (doneAll ? STATUS.good : palette.accent) : "var(--border)" }} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- agent card ----------

type ItemAction = "retry" | "resume" | "rerun_checks" | "approve" | "mark_done" | "mark_failed";

function AgentCard({ entry, busy, onAction, onAnswer, now }: { entry: RosterEntry; busy: boolean; onAction: (id: string, action: ItemAction) => void; onAnswer: (id: string) => void; now: number }) {
  const navigate = useBbNavigate();
  const [menu, setMenu] = useState(false);
  const finished = entry.detail === "done" || entry.detail === "failed";
  const elapsedMin = (now - Date.parse(entry.startedAt)) / 60_000;
  const needsHuman = entry.status === "waiting on human" || entry.status === "blocked";
  return (
    <article className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4", entry.stalled || needsHuman ? "border-[color:var(--cos-attn)]" : "border-border")} style={{ ["--cos-attn" as string]: entry.stalled ? STATUS.serious : STATUS.warning }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <StagePill entry={entry} />
          {entry.stalled ? <StatusPill tone="serious" label="Stalled" icon="Hourglass" /> : null}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums" title={`Started ${new Date(entry.startedAt).toLocaleString()}`}>
          <Icon name="Timer" fallback="Clock" className="size-3.5" aria-hidden />
          {finished ? relative(entry.startedAt, now) : duration(elapsedMin)}
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">
          {entry.repo.split("/")[1] ?? entry.repo}
          {entry.issueNumber ? ` #${entry.issueNumber}` : ""}
        </p>
        <h3 className="line-clamp-2 text-sm font-semibold text-foreground">{entry.issueTitle || entry.threadTitle || "Untitled task"}</h3>
      </div>
      <Stepper entry={entry} />
      {!finished ? <ActivityLine entry={entry} /> : null}
      {(entry.waitingReason || entry.status === "waiting on human") && entry.threadId && !finished ? (
        <button
          type="button"
          onClick={() => onAnswer(entry.id)}
          className="group flex items-start gap-1.5 rounded-md bg-muted px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={entry.waitingKind === "plan_approval" ? "Open the plan to approve it" : "Open the question to answer it"}
        >
          <Icon name="MessageCircleQuestion" fallback="MessageSquare" className="mt-0.5 size-3.5 shrink-0" style={{ color: STATUS.warning }} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-3" title={entry.waitingReason ?? undefined}>{entry.waitingReason ?? "Waiting on you"}</span>
            <span className="mt-1 inline-flex items-center gap-1 font-medium text-muted-foreground group-hover:text-foreground">
              {entry.waitingKind === "plan_approval" ? "Review plan" : entry.waitingKind === "escalation" || entry.waitingKind === "no_report" ? "Decide" : entry.waitingKind === "cos_error" ? "Details" : "Answer here"} <Icon name="ChevronRight" fallback="Circle" className="size-3" aria-hidden />
            </span>
          </span>
        </button>
      ) : null}
      {entry.lastError && !finished && entry.detail !== "retrying" && entry.detail !== "ready" && entry.waitingKind !== "cos_error" ? (
        <p className="flex items-start gap-1.5 text-xs text-foreground">
          <Icon name="CircleAlert" fallback="Circle" className="mt-0.5 size-3.5 shrink-0" style={{ color: STATUS.serious }} aria-hidden />
          <span className="line-clamp-2">{entry.lastError}</span>
        </p>
      ) : null}
      <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
        <div className="min-w-0">
          <dt className="text-muted-foreground">Activity</dt>
          <dd className="truncate font-medium text-foreground">{relative(entry.lastActivityAt ?? entry.startedAt, now)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Tokens</dt>
          <dd className="truncate font-medium text-foreground tabular-nums">{entry.usage?.totalTokens != null ? compact(entry.usage.totalTokens) : "–"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{entry.fixAttempts ? "Fix cycles" : "Cost"}</dt>
          <dd className="truncate font-medium text-foreground tabular-nums">{entry.fixAttempts ? entry.fixAttempts : entry.usage?.cost ? `${entry.usage.cost.amount.toFixed(2)} ${entry.usage.cost.currency}` : "–"}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.threadId ? (
          <Button size="sm" variant="outline" className="h-7 max-w-[60%] px-2" onClick={() => navigate.toThread(entry.threadId!)}>
            <Icon name="MessageSquare" fallback="Circle" aria-hidden />
            <span className="truncate">
              <ThreadTitle threadId={entry.threadId} />
            </span>
          </Button>
        ) : null}
        {entry.prUrl ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-input px-2 text-xs font-medium">
            <Icon name="GitPullRequest" fallback="Circle" className="size-3.5" aria-hidden />
            <UrlLink href={entry.prUrl}>#{entry.prNumber}</UrlLink>
          </span>
        ) : null}
        {entry.waitingKind === "plan_approval" ? (
          <Button size="sm" className="h-7 px-2" disabled={busy} onClick={() => onAction(entry.id, "approve")}>
            <Icon name="Check" fallback="Circle" aria-hidden /> Approve plan
          </Button>
        ) : needsHuman && entry.waitingKind !== "question" ? (
          <Button size="sm" className="h-7 px-2" disabled={busy} onClick={() => onAction(entry.id, "retry")}>
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
                    ["rerun_checks", "Re-run verify", "FlaskConical"],
                    ["retry", "Restart this stage", "RotateCcw"],
                    ["mark_done", "Mark done", "CircleCheck"],
                    ["mark_failed", "Mark failed", "CircleX"],
                  ] as const
                ).map(([action, label, icon]) => (
                  <button
                    key={action}
                    role="menuitem"
                    type="button"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-state-hover"
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

const fieldClass = "w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

/** Hand Chief of Staff a task that has no GitHub issue; it runs the repo's workflow. */
function NewTaskForm({ repos, onCancel, onStarted }: { repos: string[]; onCancel: () => void; onStarted: () => void | Promise<void> }) {
  const rpc = useRpc<Contract>();
  const [repo, setRepo] = useState(repos[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setSending(true);
    setError(null);
    try {
      await rpc.call("cos_start_task", { repo, title: title.trim(), body: body.trim() });
      await onStarted();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };
  if (!repos.length) return <p className="mb-3 text-sm text-muted-foreground">Configure a repository first (Configure tab).</p>;
  return (
    <form
      className="mb-4 flex flex-col gap-2 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && repo) void start();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_1fr]">
        <label className="text-xs font-medium text-muted-foreground">
          Repository
          <select className={cn(fieldClass, "mt-1")} value={repo} disabled={sending} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          Title
          <input className={cn(fieldClass, "mt-1")} value={title} disabled={sending} placeholder="Add rate limiting to /login" onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <label className="text-xs font-medium text-muted-foreground">
        What needs doing
        <textarea className={cn(fieldClass, "mt-1 min-h-24")} value={body} disabled={sending} placeholder="Context, acceptance criteria, constraints. The agent starts from this instead of an issue." onChange={(e) => setBody(e.target.value)} />
      </label>
      {error ? <p className="text-xs" style={{ color: STATUS.critical }}>{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={sending || !title.trim() || !repo}>
          <Icon name="Play" fallback="Circle" aria-hidden /> {sending ? "Starting…" : "Start"}
        </Button>
      </div>
    </form>
  );
}

// ---------- pipeline tab ----------

function PipelineTab({ goTab }: { goTab: (t: Tab) => void }) {
  const rpc = useRpc<Contract>();
  const palette = usePalette();
  const now = useNow();
  const [includeDone, setIncludeDone] = useState(false);
  const [filter, setFilter] = useState<StageKey | "all">("all");
  const [pipelineTable, setPipelineTable] = useState(false);
  const [throughputTable, setThroughputTable] = useState(false);
  const roster = experimental_useRpcQuery<Contract, "cos_roster">({ contract: rpcContract, method: "cos_roster", input: { includeDone, withUsage: true } });
  const stats = experimental_useRpcQuery<Contract, "cos_stats">({ contract: rpcContract, method: "cos_stats", input: { windowDays: WINDOW_DAYS } });
  const overview = experimental_useRpcQuery<Contract, "cos_overview">({ contract: rpcContract, method: "cos_overview", input: null });
  const routines = experimental_useRpcQuery<Contract, "cos_routines">({ contract: rpcContract, method: "cos_routines", input: null });
  const refetchAll = useCallback(async () => {
    await Promise.all([roster.refetch(), stats.refetch(), overview.refetch(), routines.refetch()]);
  }, [roster, stats, overview, routines]);
  useLiveRefresh(refetchAll);
  const [busy, setBusy] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);
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
  const running = active.filter((e) => e.detail !== "queued").length;
  const needsYou = byStage.human;
  const stalled = active.filter((e) => e.stalled).length;
  const openPrs = active.filter((e) => e.prNumber != null).length;
  const fixingCi = active.filter((e) => e.prNumber != null && e.stage !== "ship").length;
  const tokens = active.reduce((a, e) => a + (e.usage?.totalTokens ?? 0), 0);
  const cost = active.reduce((a, e) => a + (e.usage?.cost?.amount ?? 0), 0);
  const currency = active.find((e) => e.usage?.cost)?.usage?.cost?.currency ?? "";
  const nextRoutine = (routines.data?.routines ?? []).filter((r) => r.enabled && r.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
  const visible = filter === "all" ? entries : entries.filter((e) => stageOf(e)?.key === filter);
  const parts = STAGES.map((st) => ({ key: st.key, label: st.label, value: byStage[st.key], color: stageColor(st, palette), icon: st.icon }));
  const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="flex flex-col gap-4">
      <ErrorLine error={roster.error ?? stats.error ?? actionError} />
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile hero label="Active agents" icon="Bot" tone="info" value={running} sub={maxTotal ? `of ${maxTotal} slots · ${byStage.queued} queued` : `${byStage.queued} queued`} onClick={() => setFilter("all")}>
          {maxTotal ? <div className="mt-2"><Meter value={running} max={maxTotal} label="Agent slots in use" /></div> : null}
        </StatTile>
        <StatTile label="Needs you" icon={needsYou ? "Hand" : "CircleCheck"} tone={needsYou ? "warning" : "good"} value={needsYou} sub={needsYou ? "waiting on a person" : "nothing blocked"} onClick={() => setFilter("human")} />
        <StatTile label="Open PRs" icon="GitPullRequest" tone="info" value={openPrs} sub={fixingCi ? `${fixingCi} back in build for fixes` : "CI green or running"} onClick={() => goTab("issues")} />
        <StatTile label={`Shipped · ${WINDOW_DAYS}d`} icon="CircleCheck" tone="good" value={s?.doneInWindow ?? "–"} sub={s?.medianCycleMinutes != null ? `median ${duration(s.medianCycleMinutes)} issue→done` : `${s?.startedInWindow ?? 0} started`} />
        <StatTile label={`Failed · ${WINDOW_DAYS}d`} icon={(s?.failedInWindow ?? 0) + stalled ? "CircleX" : "ShieldCheck"} tone={(s?.failedInWindow ?? 0) + stalled ? "critical" : "good"} value={s?.failedInWindow ?? "–"} sub={stalled ? `${stalled} stalled now` : "none stalled"} />
        <StatTile label="Tokens in flight" icon="Coins" tone="neutral" value={compact(tokens)} sub={cost ? `${cost.toFixed(2)} ${currency} on active work` : nextRoutine ? `next: ${nextRoutine.name} ${relative(nextRoutine.nextRunAt, now)}` : "across active agents"} />
      </div>

      {/* Pipeline */}
      <Panel title="Pipeline" icon="Workflow" dim={roster.isFetching && !roster.isLoading} actions={<ViewToggle table={pipelineTable} onChange={setPipelineTable} />}>
        {pipelineTable ? (
          <DataTable columns={["Stage", "Items", "Meaning"]} rows={[...STAGES.map((st) => [st.label, byStage[st.key], st.hint]), [`Done (${WINDOW_DAYS}d)`, s?.doneInWindow ?? 0, "Closed by a merged PR"], [`Failed (${WINDOW_DAYS}d)`, s?.failedInWindow ?? 0, "Gave up or marked failed"]]} />
        ) : (
          <div className="flex flex-col gap-4">
            <SegmentedBar parts={parts} label="Active work by stage" unit="items" />
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
              {STAGES.map((st, i) => {
                const color = stageColor(st, palette);
                const selected = filter === st.key;
                return (
                  <button
                    key={st.key}
                    type="button"
                    title={st.hint}
                    aria-pressed={selected}
                    onClick={() => setFilter(selected ? "all" : st.key)}
                    className={cn("relative flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", selected ? "border-foreground/40 bg-state-active" : "border-border")}
                  >
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {st.tone ? <Icon name={st.icon} fallback="Circle" className="size-3.5" style={{ color }} aria-hidden /> : <Swatch color={color} />}
                      <span className="truncate">{st.label}</span>
                    </span>
                    <span className="text-2xl font-semibold leading-none text-foreground tabular-nums">{byStage[st.key]}</span>
                    {i < STAGES.length - 1 ? <Icon name="ChevronRight" fallback="Circle" className="absolute top-1/2 -right-2.5 z-10 hidden size-3.5 -translate-y-1/2 text-muted-foreground lg:block" aria-hidden /> : null}
                  </button>
                );
              })}
              {(
                [
                  ["Done", s?.doneInWindow ?? 0, "CircleCheck", STATUS.good],
                  ["Failed", s?.failedInWindow ?? 0, "CircleX", STATUS.critical],
                ] as const
              ).map(([label, value, icon, color], i) => (
                <div key={label} className={cn("flex flex-col gap-1 rounded-lg border border-dashed border-border p-2.5", i === 0 && "lg:ml-1")}>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Icon name={icon} fallback="Circle" className="size-3.5" style={{ color }} aria-hidden />
                    {label} · {WINDOW_DAYS}d
                  </span>
                  <span className="text-2xl font-semibold leading-none text-foreground tabular-nums">{value}</span>
                </div>
              ))}
            </div>
            <Legend items={parts.map((p) => ({ label: p.label, color: p.color, icon: STAGES.find((st) => st.key === p.key)?.tone ? p.icon : undefined }))} />
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-5">
        <Panel className="lg:col-span-3" title={`Throughput · last ${WINDOW_DAYS} days`} icon="ChartColumn" dim={stats.isFetching && !stats.isLoading} actions={<ViewToggle table={throughputTable} onChange={setThroughputTable} />}>
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
            {nextRoutine ? (
              <button type="button" onClick={() => goTab("routines")} className="mt-1 flex items-center gap-3 rounded-lg border border-border p-2.5 text-left hover:bg-state-hover">
                <Icon name="CalendarClock" fallback="Clock" className="size-5 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{nextRoutine.name}</span>
                  <span className="block text-xs text-muted-foreground">{new Date(nextRoutine.nextRunAt!).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
                </span>
                <span className="text-sm font-semibold text-foreground tabular-nums">{relative(nextRoutine.nextRunAt, now)}</span>
              </button>
            ) : null}
          </div>
        </Panel>
      </div>

      {/* Agents */}
      <Panel
        title={filter === "all" ? "Agents" : `Agents · ${STAGES.find((st) => st.key === filter)?.label}`}
        icon="Bot"
        dim={roster.isFetching && !roster.isLoading}
        actions={
          <>
            {filter !== "all" ? (
              <Button size="sm" variant="ghost" onClick={() => setFilter("all")}>
                <Icon name="X" fallback="Circle" aria-hidden /> Clear filter
              </Button>
            ) : null}
            <Button size="sm" variant="outline" aria-expanded={newTask} onClick={() => setNewTask((v) => !v)}>
              <Icon name="Plus" fallback="Circle" aria-hidden /> New task
            </Button>
            <Button size="sm" variant="ghost" aria-pressed={includeDone} onClick={() => setIncludeDone((v) => !v)}>
              <Icon name={includeDone ? "EyeOff" : "History"} fallback="Circle" aria-hidden />
              {includeDone ? "Hide finished" : "Show finished"}
            </Button>
          </>
        }
      >
        {newTask ? (
          <NewTaskForm
            repos={(overview.data?.repos ?? []).map((r) => r.key)}
            onCancel={() => setNewTask(false)}
            onStarted={async () => {
              setNewTask(false);
              await refetchAll();
            }}
          />
        ) : null}
        {roster.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {!roster.isLoading && !visible.length ? (
          <Empty icon="Bot" title={filter === "all" ? "No agents working right now" : "Nothing in this stage"}>
            {filter === "all" ? "Issues that match a repo's label filter are picked up on the next intake sweep, or run intake from Repos & PRs." : "Pick another stage, or clear the filter."}
          </Empty>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((e) => (
            <AgentCard key={e.id} entry={e} now={now} busy={busy === e.id} onAction={(id, action) => void act(id, action)} onAnswer={setAnswering} />
          ))}
        </div>
      </Panel>
      {answering ? <QuestionSheet itemId={answering} onClose={() => setAnswering(null)} onAnswered={() => void refetchAll()} /> : null}
    </div>
  );
}

// ---------- repos & PRs tab ----------

const ALLOW_FLAGS = [
  ["intake", "Intake", "Inbox"],
  ["openPr", "Open PRs", "GitPullRequest"],
  ["merge", "Merge", "GitMerge"],
  ["release", "Release", "Tag"],
  ["deploy", "Deploy", "Rocket"],
] as const;

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

function MergePreview({ repo, decisions, onClose }: { repo: string; decisions: MergeDecision[]; onClose: () => void }) {
  const count = (a: string) => decisions.filter((d) => d.action === a).length;
  const tone = (a: string): { tone: Tone; label: string; icon: string } => (a === "merge" ? { tone: "good", label: "Will merge", icon: "GitMerge" } : a === "conflict" ? { tone: "critical", label: "Conflict", icon: "CircleX" } : { tone: "neutral", label: "Skip", icon: "CircleMinus" });
  return (
    <Panel title={`Batch-merge preview · ${repo}`} icon="GitMerge" actions={<Button size="sm" variant="ghost" onClick={onClose}><Icon name="X" fallback="Circle" aria-hidden /> Close</Button>}>
      {!decisions.length ? (
        <Empty icon="GitPullRequest" title="No open pull requests" />
      ) : (
        <div className="flex flex-col gap-3">
          <SegmentedBar
            label="Batch-merge decisions"
            unit="PRs"
            parts={[
              { key: "merge", label: "Will merge", value: count("merge"), color: STATUS.good },
              { key: "skip", label: "Skip", value: count("skip"), color: "#898781" },
              { key: "conflict", label: "Conflict", value: count("conflict"), color: STATUS.critical },
            ]}
          />
          <Legend
            items={[
              { label: `Will merge · ${count("merge")}`, color: STATUS.good, icon: "GitMerge" },
              { label: `Skip · ${count("skip")}`, color: "#898781", icon: "CircleMinus" },
              { label: `Conflict · ${count("conflict")}`, color: STATUS.critical, icon: "CircleX" },
            ]}
          />
          <ul className="divide-y divide-border">
            {decisions.map((d) => {
              const t = tone(d.action);
              return (
                <li key={d.number} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <StatusPill tone={t.tone} label={t.label} icon={t.icon} />
                  <span className="font-medium text-foreground tabular-nums">#{d.number}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{d.title}</span>
                  <span className="text-xs text-muted-foreground">{d.reason}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
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
  const [preview, setPreview] = useState<{ repo: string; decisions: MergeDecision[] } | null>(null);
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
  const mergePreview = async (repo: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await rpc.call("cos_merge_preview", { repo });
      setPreview({ repo, decisions: result.decisions });
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
                  <div className="text-[11px] text-muted-foreground">agents</div>
                </div>
              </div>
              <Meter size="sm" value={r.active} max={r.maxConcurrent} label={`${r.key} agent slots`} />
              <ul className="flex flex-wrap gap-1.5" aria-label="Permissions">
                {ALLOW_FLAGS.map(([k, label, icon]) => {
                  const on = r.allow[k];
                  return (
                    <li key={k} title={on ? `${label} allowed` : `${label} blocked (allow.${k} is off)`} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]", on ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground")}>
                      <Icon name={on ? icon : "Lock"} fallback="Circle" className="size-3" style={on ? { color: STATUS.good } : undefined} aria-hidden />
                      {label}
                      <span className="sr-only">{on ? "allowed" : "blocked"}</span>
                    </li>
                  );
                })}
              </ul>
              {r.checkCommand ? (
                <p className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                  <Icon name="FlaskConical" fallback="Circle" className="size-3 shrink-0" aria-hidden />
                  <code className="truncate">{r.checkCommand}</code>
                </p>
              ) : null}
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => void runIntake(r.key)}>
                  <Icon name="Inbox" fallback="Circle" aria-hidden /> Intake
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy} onClick={() => void mergePreview(r.key)}>
                  <Icon name="GitMerge" fallback="Circle" aria-hidden /> Merge preview
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
      {preview ? <MergePreview repo={preview.repo} decisions={preview.decisions} onClose={() => setPreview(null)} /> : null}
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

// ---------- routines tab ----------

function StepChain({ steps, results }: { steps: string[]; results?: Run["steps"] }) {
  const palette = usePalette();
  return (
    <ol className="flex flex-wrap items-center gap-1">
      {steps.map((step, i) => {
        const res = results?.find((r) => r.index === i);
        const t = res ? STEP_TONE[res.status] : undefined;
        return (
          <li key={`${step}-${i}`} className="flex items-center gap-1">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground" title={res ? `${STEP_LABEL[step] ?? step}: ${t?.label ?? res.status} — ${res.summary}` : STEP_LABEL[step] ?? step}>
              <Icon name={STEP_ICON[step] ?? "Square"} fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden />
              {STEP_LABEL[step] ?? step}
              {t ? <Icon name={t.icon} fallback="Circle" className="size-3.5" style={{ color: toneColor(t.tone, palette) }} aria-label={t.label} /> : null}
            </span>
            {i < steps.length - 1 ? <Icon name="ChevronRight" fallback="Circle" className="size-3.5 text-muted-foreground" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function RunRow({ run, now }: { run: Run; now: number }) {
  const t = RUN_TONE[run.status] ?? { tone: "neutral" as Tone, label: run.status };
  const [open, setOpen] = useState(false);
  const took = run.finishedAt ? (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000 : null;
  return (
    <li className="py-2.5">
      <button type="button" className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <StatusPill tone={t.tone} label={t.label} pulse={run.status === "running"} />
        <span className="text-sm font-medium text-foreground">{run.routine}</span>
        {run.dryRun ? <StatusPill tone="info" icon="Eye" label="Dry run" /> : null}
        <StepChain steps={run.steps.map((s) => s.type)} results={run.steps} />
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span title={new Date(run.startedAt).toLocaleString()}>{relative(run.startedAt, now)}</span>
          {took != null ? <span className="tabular-nums">· {took < 60 ? `${Math.round(took)}s` : duration(took / 60)}</span> : null}
          <span>· {run.triggeredBy}</span>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} fallback="Circle" className="size-3.5" aria-hidden />
        </span>
      </button>
      {open ? (
        <ol className="mt-2 flex flex-col gap-1 border-l-2 border-border pl-3 text-xs">
          {run.steps.map((s) => {
            const st = STEP_TONE[s.status];
            return (
              <li key={s.index} className="flex items-start gap-2">
                <StatusPill tone={st?.tone ?? "neutral"} icon={st?.icon} label={STEP_LABEL[s.type] ?? s.type} />
                <span className="pt-0.5 text-foreground">{s.summary}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </li>
  );
}

function RoutineCard({ routine, now, busy, onRun, onToggle, lastRun }: { routine: Routine; now: number; busy: boolean; onRun: (dryRun: boolean) => void; onToggle: () => void; lastRun?: Run }) {
  const last = lastRun ? RUN_TONE[lastRun.status] : undefined;
  return (
    <article className={cn("flex flex-col gap-3 rounded-lg border border-border p-3.5", !routine.enabled && "opacity-70")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {routine.name}
            {routine.dryRun ? <StatusPill tone="info" icon="Eye" label="Dry run" /> : null}
          </h3>
          <p className="text-xs text-muted-foreground">
            {routine.repo}
            {routine.configured ? "" : " · repo not configured"}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={routine.enabled}
          aria-label={routine.enabled ? "Disable routine" : "Enable routine"}
          disabled={busy}
          onClick={onToggle}
          className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", routine.enabled ? "bg-foreground" : "bg-muted")}
        >
          <span className={cn("absolute left-0 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform", routine.enabled ? "translate-x-4" : "translate-x-0.5")} />
        </button>
      </div>
      <StepChain steps={routine.steps} />
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md bg-muted px-2.5 py-2">
          <div className="text-[11px] text-muted-foreground">Next run</div>
          <div className="text-lg font-semibold leading-tight text-foreground tabular-nums">{routine.running ? "running" : routine.enabled && routine.nextRunAt ? relative(routine.nextRunAt, now) : "–"}</div>
          <div className="truncate text-[11px] text-muted-foreground">{routine.schedule ?? "manual only"}</div>
        </div>
        <div className="rounded-md bg-muted px-2.5 py-2">
          <div className="text-[11px] text-muted-foreground">Last run</div>
          <div className="pt-0.5">{last ? <StatusPill tone={last.tone} label={last.label} /> : <span className="text-lg font-semibold text-foreground">–</span>}</div>
          <div className="truncate text-[11px] text-muted-foreground">{routine.lastRunAt ? relative(routine.lastRunAt, now) : "never"}</div>
        </div>
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" className="h-7 px-2" disabled={busy || routine.running} onClick={() => onRun(true)}>
          <Icon name="Eye" fallback="Circle" aria-hidden /> Dry run
        </Button>
        <Button size="sm" className="h-7 px-2" disabled={busy || routine.running || !routine.configured} onClick={() => onRun(false)}>
          <Icon name="Play" fallback="Circle" aria-hidden /> Run now
        </Button>
      </div>
    </article>
  );
}

function RoutinesTab() {
  const rpc = useRpc<Contract>();
  const now = useNow();
  const routines = experimental_useRpcQuery<Contract, "cos_routines">({ contract: rpcContract, method: "cos_routines", input: null });
  const runs = experimental_useRpcQuery<Contract, "cos_runs">({ contract: rpcContract, method: "cos_runs", input: { limit: 30 } });
  const stats = experimental_useRpcQuery<Contract, "cos_stats">({ contract: rpcContract, method: "cos_stats", input: { windowDays: WINDOW_DAYS } });
  const refetchAll = useCallback(async () => {
    await Promise.all([routines.refetch(), runs.refetch(), stats.refetch()]);
  }, [routines, runs, stats]);
  useLiveRefresh(refetchAll);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Run | null>(null);
  const run = async (name: string, dryRun: boolean) => {
    setBusy(name);
    setMessage(null);
    try {
      setLastResult(await rpc.call("cos_run_routine", { name, dryRun }));
      await refetchAll();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (name: string, enabled: boolean) => {
    setBusy(name);
    try {
      await rpc.call("cos_set_routine_enabled", { name, enabled });
      await routines.refetch();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };
  const list = routines.data?.routines ?? [];
  const runList = runs.data?.runs ?? [];
  const r = stats.data?.runs;
  const runTotal = r ? r.succeeded + r.failed + r.partial + r.running : 0;
  return (
    <div className="flex flex-col gap-4">
      <ErrorLine error={routines.error ?? message} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Enabled routines" icon="CalendarClock" tone="info" value={`${list.filter((x) => x.enabled).length}`} sub={`of ${list.length} defined`} />
        <StatTile label={`Runs · ${WINDOW_DAYS}d`} icon="Activity" tone="neutral" value={runTotal} sub={r ? `${r.succeeded} ok · ${r.failed} failed · ${r.partial} partial` : ""} />
        <div className="col-span-2 flex flex-col justify-center gap-2 rounded-xl border border-border bg-card p-4">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Icon name="ChartBar" fallback="Circle" className="size-3.5" aria-hidden />
            Run outcomes · {WINDOW_DAYS}d
          </span>
          <SegmentedBar
            label="Routine run outcomes"
            unit="runs"
            parts={[
              { key: "succeeded", label: "Succeeded", value: r?.succeeded ?? 0, color: STATUS.good },
              { key: "partial", label: "Partial", value: r?.partial ?? 0, color: STATUS.warning },
              { key: "failed", label: "Failed", value: r?.failed ?? 0, color: STATUS.critical },
            ]}
          />
          <Legend
            items={[
              { label: "Succeeded", color: STATUS.good, icon: "CircleCheck" },
              { label: "Partial", color: STATUS.warning, icon: "TriangleAlert" },
              { label: "Failed", color: STATUS.critical, icon: "CircleX" },
            ]}
          />
        </div>
      </div>
      {lastResult ? (
        <Panel title={`Just ran · ${lastResult.routine}`} icon="Play" actions={<Button size="sm" variant="ghost" onClick={() => setLastResult(null)}><Icon name="X" fallback="Circle" aria-hidden /> Close</Button>}>
          <ul>
            <RunRow run={lastResult} now={now} />
          </ul>
        </Panel>
      ) : null}
      <Panel title="Routines" icon="CalendarClock" dim={routines.isFetching && !routines.isLoading}>
        {routines.data && !list.length ? <Empty icon="CalendarClock" title="No routines yet">
            <ConfigureLink section="routines" label="Create a routine" />
          </Empty> : null}
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((x) => (
            <RoutineCard key={x.name} routine={x} now={now} busy={busy === x.name} lastRun={runList.find((run) => run.routine === x.name)} onRun={(dryRun) => void run(x.name, dryRun)} onToggle={() => void toggle(x.name, !x.enabled)} />
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Routines are dispatched by this plugin's durable BB schedule. To run one from a BB Automation, create a script automation that calls <code>bb cos run &lt;routine&gt;</code>.
        </p>
      </Panel>
      <Panel title="Recent runs" icon="History" dim={runs.isFetching && !runs.isLoading}>
        {runs.data && !runList.length ? <Empty icon="History" title="No runs yet">Use Dry run on a routine to see what it would do without changing anything.</Empty> : null}
        <ul className="divide-y divide-border">
          {runList.map((x) => (
            <RunRow key={x.id} run={x} now={now} />
          ))}
        </ul>
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

function ActivityFeed() {
  const palette = usePalette();
  const now = useNow();
  const [onlyProblems, setOnlyProblems] = useState(false);
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
            <li key={e.id} className="flex items-start gap-2.5 py-1.5 text-xs">
              <Icon name={l.icon} fallback="Circle" className="mt-0.5 size-3.5 shrink-0" style={{ color: toneColor(l.tone, palette) }} aria-label={l.label} />
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{e.kind}</span>
              <span className="min-w-0 flex-1 text-foreground">
                {e.repo ? <span className="font-medium">{e.repo.split("/")[1]} </span> : null}
                {e.message}
                <span className="text-muted-foreground"> · {e.actor}</span>
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums" title={new Date(e.at).toLocaleString()}>
                {relative(e.at, now)}
              </span>
            </li>
          );
        })}
      </ol>
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
              <p className="text-xs text-muted-foreground">Issues in, pull requests out. Live view of every agent.</p>
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
        {tab === "agents" ? <PipelineTab goTab={goTab} /> : tab === "issues" ? <ReposTab /> : tab === "routines" ? <RoutinesTab /> : <Configurator initialSection={configSection(subPath)} />}
        {tab === "config" ? null : <ActivityFeed />}
      </div>
    </PaletteProvider>
  );
}

function configSection(subPath: string): "repos" | "routines" | "general" | "access" | "advanced" {
  const second = decodeURIComponent(subPath.split("/")[1] ?? "");
  return second === "routines" || second === "general" || second === "access" || second === "advanced" ? second : "repos";
}

function ConfigureLink({ section, label }: { section: "repos" | "routines"; label: string }) {
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
  app.slots.navPanel({ id: "cos-dashboard", title: "Chief of Staff", icon: "ChefHat", path: "cos", component: Dashboard });
  app.slots.settingsSection({ id: "cos-config", title: "Configure Chief of Staff", description: "Repositories, routines, limits and GitHub access, edited visually and validated before saving.", component: SettingsSection });
});
