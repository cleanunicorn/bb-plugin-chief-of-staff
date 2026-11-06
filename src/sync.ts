// Observe BB threads and turn what they do into stage-machine events.
//
// Events drive most changes, but events can be missed (plugin restart,
// reload) and some changes have no event at all (an interaction answered in
// BB). The per-minute sweep re-reads every tracked thread in one call and
// corrects drift. Every observation runs under the item's lock and is
// idempotent: an idle is handled once (keyed on the thread's updatedAt), and
// idles from before Chief of Staff's latest prompt are ignored.
import type { Cos } from "./context";
import { dispatchLocked, jobRunning, withItemLock } from "./delivery";
import type { ThreadRole } from "./machine";
import { parseTextReport } from "./report";
import type { WorkItem } from "./state";
import { lastAssistantText, pendingInteractions, plainTextQuestion } from "./threads";

/** Runtime statuses that mean a turn is in progress (or about to be). */
const BUSY = new Set(["active", "starting", "pending", "provisioning", "waiting-for-host", "stopping"]);
/** Failed items are still re-synced this long after failing, so a resumed thread revives them. */
const FAILED_LOOKBACK_MS = 3 * 24 * 60 * 60_000;
/** A prompt not picked up by the thread within this long is re-sent. */
const PROMPT_PICKUP_MS = 10 * 60_000;
/** A job whose start is older than this without a running job in this process was lost. */
const LOST_JOB_GRACE_MS = 30_000;

export interface ThreadSnapshot {
  id: string;
  /** runtime.displayStatus when available, else status. */
  status: string;
  updatedAt: number;
  hasPendingInteraction: boolean | null;
  gone: string | null;
}

function waitingReason(pending: string[]): string {
  return pending.length > 1 ? `${pending[0]} (+${pending.length - 1} more)` : pending[0];
}

export function roleOf(item: WorkItem, threadId: string): ThreadRole | null {
  if (item.threadId === threadId) return "builder";
  if (item.reviewThreadId === threadId) return "reviewer";
  return null;
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
    updatedAt: toMs(thread.updatedAt),
    hasPendingInteraction: typeof thread.hasPendingInteraction === "boolean" ? thread.hasPendingInteraction : null,
    gone: thread.deletedAt ? "thread deleted" : thread.archivedAt ? "thread archived" : thread.status === "error" ? "thread is in error state" : null,
  };
}

/**
 * A turn ended on one of the item's threads. Decide whether the agent
 * finished the stage (report), asked something, or went quiet.
 */
export async function observeIdle(cos: Cos, itemId: string, threadId: string, thread: Pick<ThreadSnapshot, "updatedAt">, lastText: string | null | undefined, actor: string): Promise<void> {
  await withItemLock(itemId, async () => {
    let item = cos.store.getWorkItem(itemId);
    if (!item) return;
    const role = roleOf(item, threadId);
    if (!role) return;
    const updatedAt = thread.updatedAt;
    // Handled already (event and sync both saw it), or a turn older than our latest prompt.
    if (updatedAt && item.idleSeenAt && updatedAt <= item.idleSeenAt) return;
    if (updatedAt && item.promptSentAt && updatedAt < item.promptSentAt) return;

    const pending = await pendingInteractions(cos, threadId);
    if (pending?.length) {
      await dispatchLocked(cos, item.id, { type: "interaction_pending", role, reason: waitingReason(pending) }, actor);
      return;
    }

    // Parked on a question, but the thread moved on since: someone answered
    // in BB and we missed the turn starting.
    // (item.updatedAt is bumped by every activity touch, so compare with the idle we parked on.)
    if (item.status === "waiting_on_human" && (item.waitingKind === "question" || item.waitingKind === "no_report") && updatedAt && updatedAt > (item.idleSeenAt ?? 0)) {
      await dispatchLocked(cos, item.id, { type: "turn_started", role }, actor);
      item = cos.store.getWorkItem(itemId);
      if (!item) return;
    }
    if (item.status !== "agent") return;
    // Only the thread driving the stage ends it (the reviewer during an independent review).
    const driving = item.stage === "review" && item.reviewThreadId ? "reviewer" : "builder";
    if (role !== driving) return;

    const text = lastText === undefined ? await lastAssistantText(cos, threadId) : lastText;
    const at = cos.now().toISOString();
    const report = item.pendingReport ?? parseTextReport(text, at);
    const question = report ? null : plainTextQuestion(text);
    if (updatedAt) cos.store.updateWorkItem(item.id, { idleSeenAt: updatedAt });
    await dispatchLocked(cos, item.id, { type: "turn_ended", role, report, question }, actor);
  });
}

