// Agent roster: merge stored work items with live thread state, detect
// stalls, reconcile after a restart.
import type { Cos } from "./context";
import { rosterStatus } from "./machine";
import type { WorkItem } from "./state";
import { readThreadUsage, type ThreadUsage } from "./threads";
import { dispatch } from "./delivery";
import { spawnForItem } from "./intake";
import { syncItem } from "./sync";

export interface RosterEntry {
  id: string;
  status: ReturnType<typeof rosterStatus>;
  detail: WorkItem["status"];
  repo: string;
  issueNumber: number | null;
  issueTitle: string;
  threadId: string | null;
  threadStatus: string | null;
  threadTitle: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  startedAt: string;
  lastActivityAt: string | null;
  stalled: boolean;
  fixAttempts: number;
  retryCount: number;
  lastError: string | null;
  waitingReason: string | null;
  providerId: string | null;
  model: string | null;
  source: string;
  usage: ThreadUsage | null;
}

export async function buildRoster(cos: Cos, opts: { repo?: string; includeDone?: boolean; withUsage?: boolean } = {}): Promise<RosterEntry[]> {
  const { values } = await cos.config();
  const items = cos.store.listWorkItems({ repo: opts.repo, activeOnly: !opts.includeDone, limit: 200 });
  const threadIds = items.map((i) => i.threadId).filter((id): id is string => Boolean(id));
  const threads = new Map<string, { status: string; title: string | null; updatedAt: string | number }>();
  if (threadIds.length) {
    try {
      const list = await cos.bb.sdk.threads.list({ threadIds: threadIds.slice(0, 200), includeHidden: true, limit: 200 });
      for (const t of list) threads.set(t.id, { status: t.runtime?.displayStatus ?? t.status, title: t.title ?? t.titleFallback ?? null, updatedAt: t.updatedAt });
    } catch (error) {
      cos.bb.log.debug(`threads.list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const stallMs = Math.max(1, values.stallThresholdMinutes) * 60_000;
  const now = cos.now().getTime();
  const entries: RosterEntry[] = [];
  for (const item of items) {
    const thread = item.threadId ? threads.get(item.threadId) : undefined;
    const last = item.lastActivityAt ?? item.createdAt;
    const stalled = ["running", "fixing"].includes(item.status) && now - Date.parse(last) > stallMs;
    entries.push({
      id: item.id,
      status: rosterStatus(item),
      detail: item.status,
      repo: item.repo,
      issueNumber: item.issueNumber,
      issueTitle: item.issueTitle,
      threadId: item.threadId,
      threadStatus: thread?.status ?? null,
      threadTitle: thread?.title ?? null,
      branch: item.branch,
      prNumber: item.prNumber,
      prUrl: item.prUrl,
      startedAt: item.createdAt,
      lastActivityAt: item.lastActivityAt,
      stalled,
      fixAttempts: item.fixAttempts,
      retryCount: item.retryCount,
      lastError: item.lastError,
      waitingReason: item.status === "waiting_on_human" ? item.waitingReason : null,
      providerId: item.providerId,
      model: item.model,
      source: item.source,
      usage: opts.withUsage && item.threadId ? await readThreadUsage(cos, item.threadId) : null,
    });
  }
  return entries;
}

/** Flag running items whose last activity is older than the threshold. */
export async function detectStalls(cos: Cos, actor: string): Promise<string[]> {
  const { values } = await cos.config();
  const stallMs = Math.max(1, values.stallThresholdMinutes) * 60_000;
  const now = cos.now().getTime();
  const stalled: string[] = [];
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (!["running", "fixing"].includes(item.status)) continue;
    const last = Date.parse(item.lastActivityAt ?? item.createdAt);
    if (now - last <= stallMs) continue;
    // Confirm against the live thread: an active thread that is still streaming is not stalled.
    if (item.threadId) {
      try {
        const thread = await cos.bb.sdk.threads.get({ threadId: item.threadId });
        const updated = typeof thread.updatedAt === "number" ? thread.updatedAt : Date.parse(String(thread.updatedAt));
        if (Number.isFinite(updated) && now - updated <= stallMs) {
          cos.store.updateWorkItem(item.id, { lastActivityAt: new Date(updated).toISOString() });
          continue;
        }
      } catch {
        /* fall through: treat as stalled */
      }
    }
    stalled.push(item.id);
    cos.store.log({ level: "warn", kind: "stall", repo: item.repo, workItemId: item.id, message: `no activity for ${Math.round((now - last) / 60_000)} min`, actor });
    await dispatch(cos, item.id, { type: "stalled" }, actor);
  }
  return stalled;
}

/** After a restart: re-sync every active item with its thread and PR. */
export async function reconcile(cos: Cos): Promise<void> {
  const orphaned = cos.store.failOrphanRuns();
  if (orphaned) cos.store.log({ level: "warn", kind: "reconcile", repo: null, workItemId: null, message: `${orphaned} routine run(s) were interrupted by a restart`, actor: "startup" });
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    try {
      if (!item.threadId) {
        if (item.status === "queued") {
          const repo = await cos.repo(item.repo);
          if (!repo) continue;
          const github = await cos.github();
          await spawnForItem(cos, github, repo, item.id, null, "startup");
        }
        continue;
      }
      await syncItem(cos, item, "startup", { rerunChecks: true });
    } catch (error) {
      cos.bb.log.warn(`reconcile ${item.id} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
    }
  }
  cos.invalidate();
}
