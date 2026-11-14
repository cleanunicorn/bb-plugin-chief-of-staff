// Agent roster: stored work items with their step states and live thread
// state, stall detection, and reconciliation after a restart (including
// adopting items started before custom workflows).
import type { Cos } from "./context";
import { actorOf, CAPACITY_REASON, freshNode, initialNodes, limitedNode, repoNotConfiguredReason, resetTime, rosterStatus, type Actor, type NodeStatus, type ShipPhase } from "./machine";
import { occupiesCapacity, type FinishedOrder, type PrState, type WaitingKind, type WorkItem } from "./state";
import { FAILED_OUTCOMES, finishedOutcome, MARKED_FAILED, OUTCOME_META, type Outcome } from "./outcome";
import { ROSTER_FINISHED_LIMIT, ROSTER_FINISHED_MAX } from "../rpcContract";
import { itemsUsage, type ItemUsage } from "./usage";
import { applyTransition, dispatch, watchCi } from "./delivery";
import { isBusy, snapshotOf, syncThreads, threadContext, tickItems } from "./sync";
import { agentWork, describePick, isAuthoredAgent, isWriter, pickedModel, depths, descendants, stepById, topoOrder, type StepType, type Workflow } from "./workflow";

const isFinished = (item: Pick<WorkItem, "status">) => item.status === "done" || item.status === "failed";

export interface RosterStep {
  id: string;
  name: string;
  type: StepType;
  /** Longest-path depth: steps with the same depth can run in parallel. */
  depth: number;
  /** "stopped": a finished task left this step running or waiting (display only; the stored node keeps its state). */
  status: NodeStatus | "stopped";
  phase: ShipPhase | null;
  agents: number;
  /** Agents that have reported this round. */
  reported: number;
  /** Most nudges sent to one agent this round (it stopped without reporting). */
  nudged: number;
  attempts: number;
  round: number;
  waitingKind: WaitingKind | null;
  retrying: boolean;
  /** Its agents wait out the provider's usage limit until then (ISO); null otherwise. */
  limitedUntil?: string | null;
  /** An automatic model step: what its agent picked ("provider · model · reasoning"), once it has. */
  picked?: string | null;
}

export interface RosterEntry {
  occupiesCapacity: boolean;
  id: string;
  status: ReturnType<typeof rosterStatus>;
  detail: WorkItem["status"];
  workflowName: string;
  steps: RosterStep[];
  /** Names of the steps running or waiting right now. */
  current: string[];
  /** Who holds the ball: agent, Chief of Staff, you, or an infrastructure retry. */
  actor: Actor;
  /** One line on what is happening right now. */
  activity: string;
  waitingKind: WaitingKind | null;
  repo: string;
  issueNumber: number | null;
  /** The GitHub issue behind the task; null for a standalone task. */
  issueUrl: string | null;
  issueTitle: string;
  threadId: string | null;
  threadStatus: string | null;
  threadTitle: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** The pull request's last read state, when it was read for this prNumber. */
  pr: Omit<PrState, "number"> | null;
  startedAt: string;
  /** When a done or failed task finished; null while it runs. */
  finishedAt: string | null;
  /** How a finished task ended; null while it runs. */
  outcome: Outcome | null;
  lastActivityAt: string | null;
  stalled: boolean;
  fixAttempts: number;
  retryCount: number;
  lastError: string | null;
  waitingReason: string | null;
  providerId: string | null;
  model: string | null;
  source: string;
  /**
   * With withUsage: the task's usage summed over all its agent threads; for a
   * finished task the stored count (`counted` false until it is counted), for
   * an active one read live, so far. Null without withUsage.
   */
  usage: ItemUsage | null;
}

/**
 * Each step's state for display. A finished task's steps are settled: one it
 * left running or waiting reads "stopped", without the phase, retry or
 * waiting kind that would make it look live. Pending steps never ran and stay
 * pending. The stored nodes keep their raw state (rerun depends on it).
 */