/** A turn started on one of the item's threads. */
export async function observeActive(cos: Cos, itemId: string, threadId: string, actor: string): Promise<void> {
  await withItemLock(itemId, async () => {
    const item = cos.store.getWorkItem(itemId);
    if (!item) return;
    const role = roleOf(item, threadId);
    if (!role) return;
    // Some providers report active while an interaction is open: not a resume.
    if (item.status === "waiting_on_human") {
      // Chief of Staff's own failure is not cleared by someone chatting in the thread.
      if (item.waitingKind === "cos_error") return;
      const pending = await pendingInteractions(cos, threadId);
      if (pending?.length) return;
    }
    cos.store.updateWorkItem(item.id, { lastActivityAt: cos.now().toISOString() });
    await dispatchLocked(cos, item.id, { type: "turn_started", role }, actor);
  });
}

export async function observeInteraction(cos: Cos, itemId: string, threadId: string, reason: string, actor: string): Promise<void> {
  await withItemLock(itemId, async () => {
    const item = cos.store.getWorkItem(itemId);
    const role = item ? roleOf(item, threadId) : null;
    if (!item || !role) return;
    await dispatchLocked(cos, item.id, { type: "interaction_pending", role, reason }, actor);
  });
}

export async function observeFailure(cos: Cos, itemId: string, threadId: string, error: string, actor: string): Promise<void> {
  await withItemLock(itemId, async () => {
    const item = cos.store.getWorkItem(itemId);
    const role = item ? roleOf(item, threadId) : null;
    if (!item || !role || item.status === "failed" || item.status === "done") return;
    await dispatchLocked(cos, item.id, { type: "thread_failed", role, error }, actor);
  });
}

export interface SyncResult {
  checked: number;
  changed: number;
}

/** Bring one item in line with one of its threads. */
export async function syncThread(cos: Cos, item: WorkItem, snapshot: ThreadSnapshot, actor: string): Promise<void> {
  const role = roleOf(item, snapshot.id);
  if (!role) return;
  if (snapshot.gone) {
    // A reviewer that is gone after review finished is fine.
    if (role === "reviewer" && item.stage !== "review") return;
    await observeFailure(cos, item.id, snapshot.id, snapshot.gone, actor);
    return;
  }
  if (snapshot.hasPendingInteraction !== false) {
    const pending = await pendingInteractions(cos, snapshot.id);
    if (pending?.length) {
      if (!["failed", "done"].includes(item.status)) await observeInteraction(cos, item.id, snapshot.id, waitingReason(pending), actor);
      return;
    }
  }
  if (BUSY.has(snapshot.status)) {
    // Working. If we think it is parked, someone resumed it in BB.
    if (["queued", "waiting_on_human", "blocked", "failed", "retrying", "ci", "ready"].includes(item.status)) await observeActive(cos, item.id, snapshot.id, actor);
    else if (item.status === "agent") cos.store.updateWorkItem(item.id, { lastActivityAt: new Date(Math.max(snapshot.updatedAt, Date.parse(item.lastActivityAt ?? item.createdAt))).toISOString() });
    return;
  }
  if (snapshot.status === "idle") {
    const fresh = cos.store.getWorkItem(item.id) ?? item;
    const driving = fresh.stage === "review" && fresh.reviewThreadId ? "reviewer" : "builder";
    if (fresh.status === "agent" && role === driving && fresh.promptSentAt && snapshot.updatedAt && snapshot.updatedAt < fresh.promptSentAt) {
      // We sent a prompt the thread never picked up: send it again.
      if (cos.now().getTime() - fresh.promptSentAt > PROMPT_PICKUP_MS) {
        await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "effect_error", effect: { type: "prompt", target: role, kind: "nudge" }, message: "the agent did not pick up its prompt" }, actor));
      }
      return;
    }
    if (fresh.status === "agent" || fresh.status === "waiting_on_human") await observeIdle(cos, item.id, snapshot.id, snapshot, undefined, actor);
  }
}

