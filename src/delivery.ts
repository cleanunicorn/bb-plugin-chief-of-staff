import { randomUUID } from "node:crypto";
// The runtime around the pure workflow engine: apply events under a per-item
// lock, run effects (agent prompts, check commands, ship, merge), and watch CI.
// Long effects run as detached jobs so event handlers and the sweep never
// block on a 30-minute test run; a job's result is dropped if the item moved on.
import type { Cos } from "./context";
import type { RepoConfig } from "./config";
import { GitHubError, GitHubRateLimitError, prStateFrom, reduceReviews, unlessRateLimited } from "./github";
import { ENGINE_ERROR_PREFIX, MARKED_DONE, MARKED_FAILED, deriveStatus, transition, type Effect, type MachineEvent, type Nodes } from "./machine";
import { nudgePrompt, splitTitle, stepPrompt, stepThreadBrief } from "./prompts";
import { occupiesCapacity, type WorkItem } from "./state";
import { recordEnvironmentBranch, taskBrief } from "./intake";
import { lastAssistantText, listSkills, publicThreadUrl, sendToThread, spawnStepThread, spawnWorktreeThread } from "./threads";
import { postStatusComment } from "./statusComment";
import { referencedSkills, skillMentions } from "./skills";
import { agentWork, isAuthoredAgent, settingsFor, stepById, topoOrder, type AgentWork, type CheckStep, type ShipStep } from "./workflow";
import { itemParent, archiveOrder } from "./threadGroups";

const OUTPUT_TAIL = 12_000;

// ---- per-item serialization ----

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier holder of this item's lock. Not re-entrant: never call dispatch() from inside. */
export function withItemLock<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(itemId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const settled = run.catch(() => undefined);
  locks.set(itemId, settled);
  void settled.then(() => {
    if (locks.get(itemId) === settled) locks.delete(itemId);
  });
  return run;
}

// ---- detached jobs ----

const jobs = new Map<string, { promise: Promise<void>; generation: number }>();
let generation = 0;

/**
 * A new plugin instance starts a new generation: jobs started by a previous
 * instance (a reload in the same process) no longer count as running, so the
 * sweep restarts them. Their late results are dropped by the job token check.
 */
export function newJobGeneration(): void {
  generation += 1;
}

export function jobRunning(itemId: string): boolean {
  return jobs.get(itemId)?.generation === generation;
}

/** Wait until no job is running (jobs may start follow-up jobs). For tests and shutdown. */
export async function settleJobs(): Promise<void> {
  for (let guard = 0; guard < 100; guard++) {
    const running = [...jobs.values()].filter((j) => j.generation === generation).map((j) => j.promise);
    if (!running.length && !locks.size) return;
    await Promise.allSettled([...running, ...locks.values()]);
  }
}

// ---- dispatch ----

/** Apply an engine event to a stored item and run the resulting effects. */
export function dispatch(cos: Cos, itemId: string, event: MachineEvent, actor: string, force = false): Promise<WorkItem | null> {
  return withItemLock(itemId, () => dispatchLocked(cos, itemId, event, actor, force));
}