export function rosterSteps(item: WorkItem): RosterStep[] {
  const depth = depths(item.workflow);
  const finished = isFinished(item);
  return topoOrder(item.workflow).map((id) => {
    const s = stepById(item.workflow, id)!;
    const n = item.nodes[id] ?? freshNode();
    const stopped = finished && (n.status === "running" || n.status === "waiting");
    return {
      id,
      name: s.name,
      type: s.type,
      depth: depth.get(id) ?? 0,
      status: stopped ? "stopped" : n.status,
      phase: stopped ? null : n.phase,
      agents: agentWork(s)?.agents ?? 1,
      reported: n.reports.filter(Boolean).length,
      nudged: Math.max(0, ...n.nudges),
      attempts: n.attempts,
      round: n.round,
      waitingKind: stopped ? null : (n.waiting?.kind ?? null),
      retrying: !stopped && (Boolean(n.retry?.at) || limitedNode(n)),
      limitedUntil: !stopped && limitedNode(n) ? Object.values(n.limits ?? {}).map((l) => l.until).sort().at(-1)! : null,
      picked: agentWork(s)?.picksModel ? describePick(pickedModel(n)) : null,
    };
  });
}

/** The GitHub URL of a task's issue, or null when the task has none. */
function issueUrlFor(repo: string, issueNumber: number | null): string | null {
  return issueNumber ? `https://github.com/${repo}/issues/${issueNumber}` : null;
}

/** The item's PR state, unless it belongs to an earlier PR than the one it has now. */
function rosterPr(item: WorkItem): RosterEntry["pr"] {
  if (!item.prState || item.prState.number !== item.prNumber) return null;
  const { number: _number, closedAt: _closedAt, ...pr } = item.prState;
  return pr;
}

/** Thread ids per threads.list call. */
const THREAD_BATCH = 200;

export interface RosterOptions {
  repo?: string;
  /** Add a page of finished items after the active ones. */
  includeDone?: boolean;
  /** Finished items per page (default 50, at most 500). */
  finishedLimit?: number;
  /** Cursor from an earlier page's `nextBefore`: return only the next page of finished items. */
  before?: string;
  /** Finished items most recently finished first (default), or most tokens first. A cursor belongs to its order. */
  finishedOrder?: FinishedOrder;
  withUsage?: boolean;
}

export interface Roster {
  entries: RosterEntry[];
  /** Pass as `before` for the next page of finished items; null when there are no more. */
  nextBefore: string | null;
  /**
   * With finished items: the tokens of every finished task in scope (all pages,
   * the repo filter applied), for each task's share; null when none reported
   * tokens or no finished items were asked for.
   */
  finishedTokens: number | null;
}

