// The runtime around the pure workflow engine: apply events under a per-item
// lock, run effects (agent prompts, check commands, ship, merge), and watch CI.
// Long effects run as detached jobs so event handlers and the sweep never
// block on a 30-minute test run; a job's result is dropped if the item moved on.
import type { Cos } from "./context";
import type { RepoConfig } from "./config";
import { GitHubError } from "./github";
import { deriveStatus, transition, type Effect, type MachineEvent, type Nodes } from "./machine";
import { nudgePrompt, splitTitle, stepPrompt, stepThreadBrief } from "./prompts";
import { occupiesCapacity, type WorkItem } from "./state";
import { recordEnvironmentBranch, taskBrief } from "./intake";
import { lastAssistantText, listSkills, sendToThread, spawnStepThread, spawnWorktreeThread, threadUrl } from "./threads";
import { referencedSkills, skillMentions } from "./skills";
import { settingsFor, stepById, topoOrder, type AgentStep, type CheckStep, type ShipStep } from "./workflow";

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
  if (!item || !item.workflow.steps.length) {
    if (deferredId !== undefined) cos.store.deleteDeferredEvent(deferredId);
    return null;
  }
  if (cos.store.isPaused()) {
    if (deferredId === undefined) cos.store.deferEvent(itemId, event, actor);
    return item;
  }
  if (item.queuedEvent) {
    if (event.type === "start" || event.type === "retry" || event.type === "approve") event = item.queuedEvent;
    else if (!["rerun", "revise", "pr_closed", "pr_merged"].includes(event.type)) {
      if (deferredId !== undefined) cos.store.deleteDeferredEvent(deferredId);
      return item;
    }
  }
  const { policy, repos, values } = await cos.config();
  if (cos.store.isPaused()) {
    if (deferredId === undefined) cos.store.deferEvent(itemId, event, actor);
    return item;
  }
  const t = transition(item, event, policy, cos.now());
  const patch = { ...applyTransition(item, t.nodes, t.patch), queuedEvent: null };
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
  const updated = cos.store.updateWorkItem(item.id, patch);
  if (!updated) return null;
  if (deferredId !== undefined) cos.store.deleteDeferredEvent(deferredId);
  logChanges(cos, item, updated, event, actor);
  for (const effect of t.effects) {
    if (effect.type === "check" || effect.type === "ship" || effect.type === "merge") {
      startJob(cos, item.id, effect, actor);
      continue;
    }
    try {
      await runEffect(cos, item.id, effect, actor);
    } catch (error) {
      const message = await cos.safe(error instanceof Error ? error.message : String(error));
      cos.store.log({ level: "error", kind: "effect", repo: item.repo, workItemId: item.id, message: `${effect.type} failed: ${message}`, actor });
      if (effect.type !== "notify") await dispatchLocked(cos, item.id, { type: "effect_error", step: effect.step, effect, message }, actor);
    }
  }
  if (item.status !== "done" && updated.status === "done") await archiveItemThreads(cos, updated, actor);
  return cos.store.getWorkItem(item.id);
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
    .filter((i) => i.queuedEvent)
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
  const ids = [...new Set([...cos.store.listThreads(item.id).map((t) => t.threadId), ...(item.threadId ? [item.threadId] : [])])];
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
  const explicit = "status" in patch ? patch.status : item.status;
  const derived = deriveStatus({ status: explicit === "failed" ? "failed" : "queued", workflow: item.workflow }, nodes);
  const status = explicit === "failed" ? "failed" : patch.status === "done" ? "done" : derived.status;
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
  const step = stepById(item.workflow, effect.step);
  if (!step || step.type !== "agent") throw new Error(`step ${effect.step} is not an agent step`);
  await promptAgent(cos, item, repo, step, effect, actor);
}

async function defaultBranch(cos: Cos, repo: RepoConfig): Promise<string | undefined> {
  try {
    return (await (await cos.github()).getRepo(repo.owner, repo.repo)).default_branch;
  } catch {
    return undefined;
  }
}