/** dispatch() for callers that already hold the item's lock. */
export async function dispatchLocked(cos: Cos, itemId: string, event: MachineEvent, actor: string, force = false, deferredId?: number): Promise<WorkItem | null> {
  const item = cos.store.getWorkItem(itemId);
  if (item && !item.workflow.steps.length && event.type === "close") return closeWithoutWorkflow(cos, item, event.outcome, actor);
  if (!item || !item.workflow.steps.length) {
    if (deferredId !== undefined) cos.store.deleteDeferredEvent(deferredId);
    return null;
  }
  // Closing by hand is the operator's call: a pause does not hold it.
  const held = () => event.type !== "close" && cos.store.isPaused(item.repo);
  if (held()) {
    if (deferredId === undefined) cos.store.deferEvent(itemId, event, actor);
    return item;
  }
  if (item.queuedEvent) {
    if (event.type === "start" || event.type === "retry" || event.type === "approve") event = item.queuedEvent;
    else if (!["rerun", "revise", "pr_closed", "pr_merged", "close"].includes(event.type)) {
      if (deferredId !== undefined) cos.store.deleteDeferredEvent(deferredId);
      return item;
    }
  }
  const { policy, repos, values } = await cos.config();
  if (held()) {
    if (deferredId === undefined) cos.store.deferEvent(itemId, event, actor);
    return item;
  }
  let t: ReturnType<typeof transition>;
  try {
    t = transition(item, event, policy, cos.now());
  } catch (error) {
    await recordEngineError(cos, item, event, error, actor);
    throw error;
  }
  // The engine handled the kind of event it failed on: that error is history.
  // (Only the same kind: another event succeeding says nothing about it, and
  // clearing it would re-notify on the next failed attempt.)
  const recovered = item.lastError?.startsWith(`${ENGINE_ERROR_PREFIX}${event.type}:`) && !("lastError" in t.patch) ? { lastError: null } : {};
  const patch = { ...applyTransition(item, t.nodes, t.patch), ...recovered, queuedEvent: null };
  const proposed = { ...item, ...patch };
  // No await between counting and storing the reservation: dispatches for other
  // items observe it before running their own admission check.
  if (!force && occupiesCapacity(proposed) && (!occupiesCapacity(item) || event.type === "start")) {
    const repo = repos.find((r) => `${r.owner}/${r.repo}` === item.repo);
    const full = !repo || cos.store.countOccupied(item.repo, item.id) >= repo.maxConcurrent || cos.store.countOccupied(undefined, item.id) >= values.maxConcurrentTotal;
    if (full) {
      const queued = cos.store.updateWorkItem(item.id, {
        queuedEvent: event, status: "queued", jobStartedAt: null,
        waitingKind: null, waitingReason: "Waiting for task capacity",
        ...(event.type === "pr_opened" ? { prNumber: event.prNumber, prUrl: event.prUrl } : {}),
      });
      if (deferredId !== undefined) cos.store.deleteDeferredEvent(deferredId);
      cos.invalidate();
      return queued;
    }
  }
  const updated = cos.store.transaction(() => {
    const stored = cos.store.updateWorkItem(item.id, patch);
    if (stored) cos.store.appendJournal(item.id, t.journal, actor);
    return stored;
  });
  if (!updated) return null;
  if (deferredId !== undefined) cos.store.deleteDeferredEvent(deferredId);
  logChanges(cos, item, updated, event, actor);
  for (const effect of t.effects) {
    if (effect.type === "check" || effect.type === "ship" || effect.type === "merge") {
      startJob(cos, item.id, effect, actor);
      continue;
    }
    const beforeDelivery = effect.type === "agent" ? cos.store.getWorkItem(item.id)?.nodes[effect.step]?.deliveries?.[effect.agent]?.id : undefined;
    try {
      await runEffect(cos, item.id, effect, actor);
    } catch (error) {
      const message = await cos.safe(error instanceof Error ? error.message : String(error));
      const delivery = effect.type === "agent" ? cos.store.getWorkItem(item.id)?.nodes[effect.step]?.deliveries?.[effect.agent] : undefined;
      if (delivery?.id !== beforeDelivery && delivery?.state === "accepted") {
        cos.bb.log.warn(`post-delivery bookkeeping failed for ${item.id}/${effect.type === "agent" ? effect.step : ""}: ${message}`);
        continue;
      }
      const retryAt = rateLimitReset(error);
      if (retryAt) logRateLimited(cos, item.repo, item.id, effect.type, retryAt, actor);
      else cos.store.log({ level: "error", kind: "effect", repo: item.repo, workItemId: item.id, message: `${effect.type} failed: ${message}${await stackOf(cos, error)}`, actor });
      if (effect.type !== "notify") await dispatchLocked(cos, item.id, { type: "effect_error", step: effect.step, effect, message, uncertain: delivery?.id !== beforeDelivery && (delivery?.state === "sending" || delivery?.state === "uncertain"), ...(retryAt ? { retryAt } : {}) }, actor);
    }
  }
  if (item.status !== "done" && updated.status === "done") await archiveItemThreads(cos, updated, actor);
  return cos.store.getWorkItem(item.id);
}

/** A task with no workflow steps has nothing for the engine to settle: write the outcome. */
async function closeWithoutWorkflow(cos: Cos, item: WorkItem, outcome: "done" | "failed", actor: string): Promise<WorkItem | null> {
  if (item.status === outcome) return item;
  const updated = cos.store.updateWorkItem(item.id, {
    status: outcome, lastError: outcome === "done" ? MARKED_DONE : MARKED_FAILED, finishedAt: cos.now().toISOString(),
    jobStartedAt: null, queuedEvent: null, waitingKind: null, waitingReason: null,
  });
  if (!updated) return null;
  logChanges(cos, item, updated, { type: "close", outcome }, actor);
  if (outcome === "done") await archiveItemThreads(cos, updated, actor);
  return cos.store.getWorkItem(item.id);
}

/**
 * The engine threw on an event (a bug, or state it does not expect). Nothing
 * was applied; the caller keeps its input (a report, an idle) for the next
 * sweep. Say so on the item, in the activity log and with a notification,
 * once per distinct error, instead of leaving the task looking like a quiet agent.
 */
async function recordEngineError(cos: Cos, item: WorkItem, event: MachineEvent, error: unknown, actor: string): Promise<void> {
  const message = await cos.safe(error instanceof Error ? error.message : String(error));
  const lastError = `${ENGINE_ERROR_PREFIX}${event.type}: ${message}`.slice(0, 1000);
  if (item.lastError === lastError) return;
  cos.store.updateWorkItem(item.id, { lastError });
  cos.store.log({ level: "error", kind: "engine", repo: item.repo, workItemId: item.id, message: lastError + (await stackOf(cos, error)), actor });
  cos.invalidate();
  const label = item.issueNumber ? `${item.repo}#${item.issueNumber}` : item.repo;
  await cos.notify(`Chief of Staff needs help: ${label}`, `${lastError}\nIt retries every minute; the agent's report is kept.`, item.threadId ?? undefined).catch(() => undefined);
}

