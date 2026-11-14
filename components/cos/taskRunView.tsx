// The parts of a task's workflow sheet around the canvas: a summary strip,
// the task overview with its loop-backs and history, and the selected step's
// inputs, outputs and runs.
import { useState } from "react";
import type { ReactNode } from "react";
import { Markdown, UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../rpcContract";
import { Icon } from "../ui/icon";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { STATUS, compact, duration, relative } from "./viz";
import { usageNote } from "./dashboardModel";
import { STEP_TYPE_META, liveTone, type LiveStatus } from "./workflowCanvas";
import { PIVOTAL_KINDS, journalLine, stepInputs, type JournalRecord, type LoopSummary, type StepDetail, type TaskDetail, type TaskUsage } from "./runModel";
import { modelMode, stepById, type Step, type Workflow } from "../../src/workflow";

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  agent: "Agent working",
  cos: "Chief of Staff working",
  ci: "CI running",
  ready: "Ready to merge",
  waiting_on_human: "Waiting on you",
  retrying: "Retrying",
  blocked: "Stalled",
  done: "Done",
  failed: "Failed",
};

/** Timeline dot colour per kind of entry. */
const KIND_COLOR: Record<JournalRecord["kind"], string> = {
  started: "var(--cos-accent, #3b82f6)",
  reported: "var(--muted-foreground)",
  passed: STATUS.good,
  failed: STATUS.serious,
  waiting: STATUS.warning,
  revised: STATUS.warning,
  rerun: STATUS.warning,
  interrupted: "var(--muted-foreground)",
  stopped: STATUS.critical,
};

const minutesBetween = (from: string | null | undefined, to: string | null | undefined, now: number) => (from ? Math.max(0, (to ? Date.parse(to) : now) - Date.parse(from)) / 60_000 : null);
/** Dashboard actions (approve, send back, run again) are recorded as "rpc:client". */
const who = (actor: string) => (actor === "rpc:client" ? "you" : null);

/**
 * One line of facts about the task, under the sheet's title.
 * `oneLine` keeps the strip to a single row on short screens: the last value truncates (full text in `title`), and the strip scrolls sideways if that is not enough.
 */
