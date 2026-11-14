// Observe BB threads and turn what they do into workflow-engine events.
//
// Every agent thread belongs to an item: the builder (code-writing steps) or
// one agent on a read-only step (see item_threads). Events drive most changes,
// but events can be missed (plugin restart, reload) and some changes have no
// event at all (an interaction answered in BB), so the per-minute sweep re-reads
// every tracked thread in one call and corrects drift. Each observation runs
// under the item's lock and is idempotent: an idle is handled once per thread
// (keyed on the thread's updatedAt), and idles from before Chief of Staff's
// latest prompt to that thread are ignored.
import { acknowledgeReport, deliveryWait, reportMatches, recoverSpawn } from "./deliveryReport";
import type { Cos } from "./context";
import { resumeQueued, dispatchLocked, jobRunning, withItemLock } from "./delivery";
import { MARKED_FAILED } from "./machine";
import { runningWriter } from "./prompts";
import { parseTextReport } from "./report";
import type { ItemThread, WorkItem } from "./state";
import { lastAssistantText, pendingInteractions, plainTextQuestion } from "./threads";
import { observeUsageLimit, tickLimits, type TurnFailure } from "./usageLimit";
import { agentWork, stepById, type AgentWork } from "./workflow";

/** Runtime statuses that mean a turn is in progress (or about to be). */
const BUSY = new Set(["active", "starting", "pending", "provisioning", "waiting-for-host", "stopping"]);
export const isBusy = (status: string): boolean => BUSY.has(status);
/** Failed items are still re-synced this long after failing, so a resumed thread revives them. */
const FAILED_LOOKBACK_MS = 3 * 24 * 60 * 60_000;
/** Thread ids read per threads.list call. */
const THREADS_BATCH = 200;
/** A prompt not picked up by the thread within this long is re-sent. */
const PROMPT_PICKUP_MS = 10 * 60_000;
/** A job whose start is older than this without a running job in this process was lost. */
const LOST_JOB_GRACE_MS = 30_000;
/**
 * A step still running this long after its agent's turn ended, with nothing in
 * flight (no prompt pending, no retry, no report from that agent), lost the
 * turn end: look at the turn again.
 */
export const SETTLED_IDLE_MS = 3 * 60_000;

export interface ThreadSnapshot {
  id: string;
  /** runtime.displayStatus when available, else status. */
  status: string;
  updatedAt: number;
  hasPendingInteraction: boolean | null;
  gone: string | null;
  /** The thread's own status (`status` prefers the runtime's display status). */
  raw?: string;
}

function waitingReason(pending: string[]): string {
  return pending.length > 1 ? `${pending[0]} (+${pending.length - 1} more)` : pending[0];
}