/** When a GitHub rate limit refused the effect: the reset to run it again at. */
function rateLimitReset(error: unknown): string | undefined {
  return error instanceof GitHubRateLimitError ? error.resetAt.toISOString() : undefined;
}

function logRateLimited(cos: Cos, repo: string | null, itemId: string, what: string, retryAt: string, actor: string): void {
  cos.store.log({ level: "warn", kind: "effect", repo, workItemId: itemId, message: `${what} is waiting for the GitHub rate limit to reset at ${retryAt}`, actor });
}

/** An error's stack trace for the activity log (on its own lines, redacted), or "". */
async function stackOf(cos: Cos, error: unknown): Promise<string> {
  return error instanceof Error && error.stack ? `\n${(await cos.safe(error.stack)).slice(0, 4000)}` : "";
}

/** Replay events received during a pause in their original order. */
let replaying: Promise<void> | null = null;
export function replayDeferred(cos: Cos): Promise<void> {
  if (replaying) return replaying;
  replaying = (async () => {
    while (!cos.store.isPaused()) {
      const entry = cos.store.nextDeferredEvent();
      if (!entry) return;
      if (!cos.store.getWorkItem(entry.item_id)) { cos.store.deleteDeferredEvent(entry.id); continue; }
      await withItemLock(entry.item_id, () => dispatchLocked(cos, entry.item_id, JSON.parse(entry.event_json) as MachineEvent, entry.actor, false, entry.id));
    }
  })().finally(() => { replaying = null; });
  return replaying;
}

/** Resume older deferred transitions before admitting fresh intake. */
export async function resumeQueued(cos: Cos, actor: string): Promise<void> {
  const items = cos.store.listWorkItems({ activeOnly: true, limit: Number.MAX_SAFE_INTEGER })
    .filter((i) => i.queuedEvent && !cos.store.isPaused(i.repo))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const item of items) await dispatch(cos, item.id, { type: "start" }, actor);

}

/**
 * The workflow is over: archive every thread the item started (builder and
 * step agents), when the operator has not turned that off. The item is
 * already done, so the thread.archived events this fires are ignored. One
 * thread failing to archive (already archived, deleted) does not stop the rest.
 */
async function archiveItemThreads(cos: Cos, item: WorkItem, actor: string): Promise<void> {
  const { values } = await cos.config();
  if (!values.archiveThreadsOnDone) return;
  const ids = await archiveOrder(cos, item);
  const archived: string[] = [];
  for (const threadId of ids) {
    try {
      await cos.bb.sdk.threads.archive({ threadId });
      archived.push(threadId);
    } catch (error) {
      const message = await cos.safe(error instanceof Error ? error.message : String(error));
      cos.store.log({ level: "warn", kind: "effect", repo: item.repo, workItemId: item.id, message: `could not archive thread ${threadId}: ${message}`, actor });
    }
  }
  if (archived.length) cos.store.log({ level: "info", kind: "effect", repo: item.repo, workItemId: item.id, message: `archived ${archived.length} thread${archived.length === 1 ? "" : "s"}: ${archived.join(", ")}`, actor });
}

/** The stored patch for a transition: step states plus the status derived from them. */
export function applyTransition(item: WorkItem, nodes: Nodes, patch: Partial<WorkItem>): Partial<WorkItem> {
  // Closed stays closed (failed, or done by the workflow or by hand) unless the patch reopens it (retry, revive, rerun).
  const explicit = "status" in patch ? patch.status : item.status;
  const derived = deriveStatus({ status: explicit === "failed" ? "failed" : "queued", workflow: item.workflow }, nodes);
  const status = explicit === "failed" || explicit === "done" ? explicit : derived.status;
  const fixAttempts = Object.values(nodes).reduce((sum, n) => sum + n.attempts, 0);
  const finished = status === "done" || status === "failed";
  return {
    ...patch,
    nodes,
    status,
    fixAttempts,
    waitingKind: derived.waitingKind,
    waitingReason: derived.waitingReason,
    finishedAt: finished ? (patch.finishedAt ?? item.finishedAt ?? new Date().toISOString()) : null,
  };
}

function logChanges(cos: Cos, before: WorkItem, after: WorkItem, event: MachineEvent, actor: string): void {
  const changes: string[] = [];
  for (const id of topoOrder(after.workflow)) {
    const a = before.nodes[id]?.status ?? "pending";
    const b = after.nodes[id]?.status ?? "pending";
    const roundChanged = (before.nodes[id]?.round ?? 0) !== (after.nodes[id]?.round ?? 0);
    if (a !== b || roundChanged) changes.push(`${stepById(after.workflow, id)?.name ?? id}: ${a} → ${b}${roundChanged && a === b ? " (again)" : ""}`);
  }
  if (before.status !== after.status) changes.unshift(`${before.status} → ${after.status}`);
  if (!changes.length) return;
  cos.store.log({
    level: after.status === "failed" ? "error" : after.status === "retrying" ? "warn" : "info",
    kind: "transition",
    repo: after.repo,
    workItemId: after.id,
    message: `${changes.join("; ")} (${event.type})`,
    actor,
  });
  cos.invalidate();
}

