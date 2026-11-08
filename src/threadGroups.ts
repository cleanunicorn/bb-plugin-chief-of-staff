// Use BB's native thread tree in every sidebar organization mode.
import type { Cos } from "./context";
import type { WorkItem } from "./state";
import { withItemLock } from "./delivery";

const parentKey = (item: WorkItem) => `thread-parent:${item.id}`;
export function itemThreadIds(cos: Cos, item: WorkItem): string[] {
  return [...new Set([...cos.store.listThreads(item.id).map((t) => t.threadId), ...(item.threadId ? [item.threadId] : [])])];
}

async function readThread(cos: Cos, threadId: string) {
  try {
    return await cos.bb.sdk.threads.get({ threadId });
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return null;
    throw error;
  }
}

/** Called under the item lock. The first live root stays the parent across builder replacements. */
export async function itemParent(cos: Cos, item: WorkItem): Promise<string | undefined> {
  try {
    const ids = itemThreadIds(cos, item);
    const saved = await cos.bb.storage.kv.get<string>(parentKey(item));
    const candidates = saved && ids.includes(saved) ? [saved, ...ids.filter((id) => id !== saved)] : ids;
    for (const id of candidates) {
      const thread = await readThread(cos, id);
      if (!thread || thread.archivedAt || thread.deletedAt) continue;
      // Do not take over a thread the user attached outside this workflow.
      if (thread.parentThreadId && !ids.includes(thread.parentThreadId)) continue;
      if (thread.parentThreadId) {
        const parent = await readThread(cos, thread.parentThreadId);
        if (parent && !parent.archivedAt && !parent.deletedAt) continue;
        await cos.bb.sdk.threads.update({ threadId: id, parentThreadId: null, parentNotifications: "off" });
      }
      if (saved !== id) await cos.bb.storage.kv.set(parentKey(item), id);
      return id;
    }
  } catch (error) {
    cos.bb.log.warn(`thread grouping ${item.id} failed: ${await cos.safe(String(error))}`);
  }
  return undefined;
}

/** Backfill active workflows; BB can send assignment notices when existing threads move. */
export async function groupExistingThreads(cos: Cos): Promise<void> {
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (cos.store.isPaused()) return;
    if (cos.store.isPaused(item.repo)) continue;
    await withItemLock(item.id, async () => {
      const fresh = cos.store.getWorkItem(item.id);
      if (!fresh || fresh.status === "done" || fresh.status === "failed" || cos.store.isPaused(fresh.repo)) return;
      const ids = itemThreadIds(cos, fresh);
      const parentThreadId = await itemParent(cos, fresh);
      if (!parentThreadId) return;
      for (const threadId of ids) {
        if (threadId === parentThreadId || cos.store.isPaused(fresh.repo)) continue;
        try {
          const thread = await readThread(cos, threadId);
          if (!thread || thread.archivedAt || thread.deletedAt) continue;
          if (thread.parentThreadId && !ids.includes(thread.parentThreadId)) continue;
          if (thread.parentThreadId === parentThreadId && thread.parentNotifications === "off") continue;
          await cos.bb.sdk.threads.update({ threadId, parentThreadId, parentNotifications: "off" });
        } catch (error) {
          cos.bb.log.warn(`thread grouping ${threadId} failed: ${await cos.safe(String(error))}`);
        }
      }
    });
  }
}

/** Archive deepest children first so BB does not detach still-live children. */
export async function archiveOrder(cos: Cos, item: WorkItem): Promise<string[]> {
  const ids = itemThreadIds(cos, item);
  const parents = new Map<string, string | null>();
  for (const id of ids) {
    try { parents.set(id, (await readThread(cos, id))?.parentThreadId ?? null); }
    catch { /* Archiving still attempts every tracked thread if inspection fails. */ }
  }
  const root = await cos.bb.storage.kv.get<string>(parentKey(item));
  const depth = (id: string) => {
    const seen = new Set<string>();
    let parent = parents.get(id);
    while (parent && !seen.has(parent)) { seen.add(parent); parent = parents.get(parent); }
    return seen.size;
  };
  return ids.sort((a, b) => a === root ? 1 : b === root ? -1 : depth(b) - depth(a));
}
