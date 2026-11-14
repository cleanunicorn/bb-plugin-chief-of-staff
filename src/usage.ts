// Token usage of a task, summed over every agent thread it spawned: counted
// once for finished tasks by a bounded sweep pass and stored, read live for
// active tasks.
import type { Cos } from "./context";
import { isActiveStatus, type WorkItem } from "./state";
import { isBusy } from "./sync";
import { itemThreadIds } from "./threadGroups";
import { readTasksUsage, type TaskUsage } from "./threads";

/** A task's usage for display. `counted` is false for a finished task whose usage is not counted yet. */
export type ItemUsage = TaskUsage & { counted: boolean };

/** Finished items counted per sweep. */
export const USAGE_BATCH = 10;
/** An item whose count stored nothing (a thread busy, a read failed) is tried again after this long. */
export const USAGE_RETRY_MS = 10 * 60_000;
/**
 * A finished task's threads are waited for this long after it finished; past
 * it, a thread that still looks busy (its host gone for good, a stop that never
 * completed) no longer holds the count back, and what the threads reported is stored.
 */
export const USAGE_BUSY_WAIT_MS = 24 * 60 * 60_000;
/** Time one sweep's usage pass may take; items left over are counted by the next sweep. */
export const USAGE_BUDGET_MS = 30_000;

const NOTHING = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null } as const;

/** A finished task's stored usage, or a not-counted-yet placeholder. Makes no SDK calls. */
export function storedUsage(cos: Pick<Cos, "store">, item: WorkItem): ItemUsage {
  if (item.taskUsage) return { ...item.taskUsage, counted: true };
  return { ...NOTHING, threads: itemThreadIds(cos, item).length, reportedThreads: 0, counted: false };
}

/** Each item's usage: stored for finished items, read live over all threads for active ones. */
export async function itemsUsage(cos: Cos, items: readonly WorkItem[]): Promise<ItemUsage[]> {
  const live = items.filter((item) => isActiveStatus(item.status));
  const reads = await readTasksUsage(cos, live.map((item) => itemThreadIds(cos, item)));
  const byId = new Map(live.map((item, i) => [item.id, { ...reads[i]!.usage, counted: true }]));
  return items.map((item) => byId.get(item.id) ?? storedUsage(cos, item));
}

/**
 * Count the usage of up to `limit` finished items not counted yet, summed over
 * all their threads. An item is stored only when every read completed (a
 * deleted thread counts as reporting nothing) and, within USAGE_BUSY_WAIT_MS
 * of finishing, none of its threads is busy (a task can be marked done while
 * an agent still works); otherwise the attempt is stamped and retried after
 * USAGE_RETRY_MS. Stops starting items once `budgetMs` has passed. Returns the ids stored.
 */
export async function countFinishedUsage(cos: Cos, limit = USAGE_BATCH, budgetMs = USAGE_BUDGET_MS): Promise<string[]> {
  const now = cos.now();
  const deadline = now.getTime() + budgetMs;
  const due = cos.store.listUsageDue(new Date(now.getTime() - USAGE_RETRY_MS).toISOString(), limit);
  const stored: string[] = [];
  for (const item of due) {
    if (cos.store.isPaused() || cos.now().getTime() >= deadline) break;
    const at = cos.now().toISOString();
    const ids = itemThreadIds(cos, item);
    const waitForBusy = cos.now().getTime() - Date.parse(item.finishedAt ?? item.updatedAt) < USAGE_BUSY_WAIT_MS;
    try {
      if (ids.length && waitForBusy && (await anyBusy(cos, ids))) {
        cos.store.touchUsageChecked(item.id, at);
        continue;
      }
      const [read] = await readTasksUsage(cos, [ids]);
      if (!read!.complete) cos.store.touchUsageChecked(item.id, at);
      else if (cos.store.setTaskUsage(item.id, item.finishedAt, read!.usage, at)) stored.push(item.id);
    } catch (error) {
      cos.bb.log.debug(`counting usage of ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      cos.store.touchUsageChecked(item.id, at);
    }
  }
  if (stored.length) cos.invalidate();
  return stored;
}

/** Whether any of the threads is running a turn. Throws when their states cannot be listed; a thread missing from the list (deleted) is not busy. */
async function anyBusy(cos: Cos, threadIds: string[]): Promise<boolean> {
  const list = await cos.bb.sdk.threads.list({ threadIds, includeHidden: true, limit: threadIds.length });
  return list.some((t) => isBusy(t.runtime?.displayStatus ?? t.status));
}