/** Every active item (newest first), then one page of finished items (most recently finished, or most tokens, first). */
export async function buildRoster(cos: Cos, opts: RosterOptions = {}): Promise<Roster> {
  const { values } = await cos.config();
  const finishedLimit = Math.min(ROSTER_FINISHED_MAX, Math.max(1, Math.floor(opts.finishedLimit ?? ROSTER_FINISHED_LIMIT)));
  const page = cos.store.listRosterItems({ repo: opts.repo, includeDone: opts.includeDone, finishedLimit, before: opts.before, order: opts.finishedOrder });
  const items = [...page.active, ...page.finished];
  const threadIds = [...new Set(items.map((i) => i.threadId).filter((id): id is string => Boolean(id)))];
  const threads = new Map<string, { status: string; title: string | null }>();
  for (let i = 0; i < threadIds.length; i += THREAD_BATCH) {
    const batch = threadIds.slice(i, i + THREAD_BATCH);
    try {
      const list = await cos.bb.sdk.threads.list({ threadIds: batch, includeHidden: true, limit: batch.length });
      for (const t of list) threads.set(t.id, { status: t.runtime?.displayStatus ?? t.status, title: t.title ?? t.titleFallback ?? null });
    } catch (error) {
      cos.bb.log.debug(`threads.list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const stallMs = Math.max(1, values.stallThresholdMinutes) * 60_000;
  const now = cos.now().getTime();
  const manual = cos.store.latestManualActions(items.filter(isFinished).map((i) => i.id));
  const entries: RosterEntry[] = [];
  for (const item of items) {
    const thread = item.threadId ? threads.get(item.threadId) : undefined;
    const last = item.lastActivityAt ?? item.createdAt;
    const steps = rosterSteps(item);
    const outcome = finishedOutcome(item, manual.get(item.id) ?? null);
    entries.push({
      id: item.id,
      occupiesCapacity: occupiesCapacity(item),
      status: rosterStatus(item),
      detail: item.status,
      workflowName: item.workflow.name,
      steps,
      current: steps.filter((s) => s.status === "running" || s.status === "waiting").map((s) => s.name),
      actor: actorOf(item),
      activity: describeActivity(item, steps, outcome),
      waitingKind: item.waitingKind,
      repo: item.repo,
      issueNumber: item.issueNumber,
      issueUrl: issueUrlFor(item.repo, item.issueNumber),
      issueTitle: item.issueTitle,
      threadId: item.threadId,
      threadStatus: thread?.status ?? null,
      threadTitle: thread?.title ?? null,
      branch: item.branch,
      prNumber: item.prNumber,
      prUrl: item.prUrl,
      pr: rosterPr(item),
      startedAt: item.createdAt,
      finishedAt: item.finishedAt,
      outcome,
      lastActivityAt: item.lastActivityAt,
      stalled: item.status === "agent" && now - Date.parse(last) > stallMs,
      fixAttempts: item.fixAttempts,
      retryCount: item.retryCount,
      lastError: item.lastError,
      waitingReason: item.status === "waiting_on_human" || item.status === "blocked" ? item.waitingReason : null,
      providerId: item.providerId,
      model: item.model,
      source: item.source,
      usage: null,
    });
  }
  // Finished items show their stored count: no usage calls for them.
  if (opts.withUsage) (await itemsUsage(cos, items)).forEach((usage, i) => { entries[i]!.usage = usage; });
  const finishedTokens = opts.includeDone || opts.before !== undefined ? cos.store.finishedTokens(opts.repo) : null;
  return { entries, nextBefore: page.nextBefore, finishedTokens };
}

const OUTPUT_MAX = 6_000;
const tail = (text: string | null | undefined, max = OUTPUT_MAX) => (text ? (text.length > max ? `…${text.slice(-max)}` : text) : null);

/** Journal details longer than this go to the workflow view as previews; the rest loads when you expand an entry. */
export const JOURNAL_PREVIEW = 600;

function previewEntry<E extends { kind: string; detail: string | null }>(e: E): E & { truncated?: boolean } {
  if (!e.detail || e.detail.length <= JOURNAL_PREVIEW) return e;
  // Failures and check output end with the error; the rest starts with the point.
  const keepEnd = e.kind === "failed" || e.kind === "passed";
  return { ...e, detail: keepEnd ? `…${e.detail.slice(-JOURNAL_PREVIEW)}` : `${e.detail.slice(0, JOURNAL_PREVIEW)}…`, truncated: true };
}

/** The task, each step's current inputs and outputs, and its journal, for the task's workflow view. */
export function itemRunDetail(cos: Pick<Cos, "store">, item: WorkItem) {
  const threads = cos.store.listThreads(item.id);
  // Nobody waits on a finished task: its stopped steps keep no "needs you" reason.
  const finished = isFinished(item);
  const steps = Object.fromEntries(item.workflow.steps.map((s) => {
    const n = item.nodes[s.id] ?? freshNode();
    const own = threads.filter((t) => t.role === "step" ? t.stepId === s.id : agentWork(s)?.writes).map((t) => ({ threadId: t.threadId, agent: t.role === "step" ? t.agent : 0 }));
    // The builder thread may predate item_threads rows.
    if (agentWork(s)?.writes && item.threadId && !own.some((t) => t.threadId === item.threadId)) own.unshift({ threadId: item.threadId, agent: 0 });
    return [s.id, {
      startedAt: n.startedAt,
      finishedAt: n.finishedAt,
      feedback: tail(n.feedback),
      output: tail(n.output),
      waitingReason: finished ? null : (n.waiting?.reason ?? null),
      reports: n.reports.flatMap((r, agent) => (r ? [{ agent, outcome: r.outcome, summary: tail(r.summary)!, at: r.at }] : [])),
      threads: own,
    }];
  }));
  return {
    task: {
      repo: item.repo,
      issueNumber: item.issueNumber,
      issueUrl: issueUrlFor(item.repo, item.issueNumber),
      body: tail(item.taskBody),
      status: item.status,
      branch: item.branch,
      prNumber: item.prNumber,
      prUrl: item.prUrl,
      threadId: item.threadId,
      waitingReason: finished ? null : item.waitingReason,
      lastError: item.lastError,
      createdAt: item.createdAt,
      lastActivityAt: item.lastActivityAt,
      finishedAt: item.finishedAt,
    },
    steps,
    journal: cos.store.listJournal(item.id).map(previewEntry),
  };
}

/** How a finished task ended, with why when it did not deliver ("Failed: thread archived"). */
export function describeOutcome(outcome: Outcome, lastError: string | null): string {
  const label = OUTCOME_META[outcome].label;
  if (!FAILED_OUTCOMES.includes(outcome) || !lastError) return label;
  // A person ended it: mark_failed stores MARKED_FAILED; any other stored error is only the last seen, not the cause.
  if (outcome === "marked_failed") return lastError === MARKED_FAILED ? label : `${label} (last error: ${lastError})`;
  // "PR closed without merge" already says it.
  return lastError.toLowerCase().startsWith(label.toLowerCase()) ? lastError : `${label}: ${lastError}`;
}

/** One line on what is happening right now, for the roster. */
export function describeActivity(item: WorkItem, steps: RosterStep[] = rosterSteps(item), outcome: Outcome | null = finishedOutcome(item, null)): string {
  if (outcome) return describeOutcome(outcome, item.lastError);
  switch (item.status) {
    case "queued":
      if (item.queuedEvent && item.waitingReason === repoNotConfiguredReason(item.repo)) return item.waitingReason;
      return item.queuedEvent?.type === "ci_failing" ? "CI repair waiting for task capacity" : item.queuedEvent ? CAPACITY_REASON : "Waiting to start";
    case "waiting_on_human":
    case "blocked":
      return item.waitingReason ?? "Waiting on you";
    default:
      break;
  }
  const parts = steps
    .filter((s) => s.status === "running")
    .map((s) => {
      if (s.limitedUntil) return `${s.name}: usage limit reached; continues after ${resetTime(s.limitedUntil)}`;
      if (s.retrying) return `${s.name}: Chief of Staff retrying after an error`;
      if (s.type === "check") return `${s.name}: running the check`;
      if (s.type === "ship") {
        if (s.phase === "ci") return `${s.name}: PR #${item.prNumber} open, waiting for CI`;
        if (s.phase === "ready") return `${s.name}: PR #${item.prNumber} green${item.lastError && !item.lastError.startsWith("ci-") ? `, ${item.lastError}` : ", ready to merge"}`;
        if (s.phase === "merging") return `${s.name}: merging PR #${item.prNumber}`;
        return `${s.name}: pushing and opening the PR`;
      }
      if (s.nudged) return `${s.name}: agent stopped without reporting; nudged ${s.nudged}×`;
      return s.agents > 1 ? `${s.name}: ${s.reported}/${s.agents} agents reported` : `${s.name}: agent working${s.round > 1 ? ` (round ${s.round})` : ""}`;
    });
  return parts.join(" · ") || "Working";
}

