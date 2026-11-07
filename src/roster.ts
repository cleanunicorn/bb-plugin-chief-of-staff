// Agent roster: stored work items with their step states and live thread
// state, stall detection, and reconciliation after a restart (including
// adopting items started before custom workflows).
import type { Cos } from "./context";
import { actorOf, freshNode, initialNodes, rosterStatus, type Actor, type NodeStatus, type ShipPhase } from "./machine";
import type { WaitingKind, WorkItem } from "./state";
import { readThreadUsage, type ThreadUsage } from "./threads";
import { applyTransition, dispatch } from "./delivery";
import { syncThreads, tickItems } from "./sync";
import { depths, descendants, stepById, topoOrder, type StepType, type Workflow } from "./workflow";

export interface RosterStep {
  id: string;
  name: string;
  type: StepType;
  /** Longest-path depth: steps with the same depth can run in parallel. */
  depth: number;
  status: NodeStatus;
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
}

export interface RosterEntry {
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

export function rosterSteps(item: WorkItem): RosterStep[] {
  const depth = depths(item.workflow);
  return topoOrder(item.workflow).map((id) => {
    const s = stepById(item.workflow, id)!;
    const n = item.nodes[id] ?? freshNode();
    return {
      id,
      name: s.name,
      type: s.type,
      depth: depth.get(id) ?? 0,
      status: n.status,
      phase: n.phase,
      agents: s.type === "agent" ? s.agents : 1,
      reported: n.reports.filter(Boolean).length,
      nudged: Math.max(0, ...n.nudges),
      attempts: n.attempts,
      round: n.round,
      waitingKind: n.waiting?.kind ?? null,
      retrying: Boolean(n.retry?.at),
    };
  });
}

export async function buildRoster(cos: Cos, opts: { repo?: string; includeDone?: boolean; withUsage?: boolean } = {}): Promise<RosterEntry[]> {
  const { values } = await cos.config();
  const items = cos.store.listWorkItems({ repo: opts.repo, activeOnly: !opts.includeDone, limit: 200 });
  const threadIds = items.map((i) => i.threadId).filter((id): id is string => Boolean(id));
  const threads = new Map<string, { status: string; title: string | null }>();
  if (threadIds.length) {
    try {
      const list = await cos.bb.sdk.threads.list({ threadIds: threadIds.slice(0, 200), includeHidden: true, limit: 200 });
      for (const t of list) threads.set(t.id, { status: t.runtime?.displayStatus ?? t.status, title: t.title ?? t.titleFallback ?? null });
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
    const steps = rosterSteps(item);
    entries.push({
      id: item.id,
      status: rosterStatus(item),
      detail: item.status,
      workflowName: item.workflow.name,
      steps,
      current: steps.filter((s) => s.status === "running" || s.status === "waiting").map((s) => s.name),
      actor: actorOf(item),
      activity: describeActivity(item, steps),
      waitingKind: item.waitingKind,
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
      stalled: item.status === "agent" && now - Date.parse(last) > stallMs,
      fixAttempts: item.fixAttempts,
      retryCount: item.retryCount,
      lastError: item.lastError,
      waitingReason: item.status === "waiting_on_human" || item.status === "blocked" ? item.waitingReason : null,
      providerId: item.providerId,
      model: item.model,
      source: item.source,
      usage: opts.withUsage && item.threadId ? await readThreadUsage(cos, item.threadId) : null,
    });
  }
  return entries;
}

/** One line on what is happening right now, for the roster. */
export function describeActivity(item: WorkItem, steps: RosterStep[] = rosterSteps(item)): string {
  switch (item.status) {
    case "done":
      return item.lastError ?? "Done";
    case "failed":
      return item.lastError ?? "Failed";
    case "queued":
      return "Waiting to start";
    case "waiting_on_human":
    case "blocked":
      return item.waitingReason ?? "Waiting on you";
    default:
      break;
  }
  const parts = steps
    .filter((s) => s.status === "running")
    .map((s) => {
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
    if (item.status !== "agent") continue;
    const last = Date.parse(item.lastActivityAt ?? item.createdAt);
    if (now - last <= stallMs) continue;
    // Confirm against the live threads: one still streaming means not stalled.
    const ids = [item.threadId, ...cos.store.listThreads(item.id).map((t) => t.threadId)].filter((id): id is string => Boolean(id));
    let fresh = false;
    for (const threadId of new Set(ids)) {
      try {
        const thread = await cos.bb.sdk.threads.get({ threadId });
        const updated = typeof thread.updatedAt === "number" ? thread.updatedAt : Date.parse(String(thread.updatedAt));
        if (Number.isFinite(updated) && now - updated <= stallMs) {
          cos.store.updateWorkItem(item.id, { lastActivityAt: new Date(updated).toISOString() });
          fresh = true;
          break;
        }
      } catch {
        /* treat as quiet */
      }
    }
    if (fresh) continue;
    stalled.push(item.id);
    cos.store.log({ level: "warn", kind: "stall", repo: item.repo, workItemId: item.id, message: `no activity for ${Math.round((now - last) / 60_000)} min`, actor });
    for (const s of item.workflow.steps) {
      if (s.type === "agent" && item.nodes[s.id]?.status === "running") await dispatch(cos, item.id, { type: "stalled", step: s.id, agent: 0 }, actor);
    }
  }
  return stalled;
}

/** Map a pre-workflow stage name onto a step of the item's workflow. */
function stepForStage(wf: Workflow, stage: string): string | undefined {
  if (stepById(wf, stage)) return stage;
  const find = (pred: (s: Workflow["steps"][number]) => boolean) => topoOrder(wf).map((id) => stepById(wf, id)!).find(pred)?.id;
  switch (stage) {
    case "plan":
      return find((s) => s.type === "agent" && !s.writes);
    case "verify":
      return find((s) => s.type === "check");
    case "review":
      return find((s) => s.type === "agent" && s.verdict);
    case "ship":
      return find((s) => s.type === "ship");
    default:
      return find((s) => s.type === "agent" && s.writes);
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
  await syncThreads(cos, "startup");
  await tickItems(cos, "startup");
  // Steps parked by our own failure get one fresh attempt after a restart or plugin update.
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    for (const [stepId, n] of Object.entries(item.nodes)) {
      if (n.status === "waiting" && n.waiting?.kind === "cos_error" && n.retry) await dispatch(cos, item.id, { type: "retry", step: stepId }, "startup");
    }
  }
  cos.invalidate();
}