async function promptAgent(cos: Cos, item: WorkItem, repo: RepoConfig, step: AgentStep, effect: Extract<Effect, { type: "agent" }>, actor: string): Promise<void> {
  const round = item.nodes[step.id]?.round ?? 0;
  const body = effect.kind === "nudge" ? nudgePrompt(step) : stepPrompt(item, step, effect.agent, { defaultBranch: !step.writes && item.environmentId ? await defaultBranch(cos, repo) : undefined });
  // `/skill` references in the instructions become skill mentions (only skills the workspace has).
  const usesSkills = effect.kind !== "nudge" && referencedSkills(step.instructions).length > 0;
  const skills = usesSkills ? await listSkills(cos, repo.projectId, item.environmentId) : [];
  const mentionsIn = (text: string) => (usesSkills ? skillMentions(text, step.instructions, skills) : []);
  // Record the send time first: an idle that predates it belongs to an older turn.
  const sentAt = cos.now().getTime();
  // Model steps before this one choose the provider, model and reasoning of threads spawned for it.
  const settings = settingsFor(item.workflow, step.id, item.nodes);
  cos.store.updateWorkItem(item.id, { lastActivityAt: cos.now().toISOString() });

  if (step.writes) {
    if (!item.threadId || effect.fresh) {
      const brief = await taskBrief(cos, repo, item);
      const prompt = `${brief}\n\n---\n\n${body}`;
      const spawned = await spawnWorktreeThread(cos, {
        repo,
        title: item.branch ?? item.issueTitle,
        prompt,
        mentions: mentionsIn(prompt),
        settings,
        pluginMetadata: { workItemId: item.id, repo: item.repo, issueNumber: item.issueNumber, branch: item.branch, role: "builder" },
      });
      cos.store.updateWorkItem(item.id, { threadId: spawned.thread.id, environmentId: spawned.thread.environmentId ?? null, providerId: spawned.providerId, model: spawned.model });
      cos.store.upsertThread({ threadId: spawned.thread.id, itemId: item.id, role: "builder", stepId: null, agent: 0, environmentId: spawned.thread.environmentId ?? null, round, promptSentAt: sentAt });
      cos.store.log({ level: "info", kind: "spawn", repo: item.repo, workItemId: item.id, message: `spawned builder ${spawned.thread.id} for ${step.name} (${spawned.providerId ?? "default provider"}${spawned.model ? ` / ${spawned.model}` : ""})`, actor });
      if (item.issueNumber && !item.threadId) {
        const github = await cos.github();
        await github
          .createIssueComment(repo.owner, repo.repo, item.issueNumber, `🤖 Chief of Staff started an agent on this issue (workflow: ${item.workflow.name}).\n\nBB thread: ${threadUrl(cos, spawned.thread.id)}`)
          .catch((error) => cos.bb.log.warn(`issue comment failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      void recordEnvironmentBranch(cos, item.id, spawned.thread.id);
      cos.invalidate();
      return;
    }
    if (!cos.store.getThread(item.threadId)) cos.store.upsertThread({ threadId: item.threadId, itemId: item.id, role: "builder", stepId: null, agent: 0, environmentId: item.environmentId, round, promptSentAt: sentAt });
    else cos.store.updateThread(item.threadId, { round, promptSentAt: sentAt });
    await sendToThread(cos, item.threadId, body, mentionsIn(body));
    cos.store.log({ level: "info", kind: "prompt", repo: item.repo, workItemId: item.id, message: `sent ${effect.kind === "nudge" ? "a nudge" : step.name} to the builder`, actor });
    return;
  }

  // Read-only step: its own thread, in the builder's workspace once there is one.
  const existing = cos.store.stepThread(item.id, step.id, effect.agent);
  const reusable = existing && !effect.fresh && (existing.environmentId === item.environmentId || !item.environmentId);
  if (reusable) {
    cos.store.updateThread(existing.threadId, { round, promptSentAt: sentAt });
    await sendToThread(cos, existing.threadId, body, mentionsIn(body));
    cos.store.log({ level: "info", kind: "prompt", repo: item.repo, workItemId: item.id, message: `sent ${effect.kind === "nudge" ? "a nudge" : step.name} to agent ${effect.agent + 1}`, actor });
    return;
  }
  const brief = await taskBrief(cos, repo, item);
  const stepThreadPrompt = `${stepThreadBrief(item, step, brief)}\n\n---\n\n${body}`;
  const spawned = await spawnStepThread(cos, {
    repo,
    environmentId: item.environmentId,
    parentThreadId: item.threadId ?? undefined,
    title: `${step.name}${step.agents > 1 ? ` ${effect.agent + 1}` : ""}: ${item.branch ?? item.issueTitle}`,
    prompt: stepThreadPrompt,
    mentions: mentionsIn(stepThreadPrompt),
    settings,
    pluginMetadata: { workItemId: item.id, repo: item.repo, issueNumber: item.issueNumber, step: step.id, agent: effect.agent },
  });
  cos.store.upsertThread({ threadId: spawned.thread.id, itemId: item.id, role: "step", stepId: step.id, agent: effect.agent, environmentId: spawned.thread.environmentId ?? item.environmentId, round, promptSentAt: sentAt });
  cos.store.log({ level: "info", kind: "spawn", repo: item.repo, workItemId: item.id, message: `spawned ${step.name}${step.agents > 1 ? ` agent ${effect.agent + 1}` : ""} ${spawned.thread.id}`, actor });
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
      cos.store.log({ level: "error", kind: "effect", repo: item?.repo ?? null, workItemId: itemId, message: `${effect.type} failed: ${message}`, actor });
      result = { type: "effect_error", step: effect.step, effect, message };
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
  const output = `$ ${command}\n${result.stdout}\n${result.stderr}`.slice(-OUTPUT_TAIL);
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
  if (repo.reviewers.length) {
    await github.requestReviewers(repo.owner, repo.repo, pr.number, repo.reviewers, []).catch((error) => cos.bb.log.warn(`request reviewers failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (fresh.issueNumber) {
    await github.createIssueComment(repo.owner, repo.repo, fresh.issueNumber, `🤖 Chief of Staff opened pull request #${pr.number}: ${pr.html_url}`).catch(() => undefined);
  }
  await report({ type: "pr_opened", step: step.id, prNumber: pr.number, prUrl: pr.html_url });
}

/** The report of the step right before `shipId`, when one agent wrote it (a "Title: …" line makes it the PR text). */
function leadReport(item: WorkItem, shipId: string): string | null {
  for (const s of item.workflow.steps) {
    if (!s.next.includes(shipId) || s.type !== "agent") continue;
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
    await report({ type: "pr_merged" });
    return;
  }
  if (step.requireApproval) {
    const latest = new Map<string, string>();
    for (const review of await github.listReviews(repo.owner, repo.repo, item.prNumber)) if (review.user && review.state !== "COMMENTED") latest.set(review.user.login, review.state);
    const states = [...latest.values()];
    if (!states.includes("APPROVED") || states.includes("CHANGES_REQUESTED")) {
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
    sections.push(`### ${s.name}${s.type === "agent" && s.approval ? " (approved)" : ""}\n${body.slice(0, 6000)}`);
  }
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
    `- Agent: ${item.providerId ?? "default"}${item.model ? ` / ${item.model}` : ""}${item.threadId ? ` ([thread](${threadUrl(cos, item.threadId)}))` : ""}`,
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

/** Poll every open PR we own. Called from the sweep. */
export async function watchCi(cos: Cos, actor: string): Promise<void> {
  const items = cos.store.listWorkItems({ activeOnly: true, limit: Number.MAX_SAFE_INTEGER }).filter((i) => i.prNumber && trackingPull(i));
  if (!items.length) return;
  const github = await cos.github();
  if (!github.hasToken) return;
  for (const item of items) {
    const repo = await cos.repo(item.repo);
    if (!repo) continue;
    try {
      const pr = await github.getPull(repo.owner, repo.repo, item.prNumber!);
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
        await cos.bb.storage.kv.set(CI_MARKER(item.id), pr.head.sha);
        let log = ci.failed.map((f) => `- ${f.name}: ${f.url}`).join("\n");
        const runId = ci.failed.find((f) => f.runId)?.runId;
        if (runId) log += `\n\n${await github.getJobLogsForRun(repo.owner, repo.repo, runId).catch(() => "(log download failed)")}`;
        await dispatch(cos, item.id, { type: "ci_failing", log }, actor);
      } else if (ci.state === "passing" || ci.state === "no_checks") {
        if (item.nodes[ship.id]?.phase === "ci" || ship.action === "merge") await dispatch(cos, item.id, { type: "ci_passing" }, actor);
      }
    } catch (error) {
      cos.bb.log.warn(`CI watch for ${item.repo}#${item.prNumber} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
    }
  }
}