/** Flag agent steps whose item shows no activity past the threshold. */
export async function detectStalls(cos: Cos, actor: string): Promise<string[]> {
  const { values } = await cos.config();
  const stallMs = Math.max(1, values.stallThresholdMinutes) * 60_000;
  const now = cos.now().getTime();
  const stalled: string[] = [];
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (item.status !== "agent" || cos.store.isPaused(item.repo)) continue;
    const last = Date.parse(item.lastActivityAt ?? item.createdAt);
    if (now - last <= stallMs) continue;
    // Confirm against the live threads: one still streaming means not stalled.
    const ids = [item.threadId, ...cos.store.listThreads(item.id).map((t) => t.threadId)].filter((id): id is string => Boolean(id));
    let fresh = false;
    let busy = false;
    for (const threadId of new Set(ids)) {
      try {
        const thread = await cos.bb.sdk.threads.get({ threadId });
        const updated = typeof thread.updatedAt === "number" ? thread.updatedAt : Date.parse(String(thread.updatedAt));
        if (Number.isFinite(updated) && now - updated <= stallMs) {
          cos.store.updateWorkItem(item.id, { lastActivityAt: new Date(updated).toISOString() });
          fresh = true;
          break;
        }
        if (isBusy(snapshotOf(thread as never).status) && runsStep(cos, item, threadId)) busy = true;
      } catch {
        // Unknown: treat as a quiet turn that never ended.
        busy = true;
      }
    }
    if (fresh) continue;
    // Every agent of the running steps is idle: their turns ended, and the
    // thread sync (which reads a settled turn again and nudges) could not move
    // the step on. Say that, rather than blaming a quiet agent.
    const reason = busy ? undefined : "The agent's turn ended, but Chief of Staff could not move the step on. Approve to treat it as done, or send it instructions.";
    stalled.push(item.id);
    cos.store.log({ level: "warn", kind: "stall", repo: item.repo, workItemId: item.id, message: `no activity for ${Math.round((now - last) / 60_000)} min${busy ? "" : " (agent idle)"}`, actor });
    for (const s of item.workflow.steps) {
      if (agentWork(s) && item.nodes[s.id]?.status === "running") await dispatch(cos, item.id, { type: "stalled", step: s.id, agent: 0, ...(reason ? { reason } : {}) }, actor);
    }
  }
  return stalled;
}