// ---- effects ----

async function runEffect(cos: Cos, itemId: string, effect: Effect, actor: string): Promise<void> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) return;
  if (effect.type === "notify") {
    await cos.notify(effect.title, effect.body, item.threadId ?? undefined);
    return;
  }
  if (effect.type !== "agent") return;
  const repo = await cos.repo(item.repo);
  if (!repo) throw new Error(`repo ${item.repo} is no longer configured`);
  const step = agentWork(stepById(item.workflow, effect.step));
  if (!step) throw new Error(`step ${effect.step} is not an agent step`);
  await promptAgent(cos, item, repo, step, effect, actor);
}

async function defaultBranch(cos: Cos, repo: RepoConfig): Promise<string | undefined> {
  try {
    return (await (await cos.github()).getRepo(repo.owner, repo.repo)).default_branch;
  } catch {
    return undefined;
  }
}

async function promptAgent(cos: Cos, item: WorkItem, repo: RepoConfig, step: AgentWork, effect: Extract<Effect, { type: "agent" }>, actor: string): Promise<void> {
  const round = item.nodes[step.id]?.round ?? 0;
  const deliveryId = randomUUID();
  const body = effect.kind === "nudge" ? nudgePrompt(step, deliveryId) : stepPrompt(item, step, effect.agent, { delivery: deliveryId, defaultBranch: !step.writes && item.environmentId ? await defaultBranch(cos, repo) : undefined });
  // `/skill` references in the instructions become skill mentions (only skills the workspace has).
  const usesSkills = effect.kind !== "nudge" && referencedSkills(step.instructions).length > 0;
  const skills = usesSkills ? await listSkills(cos, repo.projectId, item.environmentId) : [];
  const mentionsIn = (text: string) => (usesSkills ? skillMentions(text, step.instructions, skills) : []);
  // Idles predating this attempt belong to an older turn. Only acceptance
  // updates the thread row; an attempted send alone does not prove delivery.
  const sentAt = cos.now().getTime();
  // Model steps before this one choose the provider, model and reasoning of threads spawned for it.
  const settings = settingsFor(item.workflow, step.id, item.nodes);
  cos.store.updateWorkItem(item.id, { lastActivityAt: cos.now().toISOString() });

  const stepThread = step.writes ? null : cos.store.stepThread(item.id, step.id, effect.agent);
  const reusable = stepThread && (stepThread.environmentId === item.environmentId || !item.environmentId);
  const existing = effect.fresh ? null : step.writes ? item.threadId : reusable ? stepThread.threadId : null;
  const saveDelivery = (state: "sending" | "accepted", threadId: string | null) => {
    const fresh = cos.store.getWorkItem(item.id)!;
    const node = fresh.nodes[step.id];
    node.deliveries = { ...node.deliveries, [effect.agent]: { id: deliveryId, round, threadId, state, sentAt } };
    cos.store.updateWorkItem(item.id, { nodes: fresh.nodes });
  };
  const delivery = {
    sending: () => saveDelivery("sending", existing),
    accepted: (thread?: { id: string; environmentId?: string | null; providerId?: string | null }) => {
      const threadId = thread?.id ?? existing!;
      // Acceptance and the thread binding are one durable fact. A failed write
      // leaves the attempt uncertain, so its matching report can repair it.
      cos.store.transaction(() => {
        saveDelivery("accepted", threadId);
        if (step.writes && thread) cos.store.updateWorkItem(item.id, { threadId, environmentId: thread.environmentId ?? null, providerId: thread.providerId ?? null });
        cos.store.upsertThread({ threadId, itemId: item.id, role: step.writes ? "builder" : "step", stepId: step.id, agent: effect.agent, environmentId: thread?.environmentId ?? item.environmentId, round, promptSentAt: sentAt });
      });
    },
  };
  if (existing) {
    await sendToThread(cos, existing, body, mentionsIn(body), delivery);
    cos.store.log({ level: "info", kind: "prompt", repo: item.repo, workItemId: item.id, message: `sent ${effect.kind === "nudge" ? "a nudge" : step.name} to ${existing}`, actor });
    return;
  }
  const brief = await taskBrief(cos, repo, item);
  const prompt = `${step.writes ? brief : stepThreadBrief(item, step, brief)}\n\n---\n\n${body}`;
  const metadata = { workItemId: item.id, repo: item.repo, issueNumber: item.issueNumber, step: step.id, agent: effect.agent, delivery: deliveryId, round };
  const parentThreadId = await itemParent(cos, item);
  const spawned = step.writes ? await spawnWorktreeThread(cos, {
    repo, parentThreadId, title: item.branch ?? item.issueTitle, prompt, mentions: mentionsIn(prompt), settings, delivery,
    pluginMetadata: { ...metadata, branch: item.branch, role: "builder" },
  }) : await spawnStepThread(cos, {
    repo, environmentId: item.environmentId, parentThreadId,
    title: `${step.name}${step.agents > 1 ? ` ${effect.agent + 1}` : ""}: ${item.branch ?? item.issueTitle}`,
    prompt, mentions: mentionsIn(prompt), settings, delivery, pluginMetadata: metadata,
    // Choosing a model only reads: no worktree for it before the builder's exists.
    inCheckout: Boolean(step.picksModel),
  });
  if (step.writes) cos.store.updateWorkItem(item.id, { providerId: spawned.providerId, model: spawned.model });
  cos.store.log({ level: "info", kind: "spawn", repo: item.repo, workItemId: item.id, message: `spawned ${step.name} ${spawned.thread.id}`, actor });
  // Every builder spawn, so a restart edits the one status comment instead of adding another.
  if (step.writes) await postStatusComment(cos, repo, item, spawned.thread.id);
  if (step.writes) void recordEnvironmentBranch(cos, item.id, spawned.thread.id);
  cos.invalidate();
}