function toMs(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function snapshotOf(thread: { id: string; status: string; updatedAt?: unknown; runtime?: { displayStatus?: string } | null; hasPendingInteraction?: boolean; deletedAt?: unknown; archivedAt?: unknown }): ThreadSnapshot {
  return {
    id: thread.id,
    status: thread.runtime?.displayStatus ?? thread.status,
    raw: thread.status,
    updatedAt: toMs(thread.updatedAt),
    hasPendingInteraction: typeof thread.hasPendingInteraction === "boolean" ? thread.hasPendingInteraction : null,
    gone: thread.deletedAt ? "thread deleted" : thread.archivedAt ? "thread archived" : thread.status === "error" ? "thread is in error state" : null,
  };
}

export interface ThreadContext {
  row: ItemThread | null;
  role: "builder" | "step";
  step: AgentWork | null;
  agent: number;
}

/** Done or failed: the engine ignores what the task's threads do, so observers do not read them. */
const isClosed = (item: WorkItem) => item.status === "done" || item.status === "failed";

/** Which step (and agent) a thread is working on for an item right now. */
export function threadContext(cos: Cos, item: WorkItem, threadId: string): ThreadContext | null {
  const row = cos.store.getThread(threadId);
  if (row?.itemId === item.id && row.role === "step" && row.stepId) {
    const s = stepById(item.workflow, row.stepId);
    return { row, role: "step", step: agentWork(s), agent: row.agent };
  }
  if ((row?.itemId === item.id && row.role === "builder") || item.threadId === threadId) return { row, role: "builder", step: runningWriter(item), agent: 0 };
  return null;
}

/**
 * A turn ended on one of the item's threads. Decide whether the agent finished
 * its step (report), asked something, or went quiet.
 */
export async function observeIdle(cos: Cos, itemId: string, threadId: string, thread: Pick<ThreadSnapshot, "updatedAt">, lastText: string | null | undefined, actor: string, opts: { force?: boolean } = {}): Promise<void> {
  await withItemLock(itemId, async () => {
    let item = cos.store.getWorkItem(itemId);
    if (!item || isClosed(item)) return;
    const ctx = threadContext(cos, item, threadId);
    if (!ctx?.step) return;
    const step = ctx.step;
    const row = ctx.row;
    const updatedAt = thread.updatedAt;
    // Handled already (event and sync both saw it), or a turn older than our latest prompt.
    // `force`: the idle was marked handled, yet the step is still running with nothing in flight.
    if (!opts.force && updatedAt && row?.idleSeenAt && updatedAt <= row.idleSeenAt) return;
    if (updatedAt && row?.promptSentAt && updatedAt < row.promptSentAt) return;

    const pending = await pendingInteractions(cos, threadId);
    if (pending?.length) {
      await dispatchLocked(cos, item.id, { type: "interaction_pending", step: step.id, agent: ctx.agent, reason: waitingReason(pending) }, actor);
      return;
    }

    // Parked on this agent's question, but the thread moved on since: someone
    // answered in BB and we missed the turn starting.
    const parked = item.nodes[step.id];
    if (parked?.status === "waiting" && parked.waiting && ["question", "no_report", "stalled"].includes(parked.waiting.kind) && (parked.waiting.agent ?? ctx.agent) === ctx.agent && updatedAt && updatedAt > (row?.idleSeenAt ?? 0)) {
      await dispatchLocked(cos, item.id, { type: "turn_started", step: step.id, agent: ctx.agent }, actor);
      item = cos.store.getWorkItem(itemId);
      if (!item) return;
    }
    const node = item.nodes[step.id];
    if (node?.status !== "running" && !deliveryWait(item, step.id)) return;
    const round = node.round;

    const text = lastText === undefined ? await lastAssistantText(cos, threadId) : lastText;
    const fromTool = row?.pendingReport && row.pendingReport.step === step.id && row.pendingReport.round === round ? row.pendingReport : null;
    const fromText = fromTool ? null : parseTextReport(text, cos.now().toISOString());
    const report = fromTool ?? (fromText && fromText.step === step.id ? fromText : null);
    if (report) {
      if (!reportMatches(cos, item, step, ctx.agent, threadId, report.delivery)) return;
      await acknowledgeReport(cos, item, step, ctx.agent, threadId);
    } else if (deliveryWait(item, step.id) || (row && row.round !== round) || (node.deliveries?.[ctx.agent] && node.deliveries[ctx.agent].state !== "accepted")) return;
    const question = report ? null : plainTextQuestion(text);
    if (row) cos.store.updateThread(threadId, { idleSeenAt: updatedAt || row.idleSeenAt, pendingReport: null });
    try {
      await dispatchLocked(cos, item.id, { type: "turn_ended", step: step.id, agent: ctx.agent, round, report: report ? { outcome: report.outcome, summary: report.summary, question: report.question ?? null, choice: report.choice ?? null, ...(report.pick ? { pick: report.pick } : {}), at: report.at, via: report.via } : null, question }, actor);
    } catch (error) {
      // The engine did not take the turn end: keep the report and the idle
      // unhandled so the next sweep tries again instead of losing them.
      if (row) cos.store.updateThread(threadId, { idleSeenAt: row.idleSeenAt, pendingReport: row.pendingReport });
      throw error;
    }
  });
}

/** A turn started on one of the item's threads. */
export async function observeActive(cos: Cos, itemId: string, threadId: string, actor: string): Promise<void> {
  await withItemLock(itemId, async () => {
    const item = cos.store.getWorkItem(itemId);
    if (!item || isClosed(item)) return;
    cos.store.updateWorkItem(item.id, { lastActivityAt: cos.now().toISOString() });
    const ctx = threadContext(cos, item, threadId);
    if (!ctx?.step) return;
    const node = item.nodes[ctx.step.id];
    // The turn that hit a usage limit was retried: the agent works again.
    if (node?.limits?.[ctx.agent]) {
      await dispatchLocked(cos, item.id, { type: "turn_started", step: ctx.step.id, agent: ctx.agent }, actor);
      return;
    }
    if (node?.status !== "waiting" || !node.waiting) return;
    // Some providers report active while an interaction is open: not a resume.
    const pending = await pendingInteractions(cos, threadId);
    if (pending?.length) return;
    await dispatchLocked(cos, item.id, { type: "turn_started", step: ctx.step.id, agent: ctx.agent }, actor);
  });
}

export async function observeInteraction(cos: Cos, itemId: string, threadId: string, reason: string, actor: string): Promise<void> {
  await withItemLock(itemId, async () => {
    const item = cos.store.getWorkItem(itemId);
    if (!item || isClosed(item)) return;
    const ctx = threadContext(cos, item, threadId);
    if (!ctx?.step) return;
    await dispatchLocked(cos, item.id, { type: "interaction_pending", step: ctx.step.id, agent: ctx.agent, reason }, actor);
  });
}

/**
 * One of an item's threads failed or is gone. `errored`: the thread is in
 * BB's error state (its turn failed), so the failure may be a usage limit to
 * wait out; `failure` is BB's account of that turn when the event carried it.
 */
export async function observeFailure(cos: Cos, itemId: string, threadId: string, error: string, actor: string, opts: { errored?: boolean; failure?: TurnFailure | null } = {}): Promise<void> {
  if (opts.errored && (await observeUsageLimit(cos, itemId, threadId, actor, opts.failure))) return;
  await withItemLock(itemId, async () => {
    const item = cos.store.getWorkItem(itemId);
    if (!item || isClosed(item)) return;
    const ctx = threadContext(cos, item, threadId);
    if (!ctx) return;
    if (ctx.role === "builder") {
      await dispatchLocked(cos, item.id, { type: "thread_failed", step: null, agent: 0, error }, actor);
      return;
    }
    // A step thread from an earlier round, or a step that is over: housekeeping, not a failure.
    const node = ctx.step ? item.nodes[ctx.step.id] : undefined;
    if (!ctx.step || !node || (node.status !== "running" && node.status !== "waiting") || (ctx.row && ctx.row.round !== node.round)) return;
    await dispatchLocked(cos, item.id, { type: "thread_failed", step: ctx.step.id, agent: ctx.agent, error }, actor);
  });
}

export interface SyncResult {
  checked: number;
  changed: number;
}

/** Bring one item in line with one of its threads. */
export async function syncThread(cos: Cos, item: WorkItem, snapshot: ThreadSnapshot, actor: string): Promise<void> {
  if (item.queuedEvent) return;
  const ctx = threadContext(cos, item, snapshot.id);
  if (!ctx) return;
  if (snapshot.gone) {
    await observeFailure(cos, item.id, snapshot.id, snapshot.gone, actor, { errored: snapshot.raw === "error" });
    return;
  }
  if (!ctx.step) return;
  const node = item.nodes[ctx.step.id];
  if (!node || node.status === "done" || node.status === "pending") return;
  if (snapshot.hasPendingInteraction !== false) {
    const pending = await pendingInteractions(cos, snapshot.id);
    if (pending?.length) {
      await observeInteraction(cos, item.id, snapshot.id, waitingReason(pending), actor);
      return;
    }
  }
  if (BUSY.has(snapshot.status)) {
    // Working. If the step is parked, someone resumed the thread in BB; if it waited out a usage limit, BB retried it.
    const retried = Boolean(node.limits?.[ctx.agent]) && (snapshot.raw === "active" || snapshot.raw === "starting");
    if (node.status === "waiting" || retried) await observeActive(cos, item.id, snapshot.id, actor);
    else cos.store.updateWorkItem(item.id, { lastActivityAt: new Date(Math.max(snapshot.updatedAt, Date.parse(item.lastActivityAt ?? item.createdAt))).toISOString() });
    return;
  }
  if (snapshot.status !== "idle") return;
  const row = ctx.row;
  if (!node.deliveries?.[ctx.agent] && node.status === "running" && row?.promptSentAt && row.round === node.round && snapshot.updatedAt && snapshot.updatedAt < row.promptSentAt) {
    // We sent a prompt the thread never picked up: send it again.
    if (cos.now().getTime() - row.promptSentAt > PROMPT_PICKUP_MS) {
      const step = ctx.step.id;
      await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "effect_error", step, effect: { type: "agent", step, agent: ctx.agent, kind: "nudge" }, message: "the agent did not pick up its prompt" }, actor));
    }
    return;
  }
  await observeIdle(cos, item.id, snapshot.id, snapshot, undefined, actor, { force: lostIdle(cos, item, ctx, snapshot) });
}