/** Map a pre-workflow stage name onto a step of the item's workflow. */
export function stepForStage(wf: Workflow, stage: string): string | undefined {
  if (stepById(wf, stage)) return stage;
  const find = (pred: (s: Workflow["steps"][number]) => boolean) => topoOrder(wf).map((id) => stepById(wf, id)!).find(pred)?.id;
  switch (stage) {
    // Old "plan"/"review" stages were authored agent steps, never a model-choosing agent.
    case "plan":
      return find((s) => isAuthoredAgent(s) && !s.writes);
    case "verify":
      return find((s) => s.type === "check");
    case "review":
      return find((s) => isAuthoredAgent(s) && s.verdict);
    case "ship":
      return find((s) => s.type === "ship");
    default:
      return find(isWriter);
  }
}

/** Give an item from before custom workflows its repo's workflow, resuming at its old stage. */
export async function adoptLegacyItem(cos: Cos, item: WorkItem): Promise<void> {
  const workflow = await cos.workflow(item.repo);
  const nodes = initialNodes(workflow);
  const stage = cos.store.legacyStage(item.id) ?? "build";
  const current = stepForStage(workflow, stage) ?? topoOrder(workflow)[0]!;
  const after = descendants(workflow, current);
  const at = cos.now().toISOString();
  for (const id of topoOrder(workflow)) if (!after.has(id)) Object.assign(nodes[id]!, { status: "done", round: 1, finishedAt: at });
  const node = nodes[current]!;
  const step = stepById(workflow, current)!;
  if (step.type === "ship" && item.prNumber && ["ci", "ready"].includes(item.status)) {
    Object.assign(node, { status: "running", round: 1, phase: item.status as "ci" | "ready", startedAt: at });
  } else if (item.status === "waiting_on_human") {
    Object.assign(node, { status: "waiting", round: 1, reports: [null], nudges: [0], waiting: { kind: item.waitingKind === "cos_error" ? "escalation" : "question", reason: item.waitingReason ?? "Waiting on you (carried over from before custom workflows)." }, startedAt: at });
  } else {
    node.feedback = "Chief of Staff was updated while you worked on this. Continue where you left off, then report the step.";
  }
  if (item.threadId) cos.store.upsertThread({ threadId: item.threadId, itemId: item.id, role: "builder", stepId: null, agent: 0, environmentId: item.environmentId, round: 1, promptSentAt: null });
  const adopted = { ...item, workflow, nodes };
  cos.store.updateWorkItem(item.id, { workflow, ...applyTransition(adopted, nodes, {}), status: "queued" });
  cos.store.log({ level: "info", kind: "reconcile", repo: item.repo, workItemId: item.id, message: `moved onto workflow “${workflow.name}” at ${step.name}`, actor: "startup" });
  await dispatch(cos, item.id, { type: "start" }, "startup");
}

/** After a restart: adopt old items, re-sync every thread, then restart lost jobs and due retries. */
export async function reconcile(cos: Cos): Promise<void> {
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (item.workflow.steps.length) continue;
    try {
      await adoptLegacyItem(cos, item);
    } catch (error) {
      cos.bb.log.warn(`adopting ${item.id} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
    }
  }
  await watchCi(cos, "startup").catch((error) => cos.bb.log.warn(`PR reconciliation failed: ${error instanceof Error ? error.message : String(error)}`));
  await syncThreads(cos, "startup");
  await tickItems(cos, "startup");
  // Steps parked by our own failure get one fresh attempt after a restart or plugin update.
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (cos.store.isPaused(item.repo)) continue;
    for (const [stepId, n] of Object.entries(item.nodes)) {
      if (n.status === "waiting" && n.waiting?.kind === "cos_error" && n.retry && !n.retry.uncertain && (n.retry.effect.type !== "agent" || n.retry.uncertain === false)) await dispatch(cos, item.id, { type: "retry", step: stepId }, "startup");
    }
  }
  cos.invalidate();
}

/** The thread works on a step of the item that is running now. */
function runsStep(cos: Cos, item: WorkItem, threadId: string): boolean {
  const step = threadContext(cos, item, threadId)?.step;
  return Boolean(step && item.nodes[step.id]?.status === "running");
}
