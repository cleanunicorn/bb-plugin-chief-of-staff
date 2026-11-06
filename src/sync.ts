// Keep work items in step with their BB threads. Events drive most changes,
// but events can be missed (plugin restart, reload) and some changes have no
// event at all (an interaction being answered). The per-minute sweep calls
// syncThreads() to re-read every tracked thread and correct drift.
import type { Cos } from "./context";
import { dispatch } from "./delivery";
import type { WorkItem } from "./state";
import { lastAssistantText, pendingInteractions, plainTextQuestion } from "./threads";

/** Thread statuses that mean a turn is in progress. */
const BUSY = new Set(["active", "starting"]);
/** Failed items are still re-synced this long after failing, so a resumed thread revives them. */
const FAILED_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

/** The item is parked because one of our own effects failed, not because the agent asked anything. */
export function isEffectFailure(item: WorkItem): boolean {
  return item.status === "waiting_on_human" && /^(run_checks|open_pr|send_fix_prompt|respawn): /.test(item.lastError ?? "");
}

function waitingReason(pending: string[]): string {
  return pending.length > 1 ? `${pending[0]} (+${pending.length - 1} more)` : pending[0];
}

/**
 * The agent finished a turn. Before running checks, make sure it is not
 * actually waiting on a human: an open interaction, or a plain-text question.
 */
export async function handleIdle(cos: Cos, item: WorkItem, lastText: string | null | undefined, actor: string): Promise<void> {
  if (!item.threadId) return;
  if (item.status !== "running" && item.status !== "fixing") return;
  const pending = await pendingInteractions(cos, item.threadId);
  if (pending?.length) {
    await dispatch(cos, item.id, { type: "thread_waiting_on_human", reason: waitingReason(pending) }, actor);
    return;
  }
  const question = plainTextQuestion(lastText);
  if (question) {
    await dispatch(cos, item.id, { type: "thread_waiting_on_human", reason: question }, actor);
    return;
  }
  await dispatch(cos, item.id, { type: "thread_idle" }, actor);
}

/**
 * The thread started a turn. If the item is waiting on an interaction that is
 * still open, it is not a resume (some providers report active while asking).
 */
export async function handleActive(cos: Cos, item: WorkItem, actor: string): Promise<void> {
  if (!item.threadId) return;
  if (item.status === "waiting_on_human") {
    const pending = await pendingInteractions(cos, item.threadId);
    if (pending?.length) return;
  }
  await dispatch(cos, item.id, { type: "thread_active" }, actor);
}

export interface SyncResult {
  checked: number;
  changed: number;
}

/** Re-read one item's thread and bring the item in line with it. */
export async function syncItem(cos: Cos, item: WorkItem, actor: string, opts: { rerunChecks?: boolean } = {}): Promise<void> {
  if (!item.threadId) return;
  const failed = item.status === "failed";
  let thread;
  try {
    thread = await cos.bb.sdk.threads.get({ threadId: item.threadId });
  } catch {
    if (!failed) await dispatch(cos, item.id, { type: "thread_failed", error: "thread no longer exists" }, actor);
    return;
  }
  if (thread.deletedAt || thread.archivedAt) {
    if (!failed) await dispatch(cos, item.id, { type: "thread_failed", error: thread.deletedAt ? "thread deleted" : "thread archived" }, actor);
    return;
  }
  if (thread.status === "error") {
    if (!failed) await dispatch(cos, item.id, { type: "thread_failed", error: "thread is in error state" }, actor);
    return;
  }

  const pending = await pendingInteractions(cos, item.threadId);
  if (pending?.length) {
    if (!failed) await dispatch(cos, item.id, { type: "thread_waiting_on_human", reason: waitingReason(pending) }, actor);
    return;
  }

  if (BUSY.has(thread.status)) {
    // Working. If we think it is parked (waiting, blocked, failed, PR open),
    // someone resumed it in BB.
    if (["queued", "waiting_on_human", "blocked", "failed", "pr_open", "ci_failed"].includes(item.status)) {
      await dispatch(cos, item.id, { type: "thread_active" }, actor);
    }
    return;
  }

  if (thread.status === "idle") {
    if (item.status === "waiting_on_human") {
      // Parked, but nothing is actually asking the human (no pending
      // interaction, checked above). Re-evaluate when the item was parked by
      // our own failure (a check run that crashed or timed out) and we are
      // starting up, or when the thread has moved on since we parked it (a
      // turn whose events we missed). A plain-text question keeps it parked.
      const parkedByUs = isEffectFailure(item);
      const movedOn = thread.updatedAt > Date.parse(item.updatedAt);
      if ((parkedByUs && opts.rerunChecks) || movedOn) {
        const lastText = await lastAssistantText(cos, item.threadId);
        if (plainTextQuestion(lastText)) return;
        await dispatch(cos, item.id, { type: "thread_active" }, actor);
        const fresh = cos.store.getWorkItem(item.id) ?? item;
        await handleIdle(cos, fresh, lastText, actor);
      }
    } else if (item.status === "running" || item.status === "fixing") {
      // Missed the idle event.
      const fresh = cos.store.getWorkItem(item.id) ?? item;
      await handleIdle(cos, fresh, await lastAssistantText(cos, item.threadId), actor);
    } else if (item.status === "checking" && opts.rerunChecks) {
      // We restarted mid-check; run it again.
      cos.store.updateWorkItem(item.id, { status: "running" });
      await dispatch(cos, item.id, { type: "thread_idle" }, actor);
    }
  }
}

/** Sync every tracked thread. Called from the per-minute sweep and at startup. */
export async function syncThreads(cos: Cos, actor: string, opts: { rerunChecks?: boolean } = {}): Promise<SyncResult> {
  const now = cos.now().getTime();
  const items = cos.store.listWorkItems({ limit: 200 }).filter((item) => {
    if (!item.threadId) return false;
    if (item.status === "done") return false;
    if (item.status === "failed") return item.finishedAt !== null && now - Date.parse(item.finishedAt) <= FAILED_LOOKBACK_MS;
    return true;
  });
  let changed = 0;
  for (const item of items) {
    const before = `${item.status}|${item.waitingReason ?? ""}`;
    try {
      await syncItem(cos, item, actor, opts);
    } catch (error) {
      cos.bb.log.warn(`sync ${item.id} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
      continue;
    }
    const after = cos.store.getWorkItem(item.id);
    if (after && `${after.status}|${after.waitingReason ?? ""}` !== before) changed += 1;
  }
  if (changed) cos.invalidate();
  return { checked: items.length, changed };
}