// ---- jobs: check, ship, merge ----

function startJob(cos: Cos, itemId: string, effect: Extract<Effect, { type: "check" | "ship" | "merge" }>, actor: string): void {
  if (jobRunning(itemId)) {
    cos.bb.log.debug(`job for ${itemId} already running; ${effect.type} skipped`);
    return;
  }
  const token = cos.store.getWorkItem(itemId)?.jobStartedAt ?? null;
  /** Deliver a job result only if the item is still waiting on this very job. */
  const report = (event: MachineEvent) =>
    withItemLock(itemId, async () => {
      const current = cos.store.getWorkItem(itemId);
      if (!current || current.jobStartedAt !== token) {
        cos.bb.log.debug(`stale ${effect.type} result for ${itemId} dropped`);
        return;
      }
      await dispatchLocked(cos, itemId, event, actor);
    });
  // A job collects its result and delivers it after unregistering, so the
  // follow-up job it triggers (check → ship) is not mistaken for a duplicate.
  let result: MachineEvent | null = null;
  const collect = async (event: MachineEvent) => {
    result = event;
  };
  const holder: { promise?: Promise<void> } = {};
  const promise: Promise<void> = (async () => {
    try {
      await runJob(cos, itemId, effect, collect, actor);
    } catch (error) {
      const message = await cos.safe(error instanceof Error ? error.message : String(error));
      const item = cos.store.getWorkItem(itemId);
      const retryAt = rateLimitReset(error);
      if (retryAt) logRateLimited(cos, item?.repo ?? null, itemId, effect.type, retryAt, actor);
      else cos.store.log({ level: "error", kind: "effect", repo: item?.repo ?? null, workItemId: itemId, message: `${effect.type} failed: ${message}`, actor });
      result = { type: "effect_error", step: effect.step, effect, message, ...(retryAt ? { retryAt } : {}) };
    }
    if (jobs.get(itemId)?.promise === holder.promise) jobs.delete(itemId);
    if (result) await report(result);
  })().catch((error) => {
    // The plugin instance may be gone (reload, update) by the time a long job
    // ends; its store is closed and the new instance restarts the job.
    if (jobs.get(itemId)?.promise === holder.promise) jobs.delete(itemId);
    try {
      cos.bb.log.debug(`job ${effect.type} for ${itemId} ended after its result could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      /* logger gone too */
    }
  });
  holder.promise = promise;
  jobs.set(itemId, { promise, generation });
}

async function runJob(cos: Cos, itemId: string, effect: Extract<Effect, { type: "check" | "ship" | "merge" }>, report: (event: MachineEvent) => Promise<void>, actor: string): Promise<void> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) return;
  const repo = await cos.repo(item.repo);
  if (!repo) throw new Error(`repo ${item.repo} is no longer configured`);
  const step = stepById(item.workflow, effect.step);
  if (!step) throw new Error(`step ${effect.step} is gone from the workflow`);
  if (effect.type === "check" && step.type === "check") return runCheck(cos, item, step, report, actor);
  if (effect.type === "ship" && step.type === "ship") return ship(cos, item, repo, step, report, actor);
  if (effect.type === "merge" && step.type === "ship") return merge(cos, item, repo, step, report, actor);
  throw new Error(`step ${step.name} cannot run ${effect.type}`);
}

async function workspaceFor(cos: Cos, item: WorkItem): Promise<{ hostId: string; path: string; branch: string }> {
  if (!item.environmentId) throw new Error("no workspace yet: a step that writes code must run first");
  const env = await cos.bb.sdk.environments.get({ environmentId: item.environmentId });
  if (env.status === "destroyed" || env.status === "error") throw new Error(`environment is ${env.status}`);
  const branch = env.branchName ?? item.branch;
  if (!branch) throw new Error("environment has no branch");
  if (item.branch !== branch) cos.store.updateWorkItem(item.id, { branch });
  if (!env.hostId || !env.path) throw new Error("environment has no host checkout path");
  return { hostId: env.hostId, path: env.path, branch };
}

async function git(cos: Cos, ws: { hostId: string; path: string }, args: string[], timeoutMs = 120_000) {
  return cos.hostExec(ws.hostId, { command: "git", args, cwd: ws.path, timeoutMs });
}

/** Commit any uncommitted agent work so the branch reflects what was tested. */
async function commitLeftovers(cos: Cos, ws: { hostId: string; path: string }, item: WorkItem): Promise<void> {
  const status = await git(cos, ws, ["status", "--porcelain"]);
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
  if (!status.stdout.trim()) return;
  await git(cos, ws, ["add", "-A"]);
  const commit = await git(cos, ws, ["-c", "user.name=Chief of Staff", "-c", "user.email=chief-of-staff@bb.local", "commit", "-m", `chore: checkpoint agent work for ${item.issueNumber ? `#${item.issueNumber}` : item.id.slice(0, 8)}`]);
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
}

async function runCheck(cos: Cos, item: WorkItem, step: CheckStep, report: (event: MachineEvent) => Promise<void>, actor: string): Promise<void> {
  const command = step.command.trim();
  const ws = await workspaceFor(cos, item);
  await commitLeftovers(cos, ws, item);
  const result = await cos.hostExec(ws.hostId, { command, shell: true, cwd: ws.path, timeoutMs: step.timeoutMinutes * 60_000 });
  // Redacted: check output is stored, shown in the dashboard and sent to agents as feedback.
  const output = (await cos.safe(`$ ${command}\n${result.stdout}\n${result.stderr}`)).slice(-OUTPUT_TAIL);
  if (result.exitCode !== 0) {
    cos.store.log({ level: "warn", kind: "check", repo: item.repo, workItemId: item.id, message: result.timedOut ? `${step.name} timed out after ${step.timeoutMinutes} min` : `${step.name} failed (exit ${result.exitCode ?? "signal"})`, actor });
    await report({ type: "check_result", step: step.id, ok: false, output: result.timedOut ? `${output}\n(timed out after ${step.timeoutMinutes} min)` : output });
    return;
  }
  cos.store.log({ level: "info", kind: "check", repo: item.repo, workItemId: item.id, message: `${step.name} passed in ${Math.round(result.durationMs / 1000)}s`, actor });
  await report({ type: "check_result", step: step.id, ok: true, output });
}

async function pushBranch(cos: Cos, ws: { hostId: string; path: string; branch: string }, item: WorkItem, actor: string): Promise<void> {
  const push = await git(cos, ws, ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${ws.branch}`], 5 * 60_000);
  if (push.exitCode !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout).trim().slice(-2000)}`);
  cos.store.log({ level: "info", kind: "push", repo: item.repo, workItemId: item.id, message: `pushed ${ws.branch}`, actor });
}

async function ship(cos: Cos, item: WorkItem, repo: RepoConfig, step: ShipStep, report: (event: MachineEvent) => Promise<void>, actor: string): Promise<void> {
  const ws = await workspaceFor(cos, item);
  await commitLeftovers(cos, ws, item);
  if (step.action === "push") {
    await pushBranch(cos, ws, item, actor);
    await report({ type: "pushed", step: step.id });
    return;
  }
  const github = await cos.github();
  const info = await github.getRepo(repo.owner, repo.repo);
  const ahead = await git(cos, ws, ["rev-list", "--count", `origin/${info.default_branch}..HEAD`]);
  if (ahead.exitCode === 0 && ahead.stdout.trim() === "0") {
    await report({ type: "ship_refused", step: step.id, reason: `The branch has no commits ahead of ${info.default_branch}; there is nothing to ship.` });
    return;
  }
  await pushBranch(cos, ws, item, actor);
  const existing = await github.findPullByHead(repo.owner, repo.repo, ws.branch);
  if (existing && existing.state === "open") {
    // Back from a fix: forget the CI failure we already reacted to, so the same
    // head failing again (a fix with no new commit) counts against the limit.
    await cos.bb.storage.kv.delete(CI_MARKER(item.id));
    cos.store.setPrState(item.id, prStateFrom(existing, cos.now()));
    await report({ type: "pr_opened", step: step.id, prNumber: existing.number, prUrl: existing.html_url });
    return;
  }
  const fresh = cos.store.getWorkItem(item.id) ?? item;
  const lead = leadReport(fresh, step.id);
  const written = lead ? splitTitle(lead) : null;
  const title = written?.title ?? (fresh.issueNumber ? `${fresh.issueTitle} (#${fresh.issueNumber})` : fresh.issueTitle || ws.branch);
  const body = await buildPrBody(cos, fresh, written?.title ? written.body : null);
  const pr = await github.createPull(repo.owner, repo.repo, { title: title.slice(0, 250), body, head: ws.branch, base: info.default_branch, ...(step.draft ? { draft: true } : {}) });
  cos.store.log({ level: "info", kind: "pr", repo: item.repo, workItemId: item.id, message: `opened PR #${pr.number} ${pr.html_url}`, actor });
  // Recorded before the report: the state names its PR, and the roster shows it only once prNumber matches.
  cos.store.setPrState(item.id, prStateFrom(pr, cos.now()));
  if (repo.reviewers.length) {
    await github.requestReviewers(repo.owner, repo.repo, pr.number, repo.reviewers, []).catch((error) => cos.bb.log.warn(`request reviewers failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (fresh.issueNumber && repo.issueComments !== false) {
    await github.createIssueComment(repo.owner, repo.repo, fresh.issueNumber, `🤖 Chief of Staff opened pull request #${pr.number}: ${pr.html_url}`).catch(() => undefined);
  }
  await report({ type: "pr_opened", step: step.id, prNumber: pr.number, prUrl: pr.html_url });
}

/** The report of the step right before `shipId`, when one agent wrote it (a "Title: …" line makes it the PR text). */
export function leadReport(item: WorkItem, shipId: string): string | null {
  for (const s of item.workflow.steps) {
    // An authored step only: a model-choosing agent's rationale is not PR text.
    if (!s.next.includes(shipId) || !isAuthoredAgent(s)) continue;
    const r = item.nodes[s.id]?.reports.find(Boolean);
    if (r && /^\s*Title:/im.test(r.summary)) return r.summary;
  }
  return null;
}

async function merge(cos: Cos, item: WorkItem, repo: RepoConfig, step: ShipStep, report: (event: MachineEvent) => Promise<void>, actor: string): Promise<void> {
  if (!item.prNumber) throw new Error("no pull request to merge");
  const github = await cos.github();
  const pr = await github.getPull(repo.owner, repo.repo, item.prNumber);
  if (pr.merged) {
    cos.store.setPrState(item.id, prStateFrom(pr, cos.now()));
    await report({ type: "pr_merged" });
    return;
  }
  // The same verdict the PR state shows: a pending review does not withdraw an approval.
  if (step.requireApproval) {
    if (reduceReviews(await github.listReviews(repo.owner, repo.repo, item.prNumber)) !== "approved") {
      await report({ type: "merge_waiting", reason: "Waiting for an approving review before merging." });
      return;
    }
  }
  try {
    const result = await github.mergePull(repo.owner, repo.repo, item.prNumber, repo.mergeStrategy, pr.head.sha);
    if (!result.merged) {
      await report({ type: "merge_waiting", reason: `GitHub did not merge: ${result.message}` });
      return;
    }
  } catch (error) {
    // 405 not mergeable / 409 head moved: not an outage, try again on the next CI pass.
    if (error instanceof GitHubError && (error.status === 405 || error.status === 409)) {
      await report({ type: "merge_waiting", reason: `Not mergeable yet: ${error.message}` });
      return;
    }
    throw error;
  }
  cos.store.log({ level: "info", kind: "merge", repo: item.repo, workItemId: item.id, message: `merged PR #${item.prNumber} (${repo.mergeStrategy})`, actor });
  // `pr` was read before the merge and still says open.
  cos.store.setPrState(item.id, prStateFrom({ ...pr, merged: true }, cos.now()));
  await report({ type: "pr_merged" });
}

export async function buildPrBody(cos: Cos, item: WorkItem, written: string | null): Promise<string> {
  const wf = item.workflow;
  const sections: string[] = [];
  for (const id of topoOrder(wf)) {
    const s = stepById(wf, id);
    const n = item.nodes[id];
    if (!s || !n || s.type === "ship") continue;
    if (s.type === "check") {
      if (n.output) sections.push(`### ${s.name}\n\`${s.command}\`\n\n\`\`\`\n${n.output.slice(-3000)}\n\`\`\``);
      continue;
    }
    const reports = n.reports.filter(Boolean);
    if (!reports.length) continue;
    const body = reports.map((r, i) => (reports.length > 1 ? `**Agent ${i + 1}:** ${r!.summary}` : r!.summary)).join("\n\n");
    sections.push(`### ${s.name}${agentWork(s)?.approval ? " (approved)" : ""}\n${body.slice(0, 6000)}`);
  }
  const threadLink = item.threadId ? publicThreadUrl(cos, item.threadId) : null;
  const fallback = !sections.length && item.threadId ? await lastAssistantText(cos, item.threadId) : null;
  const lines = [
    written ?? `## Summary\n${item.issueTitle}`,
    ``,
    item.issueNumber ? `Closes #${item.issueNumber}` : ``,
    ``,
    `## Workflow: ${wf.name}`,
    ...(sections.length ? sections : [fallback ? fallback.slice(0, 4000) : "(no step reports)"]),
    ``,
    `## Delivery`,
    `- Agent: ${item.providerId ?? "default"}${item.model ? ` / ${item.model}` : ""}${threadLink ? ` ([thread](${threadLink}))` : ""}`,
    `- Fix cycles: ${item.fixAttempts}`,
    ``,
    `🤖 Shipped by the BB Chief of Staff plugin`,
  ];
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

// ---- CI watching ----

const CI_MARKER = (itemId: string) => `ci-failed:${itemId}`;

/** The ship step an item has open on a PR, if any. */
function openShip(item: WorkItem): ShipStep | null {
  for (const s of item.workflow.steps) {
    const phase = item.nodes[s.id]?.phase;
    if (s.type === "ship" && item.nodes[s.id]?.status === "running" && (phase === "ci" || phase === "ready")) return s;
  }
  return null;
}

/** Keep tracking a delivery during CI repairs, but stop after its ship step finishes. */
function trackingPull(item: WorkItem): boolean {
  return item.workflow.steps.some((s) => {
    const n = item.nodes[s.id];
    return s.type === "ship" && n && n.status !== "done" &&
      (["ci", "ready", "merging"].includes(n.phase ?? "") || (n.status === "pending" && n.attempts > 0));
  });
}

/**
 * Poll every open PR we own. Called from the sweep, which passes its GitHub
 * time budget as `deadline` (epoch ms): no further PR is polled after it.
 */
export async function watchCi(cos: Cos, actor: string, opts: { deadline?: number } = {}): Promise<void> {
  const items = cos.store.listWorkItems({ activeOnly: true, limit: Number.MAX_SAFE_INTEGER }).filter((i) => i.prNumber && trackingPull(i) && !cos.store.isPaused(i.repo));
  if (!items.length) return;
  const github = await cos.github();
  if (!github.hasToken) return;
  // Resume the previous pass, including after a reload, so a slow first PR
  // cannot consume every poll's budget and permanently hide older PRs.
  const cursorKey = "ci:nextItemId";
  const nextId = await cos.bb.storage.kv.get<string>(cursorKey);
  const start = Math.max(0, items.findIndex((item) => item.id === nextId));
  for (let offset = 0; offset < items.length; offset++) {
    const index = (start + offset) % items.length;
    const item = items[index]!;
    if (opts.deadline !== undefined && cos.now().getTime() >= opts.deadline) {
      cos.bb.log.info("CI watch stopped at the sweep's GitHub time budget; the rest waits for the next CI poll");
      return;
    }
    try {
      const repo = await cos.repo(item.repo);
      if (!repo) continue;
      const pr = await github.getPull(repo.owner, repo.repo, item.prNumber!);
      // Open PRs' state is left to refreshPrStates, which also reads checks and reviews.
      if (pr.merged || pr.state === "closed") cos.store.setPrState(item.id, prStateFrom(pr, cos.now()));
      if (pr.merged) {
        await dispatch(cos, item.id, { type: "pr_merged" }, actor);
        continue;
      }
      if (pr.state === "closed") {
        await dispatch(cos, item.id, { type: "pr_closed" }, actor);
        continue;
      }
      if (item.queuedEvent) continue;
      const ship = openShip(item);
      if (!ship) continue;
      // Upgrade unfinished PR-only deliveries after confirming the PR exists.
      if (ship.action === "pr") {
        await dispatch(cos, item.id, { type: "pr_opened", step: ship.id, prNumber: pr.number, prUrl: pr.html_url }, actor);
        continue;
      }
      const ci = await github.ciSummary(repo.owner, repo.repo, pr.head.sha);
      if (ci.state === "failing") {
        // React once per head sha.
        if ((await cos.bb.storage.kv.get<string>(CI_MARKER(item.id))) === pr.head.sha) continue;
        let log = ci.failed.map((f) => `- ${f.name}: ${f.url}`).join("\n");
        const runId = ci.failed.find((f) => f.runId)?.runId;
        // A rate limit is not a failed download: react on a later pass, with the logs.
        if (runId) log += `\n\n${await github.getJobLogsForRun(repo.owner, repo.repo, runId).catch(unlessRateLimited(() => "(log download failed)"))}`;
        await cos.bb.storage.kv.set(CI_MARKER(item.id), pr.head.sha);
        await dispatch(cos, item.id, { type: "ci_failing", log: await cos.safe(log) }, actor);
      } else if (ci.state === "passing" || ci.state === "no_checks") {
        if (item.nodes[ship.id]?.phase === "ci" || ship.action === "merge") await dispatch(cos, item.id, { type: "ci_passing" }, actor);
      }
    } catch (error) {
      // Every later request would be refused too; the sweep resumes after the reset.
      if (error instanceof GitHubRateLimitError) {
        cos.bb.log.info(`CI watch paused: ${await cos.safe(error.message)}`);
        return;
      }
      cos.bb.log.warn(`CI watch for ${item.repo}#${item.prNumber} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
    } finally {
      // Failed requests also use the budget. Give the next task its turn;
      // this one is retried when polling comes around again.
      await cos.bb.storage.kv.set(cursorKey, items[(index + 1) % items.length]!.id);
    }
  }
}
