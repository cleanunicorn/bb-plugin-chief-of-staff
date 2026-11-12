// Retention: remove the step details of tasks finished more than
// FINISHED_DETAIL_DAYS ago (see StateStore.compactFinished). Runs at startup
// and then at most once a day from the sweep.
import type { Cos } from "./context";
import { FINISHED_DETAIL_DAYS } from "./state";
import { threadGroupKey, threadParentKey } from "./threadGroups";

export const KV_LAST_RETENTION = "sweep:lastRetentionAt";
const DAY_MS = 86_400_000;

/** Compact every eligible item, batch by batch, and return how many were compacted. */
export async function runRetention(cos: Cos, actor: string, batch?: number): Promise<number> {
  const now = cos.now();
  const kv = cos.bb.storage.kv;
  await kv.set(KV_LAST_RETENTION, now.toISOString());
  const olderThan = new Date(now.getTime() - FINISHED_DETAIL_DAYS * DAY_MS).toISOString();
  let total = 0;
  while (!cos.store.isPaused()) {
    const ids = cos.store.compactFinished(olderThan, batch);
    if (!ids.length) break;
    total += ids.length;
    // Thread grouping state is recomputed by itemParent if the item comes back.
    for (const id of ids) {
      await kv.delete(threadParentKey(id));
      await kv.delete(threadGroupKey(id));
    }
  }
  if (total) cos.store.log({ level: "info", kind: "retention", repo: null, workItemId: null, message: `removed step details of ${total} tasks finished more than ${FINISHED_DETAIL_DAYS} days ago`, actor });
  return total;
}

/** runRetention, when not paused and a day has passed since the last run. Returns whether it ran. */
export async function maybeRunRetention(cos: Cos, actor: string): Promise<boolean> {
  if (cos.store.isPaused()) return false;
  const last = await cos.bb.storage.kv.get<string>(KV_LAST_RETENTION);
  if (last && cos.now().getTime() - Date.parse(last) < DAY_MS) return false;
  await runRetention(cos, actor);
  return true;
}
