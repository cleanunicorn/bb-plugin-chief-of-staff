// Agent roster: merge stored work items with live thread state, detect
// stalls, reconcile after a restart.
import type { Cos } from "./context";
import { actorOf, rosterStatus, type Actor } from "./machine";
import type { StageCounters, WaitingKind, WorkItem } from "./state";
import { readThreadUsage, type ThreadUsage } from "./threads";
import { dispatch } from "./delivery";
import { syncThreads, tickItems } from "./sync";
import { activeStages, type Stage, type StageOrDone } from "./workflow";

export interface RosterEntry {
  id: string;
  status: ReturnType<typeof rosterStatus>;
  detail: WorkItem["status"];
  /** Current workflow stage. */
  stage: StageOrDone;
  /** The repo's enabled stages, in order (for the stepper). */
  stages: Stage[];
  /** Who holds the ball: agent, Chief of Staff, you, or an infrastructure retry. */
  actor: Actor;
  /** One line on what is happening right now. */
  activity: string;
  waitingKind: WaitingKind | null;
  reviewThreadId: string | null;
  counters: StageCounters;
  retryAt: string | null;
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
  for (const i of items) if (i.reviewThreadId) threadIds.push(i.reviewThreadId);
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
  const workflows = new Map<string, Stage[]>();
  for (const item of items) {
    const thread = item.threadId ? threads.get(item.threadId) : undefined;
    const last = item.lastActivityAt ?? item.createdAt;
    const stalled = item.status === "agent" && now - Date.parse(last) > stallMs;
    if (!workflows.has(item.repo)) workflows.set(item.repo, activeStages(await cos.workflow(item.repo)));
    const reviewer = item.reviewThreadId ? threads.get(item.reviewThreadId) : undefined;
    entries.push({
      id: item.id,
      status: rosterStatus(item),
      detail: item.status,
      stage: item.stage,
      stages: workflows.get(item.repo) ?? [],
      actor: actorOf(item),
      activity: describeActivity(item, item.stage === "review" && reviewer ? reviewer.status : thread?.status ?? null),
      waitingKind: item.waitingKind,
      reviewThreadId: item.reviewThreadId,
      counters: item.counters,
      retryAt: item.retryAt,
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

const STAGE_VERB: Record<StageOrDone, string> = { plan: "planning", build: "building", verify: "verifying", review: "reviewing", ship: "shipping", done: "done" };

/** One line on what is happening right now, for the roster. */
export function describeActivity(item: WorkItem, threadStatus: string | null): string {
  switch (item.status) {
    case "queued":
      return "Waiting for an agent slot";
    case "agent": {
      const who = item.stage === "review" && item.reviewThreadId ? "Reviewer" : "Agent";
      if (threadStatus && ["provisioning", "waiting-for-host", "pending"].includes(threadStatus)) return `${who} is starting (${threadStatus.replace(/-/g, " ")})`;
      if (threadStatus === "idle") return item.counters.nudges ? `${who} stopped without reporting; nudged ${item.counters.nudges}×` : `${who} finished a turn; reading its report`;
      return `${who} is ${STAGE_VERB[item.stage]}`;
    }
    case "cos":
      return item.stage === "verify" ? "Chief of Staff is running the verify command" : item.stage === "ship" && item.prNumber ? "Chief of Staff is merging the pull request" : "Chief of Staff is pushing and opening the pull request";
    case "ci":
      return `PR #${item.prNumber} open, waiting for CI`;
    case "ready":
      return item.lastError && !item.lastError.startsWith("ci-failed") ? `PR #${item.prNumber} green; ${item.lastError}` : `PR #${item.prNumber} green, ready to merge`;
    case "retrying":
      return `Chief of Staff hit an error, retrying${item.retryAt ? ` at ${item.retryAt.slice(11, 16)} UTC` : ""}: ${item.lastError ?? ""}`.slice(0, 300);
    case "waiting_on_human":
      switch (item.waitingKind) {
        case "plan_approval":
          return "Plan ready for your approval";
        case "cos_error":
          return "Chief of Staff is stuck and needs you";
        case "no_report":
          return "Agent stopped without reporting the stage";
        case "escalation":
          return "Out of fix attempts; needs your decision";
        default:
          return "Agent is asking you something";
      }
    case "blocked":
      return "Agent went quiet past the stall threshold";
    case "done":
      return item.lastError ?? "Shipped";
    case "failed":
      return item.lastError ?? "Failed";
  }
}

/** Flag agent items whose last activity is older than the threshold. */
export async function detectStalls(cos: Cos, actor: string): Promise<string[]> {
  const { values } = await cos.config();
  const stallMs = Math.max(1, values.stallThresholdMinutes) * 60_000;
  const now = cos.now().getTime();
  const stalled: string[] = [];
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (item.status !== "agent") continue;
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

/** After a restart: re-sync every thread, then restart lost jobs and due retries. */
export async function reconcile(cos: Cos): Promise<void> {
  const orphaned = cos.store.failOrphanRuns();
  if (orphaned) cos.store.log({ level: "warn", kind: "reconcile", repo: null, workItemId: null, message: `${orphaned} routine run(s) were interrupted by a restart`, actor: "startup" });
  await syncThreads(cos, "startup");
  await tickItems(cos, "startup");
  // Items parked by our own failure get one fresh attempt after a restart or plugin update.
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (item.status === "waiting_on_human" && item.waitingKind === "cos_error" && item.pendingEffect) await dispatch(cos, item.id, { type: "retry" }, "startup");
  }
  cos.invalidate();
}
