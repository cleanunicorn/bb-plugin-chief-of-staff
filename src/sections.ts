// Native BB sections group an issue across agent roles and worktrees.
import type { Cos } from "./context";
import type { WorkItem } from "./state";

const pending = new WeakMap<Cos, Map<string, Promise<string | undefined>>>();

/** Persist identity independently of the editable section name. Grouping must not block work. */
export async function issueSection(cos: Cos, item: WorkItem): Promise<string | undefined> {
  const identity = item.issueNumber == null ? `task:${item.id}` : `issue:${item.repo.toLowerCase()}#${item.issueNumber}`;
  const key = `thread-section:${identity}`;
  let requests = pending.get(cos);
  if (!requests) pending.set(cos, requests = new Map());
  const existing = requests.get(key);
  if (existing) return existing;
  const request = (async () => {
    try {
      const saved = await cos.bb.storage.kv.get<string>(key);
      if (saved && (await cos.bb.sdk.threadSections.list()).some((s) => s.id === saved)) return saved;
      const label = item.issueNumber == null ? item.repo : `${item.repo}#${item.issueNumber}`;
      const section = await cos.bb.sdk.threadSections.create({ name: `${label} · ${item.issueTitle}`.slice(0, 200) });
      await cos.bb.storage.kv.set(key, section.id);
      return section.id;
    } catch (error) {
      cos.bb.log.warn(`thread grouping ${item.id} failed: ${await cos.safe(String(error))}`);
      return undefined;
    }
  })();
  requests.set(key, request);
  try {
    return await request;
  } finally {
    requests.delete(key);
  }
}

/** Backfill active tasks, leaving archived threads and manual section choices alone. */
export async function groupExistingThreads(cos: Cos): Promise<void> {
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    const ids = new Set(cos.store.listThreads(item.id).map((t) => t.threadId));
    if (item.threadId) ids.add(item.threadId);
    let sectionId: string | undefined;
    for (const threadId of ids) {
      try {
        const thread = await cos.bb.sdk.threads.get({ threadId });
        if (thread.sectionId || thread.archivedAt || thread.deletedAt) continue;
        sectionId ??= await issueSection(cos, item);
        if (!sectionId) break;
        await cos.bb.sdk.threads.update({ threadId, sectionId });
      } catch (error) {
        cos.bb.log.warn(`thread grouping ${threadId} failed: ${await cos.safe(String(error))}`);
      }
    }
  }
}