/**
 * The agent's turn ended and was marked handled, yet its step still runs with
 * nothing in flight: Chief of Staff dropped the turn end (a crash, a reload).
 * Reading it again moves the step on (report), parks it (question) or nudges
 * the agent, within the usual nudge budget.
 */
function lostIdle(cos: Cos, item: WorkItem, ctx: ThreadContext, snapshot: ThreadSnapshot): boolean {
  const row = ctx.row;
  const node = ctx.step ? item.nodes[ctx.step.id] : undefined;
  if (!row || !node || node.status !== "running" || node.retry || node.reports[ctx.agent]) return false;
  if (row.round !== node.round || !snapshot.updatedAt || !row.idleSeenAt || snapshot.updatedAt > row.idleSeenAt) return false;
  if (row.promptSentAt && row.promptSentAt > snapshot.updatedAt) return false; // our latest prompt is still to be picked up
  return cos.now().getTime() - snapshot.updatedAt >= SETTLED_IDLE_MS;
}

async function snapshots(cos: Cos, ids: string[]): Promise<Map<string, ThreadSnapshot>> {
  const map = new Map<string, ThreadSnapshot>();
  for (let i = 0; i < ids.length; i += THREADS_BATCH) {
    try {
      const list = await cos.bb.sdk.threads.list({ threadIds: ids.slice(i, i + THREADS_BATCH), includeHidden: true, limit: THREADS_BATCH });
      for (const t of list) map.set(t.id, snapshotOf(t as never));
    } catch (error) {
      cos.bb.log.debug(`threads.list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Archived / deleted threads drop out of the list: read them one by one.
  for (const id of ids) {
    if (map.has(id)) continue;
    try {
      map.set(id, snapshotOf((await cos.bb.sdk.threads.get({ threadId: id })) as never));
    } catch {
      map.set(id, { id, status: "error", updatedAt: 0, hasPendingInteraction: false, gone: "thread no longer exists" });
    }
  }
  return map;
}

/** The threads of an item worth reading: the builder plus every step thread. */
function threadIdsOf(cos: Cos, item: WorkItem): string[] {
  const ids = new Set(cos.store.listThreads(item.id).map((t) => t.threadId));
  if (item.threadId) ids.add(item.threadId);
  return [...ids];
}

/** Sync every tracked thread. Called from the per-minute sweep and at startup. */
export async function syncThreads(cos: Cos, actor: string): Promise<SyncResult> {
  const failedSince = new Date(cos.now().getTime() - FAILED_LOOKBACK_MS).toISOString();
  const items = cos.store.listWorkItems({ activeOnly: true, failedSince }).filter((item) => !cos.store.isPaused(item.repo));
  if (items.some((item) => Object.values(item.nodes).some((node) => Object.values(node.deliveries ?? {}).some((attempt) => !attempt.threadId && attempt.round === node.round)))) {
    // Bounded discovery after a spawn response was lost. Metadata, never status,
    // identifies candidates. An undiscovered thread remains uncertain.
    try {
      const candidates = await cos.bb.sdk.threads.list({ includeHidden: true, limit: 200 });
      for (const thread of candidates) await recoverSpawn(cos, thread.id);
    } catch (error) { cos.bb.log.debug(`spawn reconciliation failed: ${error instanceof Error ? error.message : String(error)}`); }
    for (let i = 0; i < items.length; i++) items[i] = cos.store.getWorkItem(items[i].id) ?? items[i];
  }
  const perItem = new Map(items.map((i) => [i.id, threadIdsOf(cos, i)]));
  const threads = await snapshots(cos, [...new Set([...perItem.values()].flat())]);
  let changed = 0;
  for (const item of items) {
    const before = `${item.status}|${item.waitingReason ?? ""}`;
    for (const id of perItem.get(item.id) ?? []) {
      const snapshot = threads.get(id);
      if (!snapshot) continue;
      const fresh = cos.store.getWorkItem(item.id) ?? item;
      try {
        if (fresh.status === "failed") {
          // A resumed builder revives a failed item, unless the operator marked it failed.
          if (id === fresh.threadId && BUSY.has(snapshot.status) && fresh.lastError !== MARKED_FAILED) await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "revive" }, actor));
          continue;
        }
        await syncThread(cos, fresh, snapshot, actor);
      } catch (error) {
        cos.bb.log.warn(`sync ${item.id} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
      }
    }
    const after = cos.store.getWorkItem(item.id);
    if (after && `${after.status}|${after.waitingReason ?? ""}` !== before) changed += 1;
  }
  if (changed) cos.invalidate();
  return { checked: items.length, changed };
}