async function snapshots(cos: Cos, ids: string[]): Promise<Map<string, ThreadSnapshot>> {
  const map = new Map<string, ThreadSnapshot>();
  if (!ids.length) return map;
  try {
    const list = await cos.bb.sdk.threads.list({ threadIds: ids.slice(0, 200), includeHidden: true, limit: 200 });
    for (const t of list) map.set(t.id, snapshotOf(t as never));
  } catch (error) {
    cos.bb.log.debug(`threads.list failed: ${error instanceof Error ? error.message : String(error)}`);
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

/** Sync every tracked thread. Called from the per-minute sweep and at startup. */
export async function syncThreads(cos: Cos, actor: string): Promise<SyncResult> {
  const now = cos.now().getTime();
  const items = cos.store.listWorkItems({ limit: 200 }).filter((item) => {
    if (!item.threadId) return false;
    if (item.status === "done") return false;
    if (item.status === "failed") return item.finishedAt !== null && now - Date.parse(item.finishedAt) <= FAILED_LOOKBACK_MS;
    return true;
  });
  const ids = [...new Set(items.flatMap((i) => [i.threadId, i.reviewThreadId]).filter((id): id is string => Boolean(id)))];
  const threads = await snapshots(cos, ids);
  let changed = 0;
  for (const item of items) {
    const before = `${item.stage}|${item.status}|${item.waitingReason ?? ""}`;
    // Only the thread driving the current stage matters, plus the builder for resumes.
    const order = item.reviewThreadId && item.stage === "review" ? [item.reviewThreadId, item.threadId] : [item.threadId];
    for (const id of order) {
      const snapshot = id ? threads.get(id) : undefined;
      if (!snapshot) continue;
      try {
        await syncThread(cos, cos.store.getWorkItem(item.id) ?? item, snapshot, actor);
      } catch (error) {
        cos.bb.log.warn(`sync ${item.id} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
      }
    }
    const after = cos.store.getWorkItem(item.id);
    if (after && `${after.stage}|${after.status}|${after.waitingReason ?? ""}` !== before) changed += 1;
  }
  if (changed) cos.invalidate();
  return { checked: items.length, changed };
}

/** Retry due infrastructure errors and restart jobs this process is not running. */
export async function tickItems(cos: Cos, actor: string): Promise<void> {
  const now = cos.now().getTime();
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (item.status === "retrying" && item.retryAt && Date.parse(item.retryAt) <= now) {
      await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "retry_due" }, actor));
    } else if (item.status === "cos" && !jobRunning(item.id) && now - Date.parse(item.jobStartedAt ?? item.updatedAt) > LOST_JOB_GRACE_MS) {
      cos.store.log({ level: "warn", kind: "job", repo: item.repo, workItemId: item.id, message: `${item.stage} job was not running (restart?); starting it again`, actor });
      await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "resume_job" }, actor));
    } else if (item.status === "queued" && now - Date.parse(item.updatedAt) > LOST_JOB_GRACE_MS) {
      await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "start" }, actor));
    }
  }
}