/** `usage`: the task's usage over all its agent threads (stored once finished, read when the sheet opened while it runs). */
export function TaskSummary({ task, workflow, live, loops, now, usage = null, oneLine = false }: { task: TaskDetail | undefined; workflow: Workflow; live: Record<string, LiveStatus>; loops: LoopSummary; now: number; usage?: TaskUsage | null; oneLine?: boolean }) {
  const done = workflow.steps.filter((s) => live[s.id]?.status === "done").length;
  const items: { icon: string; label: string; value: ReactNode; title?: string }[] = [];
  if (task) items.push({ icon: "Activity", label: "Status", value: STATUS_LABEL[task.status] ?? task.status });
  if (task) items.push({ icon: "Timer", label: task.finishedAt ? "Took" : "Running for", value: duration(minutesBetween(task.createdAt, task.finishedAt, now)), title: `Started ${new Date(task.createdAt).toLocaleString()}` });
  items.push({ icon: "ListChecks", label: "Steps done", value: `${done}/${workflow.steps.length}` });
  items.push({
    icon: "Undo2",
    label: "Loop-backs",
    value: `${loops.approximate && loops.total ? "≈" : ""}${loops.total}`,
    title: loops.loops.map((l) => `${l.from ? (stepById(workflow, l.from)?.name ?? l.from) : "You"} → ${stepById(workflow, l.to)?.name ?? l.to} ×${l.count}`).join("\n") || "Nothing was sent back",
  });
  // Before PR and Branch: on one line only the last fact gives up width.
  if (usage && (!usage.counted || usage.totalTokens != null)) {
    items.push({ icon: "Coins", label: `${task?.finishedAt ? "Tokens" : "Tokens so far"} · all threads`, value: usage.totalTokens != null ? compact(usage.totalTokens) : "counting…", title: usageNote(usage) });
  }
  if (usage?.cost) items.push({ icon: "Coins", label: "Cost", value: `${usage.cost.amount.toFixed(2)} ${usage.cost.currency}`, title: usageNote(usage) });
  if (task?.prUrl) items.push({ icon: "GitPullRequest", label: "PR", value: <UrlLink href={task.prUrl}>#{task.prNumber}</UrlLink> });
  if (task?.branch) items.push({ icon: "GitBranch", label: "Branch", value: <span className="font-mono">{task.branch}</span>, title: task.branch });
  return (
    <dl aria-label="Task summary" className={cn("flex shrink-0 gap-x-4 gap-y-1 text-xs", oneLine ? "flex-nowrap overflow-x-auto [scrollbar-width:thin]" : "flex-wrap")}>
      {items.map((i, n) => (
        // On one line only the last value (the branch, when there is one) gives up width; the rest stay whole.
        <div key={i.label} className={cn("flex min-w-0 items-center gap-1.5", oneLine && n < items.length - 1 && "shrink-0")} title={i.title}>
          <dt className="flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
            <Icon name={i.icon} fallback="Circle" className="size-3.5" aria-hidden />
            {i.label}
          </dt>
          <dd className="max-w-[18rem] truncate font-medium text-foreground tabular-nums">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, icon, children, aside }: { title: string; icon: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon name={icon} fallback="Circle" className="size-3.5" aria-hidden />
        {title}
        {aside ? <span className="ml-auto font-normal normal-case tracking-normal">{aside}</span> : null}
      </h4>
      {children}
    </section>
  );
}

/** Long text in a scrollable box: Markdown (reports, feedback, task text) or, `mono`, raw output. */
function TextBlock({ children, mono, tone }: { children: string; mono?: boolean; tone?: string }) {
  return (
    <div
      tabIndex={0}
      className={cn("max-h-64 overflow-auto rounded-md border bg-muted/50 px-2.5 py-2 text-xs leading-relaxed break-words text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", mono ? "font-mono text-[11px] whitespace-pre-wrap" : "")}
      style={{ borderColor: tone ?? "var(--border)" }}
    >
      {mono ? children : <Markdown content={children} className="text-xs text-foreground" />}
    </div>
  );
}

function Callout({ icon, color, children }: { icon: string; color: string; children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md border px-2.5 py-2 text-xs text-foreground [overflow-wrap:anywhere]" style={{ borderColor: color }}>
      <Icon name={icon} fallback="Circle" className="mt-0.5 size-3.5 shrink-0" style={{ color }} aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function ThreadButton({ threadId, label }: { threadId: string; label: string }) {
  const navigate = useBbNavigate();
  return (
    <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => navigate.toThread(threadId)}>
      <Icon name="MessageSquare" fallback="Circle" aria-hidden /> {label}
    </Button>
  );
}

/** The journal as a timeline, newest first; by default only the entries that changed the run's course. */
/** An entry's detail, collapsed. The workflow view gets previews of long details; the whole text loads when it is expanded. */
function EntryDetail({ itemId, entry, mono }: { itemId: string; entry: JournalRecord; mono: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [full, setFull] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = async () => {
    if (!entry.truncated || full !== null) return;
    try {
      setFull((await rpc.call("cos_journal_detail", { itemId, id: entry.id })).detail ?? entry.detail);
    } catch {
      setFailed(true);
    }
  };
  const text = full ?? entry.detail ?? "";
  return (
    <details className="mt-0.5 text-xs" onToggle={(event) => (event.currentTarget.open ? void load() : undefined)}>
      <summary className="cursor-pointer truncate rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">{text.split("\n").find((l) => l.trim() && l.trim() !== "…") ?? "Details"}</summary>
      <div className="mt-1"><TextBlock mono={mono}>{text}</TextBlock></div>
      {entry.truncated && full === null ? <p className="mt-0.5 text-[11px] text-muted-foreground">{failed ? "Could not load the whole text; showing part of it." : "Loading the whole text…"}</p> : null}
    </details>
  );
}

function Timeline({ itemId, workflow, entries, now, empty }: { itemId: string; workflow: Workflow; entries: readonly JournalRecord[]; now: number; empty: string }) {
  const [all, setAll] = useState(false);
  const shown = (all ? entries : entries.filter((e) => PIVOTAL_KINDS.has(e.kind) || e.kind === "passed")).slice().reverse();
  return (
    <Section
      title="History"
      icon="History"
      aside={entries.length ? (
        <button type="button" aria-pressed={all} onClick={() => setAll((v) => !v)} className="rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {all ? "Key events only" : `Show all ${entries.length}`}
        </button>
      ) : null}
    >
      {shown.length ? (
        <ol className="flex flex-col">
          {shown.map((e) => {
            const color = KIND_COLOR[e.kind];
            const by = who(e.actor);
            return (
              <li key={e.id} className="relative flex gap-2 border-l border-border pb-2 pl-3 last:pb-0">
                <span aria-hidden className="absolute top-1 -left-[5px] size-2.5 rounded-full border-2 border-background" style={{ background: color }} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2 text-xs">
                    <span className="min-w-0 flex-1 font-medium text-foreground">{journalLine(workflow, e)}</span>
                    <time dateTime={e.at} title={new Date(e.at).toLocaleString()} className="shrink-0 text-muted-foreground tabular-nums">{relative(e.at, now)}</time>
                  </p>
                  {by ? <p className="text-[11px] text-muted-foreground">by {by}</p> : null}
                  {e.detail ? <EntryDetail itemId={itemId} entry={e} mono={e.kind === "failed" || (e.kind === "passed" && stepById(workflow, e.step)?.type === "check")} /> : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </Section>
  );
}

function LoopList({ workflow, loops }: { workflow: Workflow; loops: LoopSummary }) {
  const name = (id: string) => stepById(workflow, id)?.name ?? id;
  return (
    <Section title="Loop-backs" icon="Undo2">
      {loops.loops.length ? (
        <ul className="flex flex-col gap-1.5">
          {loops.loops.map((l) => (
            <li key={`${l.from}>${l.to}`} className="rounded-md border border-border px-2.5 py-1.5 text-xs">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                {l.from ? name(l.from) : "You"}
                <Icon name="ArrowRight" fallback="Circle" className="size-3 text-muted-foreground" aria-hidden />
                {name(l.to)}
                <span className="ml-auto rounded-full px-1.5 tabular-nums" style={{ color: STATUS.serious, border: `1px solid ${STATUS.serious}` }}>×{l.count}</span>
              </p>
              {l.reasons[0] ? <p className="mt-0.5 line-clamp-2 text-muted-foreground" title={l.reasons[0]}>Latest: {l.reasons[0].split("\n").filter((x) => x.trim()).slice(0, 2).join(" ")}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing has been sent back so far.</p>
      )}
      {loops.approximate && loops.total ? <p className="text-[11px] text-muted-foreground">Approximate: this task started before Chief of Staff recorded step history, so earlier loop-backs are counted from failure counts.</p> : null}
    </Section>
  );
}

/** With no step selected: the task, why it waits, where work went back, and what happened. */
export function TaskOverview({ itemId, title, workflow, task, loops, journal, now }: { itemId: string; title: string; workflow: Workflow; task: TaskDetail | undefined; loops: LoopSummary; journal: readonly JournalRecord[]; now: number }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Select a step to see what it received and produced.</p>
      </div>
      {task?.waitingReason ? <Callout icon="Hand" color={STATUS.warning}>{task.waitingReason}</Callout> : null}
      {task?.lastError && task.status !== "done" ? <Callout icon="CircleAlert" color={STATUS.serious}>{task.lastError}</Callout> : null}
      {task ? (
        <Section title="Task" icon="FileText">
          {task.body?.trim() ? <TextBlock>{task.body}</TextBlock> : <p className="text-xs text-muted-foreground">{task.issueNumber ? `GitHub issue #${task.issueNumber}.` : "No description."}</p>}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {task.threadId ? <ThreadButton threadId={task.threadId} label="Open builder thread" /> : null}
            {task.issueUrl ? <span className="inline-flex h-7 items-center gap-1 rounded-md border border-input px-2 font-medium"><Icon name="CircleDot" fallback="Circle" className="size-3.5" aria-hidden /><UrlLink href={task.issueUrl}>Issue #{task.issueNumber}</UrlLink></span> : null}
            {task.prUrl ? <span className="inline-flex h-7 items-center gap-1 rounded-md border border-input px-2 font-medium"><Icon name="GitPullRequest" fallback="Circle" className="size-3.5" aria-hidden /><UrlLink href={task.prUrl}>PR #{task.prNumber}</UrlLink></span> : null}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {task.repo} · started {relative(task.createdAt, now)}
            {task.lastActivityAt ? ` · last activity ${relative(task.lastActivityAt, now)}` : ""}
          </p>
        </Section>
      ) : null}
      <LoopList workflow={workflow} loops={loops} />
      <Timeline itemId={itemId} workflow={workflow} entries={journal} now={now} empty={task?.status === "done" || task?.status === "failed" ? "No step history was recorded for this task." : "No history yet. Steps are recorded as they start, report, pass, fail or get sent back."} />
      {loops.approximate && journal.length ? <p className="text-[11px] text-muted-foreground">History recorded from {new Date(journal[0]!.at).toLocaleString()}; earlier steps of this task are not in it.</p> : null}
    </div>
  );
}

function StepSettings({ step, live }: { step: Step; live: LiveStatus | undefined }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer rounded font-semibold uppercase tracking-wide text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">Step settings</summary>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {step.type === "agent" ? <p>{step.writes ? "Writes code" : "Read-only"} · {step.agents} {step.agents === 1 ? "agent" : "agents"}{step.approval ? " · Approval required" : ""}{step.verdict ? " · Pass/fail" : ""}</p> : null}
        {step.type === "check" ? <p className="break-all"><b>Command:</b> <span className="font-mono">{step.command}</span></p> : null}
        {step.type === "ship" ? <p><b>Action:</b> {step.action}</p> : null}
        {step.type === "model" ? (
          modelMode(step) === "auto"
            ? <p><b>Picked:</b> {live?.picked ?? (live?.status === "done" ? "nothing (kept the current model)" : "not yet: an agent picks the best model for the task")}</p>
            : <p><b>Sets:</b> {[step.providerId, step.model, step.reasoningLevel].filter(Boolean).join(" · ") || "nothing"}</p>
        ) : null}
        {step.instructions ? <TextBlock>{step.instructions}</TextBlock> : null}
      </div>
    </details>
  );
}

/** The selected step: its state, what it received, what it produced, and its runs. */
export function StepPanel({ itemId, workflow, step, live, detail, steps, journal, now }: { itemId: string; workflow: Workflow; step: Step; live: LiveStatus | undefined; detail: StepDetail | undefined; steps: Record<string, StepDetail> | undefined; journal: readonly JournalRecord[]; now: number }) {
  const tone = liveTone(live);
  const limit = step.type === "agent" ? step.maxRounds : step.type === "model" ? 0 : step.maxAttempts;
  const inputs = stepInputs(workflow, steps, step.id);
  const mine = journal.filter((e) => e.step === step.id || (e.kind === "rerun" && e.to === step.id) || (e.kind === "revised" && e.to === step.id));
  const facts: [string, ReactNode][] = [];
  if (live?.round) facts.push(["Run", live.round]);
  if (step.onFail) facts.push(["Failures", `${live?.attempts ?? 0} (limit ${limit})`]);
  if (detail?.startedAt) facts.push(["Started", relative(detail.startedAt, now)]);
  if (detail?.startedAt) facts.push([detail.finishedAt ? "Took" : "Running for", duration(minutesBetween(detail.startedAt, detail.finishedAt, now))]);
  const onFail = step.onFail ? stepById(workflow, step.onFail)?.name ?? step.onFail : null;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="flex items-center gap-1.5 font-semibold text-foreground">
          <Icon name={STEP_TYPE_META[step.type].icon} fallback="Circle" className="size-4 shrink-0" aria-hidden />
          {step.name}
        </h3>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {STEP_TYPE_META[step.type].label}
          <span aria-hidden>·</span>
          <span aria-hidden className="size-1.5 rounded-full" style={{ background: tone?.color ?? "var(--border)" }} />
          <span className="font-medium text-foreground">{tone?.label ?? "pending"}</span>
          {onFail ? <><span aria-hidden>·</span> on fail, back to {onFail}</> : null}
        </p>
        {facts.length ? (
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {facts.map(([k, v]) => (
              <div key={k} className="flex gap-1.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-medium text-foreground tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      {detail?.waitingReason ? <Callout icon="Hand" color={STATUS.warning}>{detail.waitingReason}</Callout> : null}
      {detail?.threads.length ? (
        <div className="flex flex-wrap gap-1.5">
          {detail.threads.map((t) => <ThreadButton key={t.threadId} threadId={t.threadId} label={detail.threads.length > 1 ? `Agent ${t.agent + 1} thread` : "Open thread"} />)}
        </div>
      ) : null}
      {detail?.feedback ? (
        <Section title="Sent back with" icon="Undo2">
          <TextBlock tone={STATUS.serious}>{detail.feedback}</TextBlock>
        </Section>
      ) : null}
      <Section title="Received" icon="ArrowDownToLine">
        {inputs.length ? (
          inputs.map((i) => (
            <div key={i.from} className="flex flex-col gap-1">
              <p className="text-xs font-medium text-foreground">From {i.name}</p>
              {i.reports.length ? i.reports.map((r) => <TextBlock key={r.agent}>{(i.reports.length > 1 ? `Agent ${r.agent + 1}\n\n` : "") + r.summary}</TextBlock>) : i.output ? <TextBlock mono>{i.output}</TextBlock> : <p className="text-xs text-muted-foreground">Nothing yet.</p>}
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">The task itself: this is where the workflow starts.</p>
        )}
      </Section>
      <Section title="Produced" icon="ArrowUpFromLine">
        {detail?.reports.length ? (
          detail.reports.map((r) => (
            <div key={r.agent} className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">{detail.reports.length > 1 ? `Agent ${r.agent + 1} · ` : ""}{r.outcome} · {relative(r.at, now)}</p>
              <TextBlock tone={r.outcome === "failed" ? STATUS.serious : undefined}>{r.summary}</TextBlock>
            </div>
          ))
        ) : detail?.output ? (
          <TextBlock mono>{detail.output}</TextBlock>
        ) : (
          <p className="text-xs text-muted-foreground">{live?.status === "running" ? "Working on it." : "Nothing yet."}</p>
        )}
      </Section>
      <Timeline itemId={itemId} workflow={workflow} entries={mine} now={now} empty="No runs recorded for this step yet." />
      <StepSettings step={step} live={live} />
    </div>
  );
}