/** Retry due infrastructure errors, restart lost jobs, start queued items. */
export async function tickItems(cos: Cos, actor: string): Promise<void> {
  await resumeQueued(cos, actor);
  await tickLimits(cos, actor);
  const now = cos.now().getTime();
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (!item.workflow.steps.length || cos.store.isPaused(item.repo)) continue;
    if (item.queuedEvent) continue;
    // One item failing must not hold up other items.
    try {
      for (const [stepId, node] of Object.entries(item.nodes)) {
        if (Object.values(node.deliveries ?? {}).some((a) => a.state === "sending" && a.round === node.round)) {
          await withItemLock(item.id, async () => {
            const current = cos.store.getWorkItem(item.id)?.nodes[stepId];
            for (const [agent, attempt] of Object.entries(current?.deliveries ?? {})) {
              if (attempt.state !== "sending" || attempt.round !== current?.round) continue;
              await dispatchLocked(cos, item.id, { type: "effect_error", step: stepId, effect: { type: "agent", step: stepId, agent: Number(agent), kind: "start" }, message: "Delivery was interrupted before its acceptance could be recorded.", uncertain: true }, actor);
            }
          });
        }
        if ((node.retry?.at && Date.parse(node.retry.at) <= now) || Object.values(node.agentRetries ?? {}).some((r) => r.at && Date.parse(r.at) <= now)) await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "retry_due", step: stepId }, actor));
      }
      const fresh = cos.store.getWorkItem(item.id) ?? item;
      if (fresh.jobStartedAt && !jobRunning(item.id) && now - Date.parse(fresh.jobStartedAt) > LOST_JOB_GRACE_MS) {
        cos.store.log({ level: "warn", kind: "job", repo: item.repo, workItemId: item.id, message: "a Chief of Staff job was not running (restart?); starting it again", actor });
        await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "resume_job" }, actor));
      } else if (fresh.status === "queued" && now - Date.parse(fresh.updatedAt) > LOST_JOB_GRACE_MS) {
        await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "start" }, actor));
      }
    } catch (error) {
      cos.bb.log.warn(`tick ${item.id} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
    }
  }
}
