// The engine around the pure stage machine: apply events under a per-item
// lock, run effects (stage prompts, verify command, ship, merge), and watch CI.
// Long effects run as detached jobs so event handlers and the sweep never
// block on a 30-minute test run; a job's result is dropped if the item moved on.
import type { Cos } from "./context";
import { repoKey, type RepoConfig } from "./config";
import { GitHubError } from "./github";
import { EFFECT_LABEL, transition, type Effect, type MachineEvent } from "./machine";
import { promptStage, reviewerBrief, splitShipReport, stagePrompt } from "./prompts";
import type { WorkItem } from "./state";
import { recordEnvironmentBranch, taskBrief } from "./intake";
import { lastAssistantText, sendToThread, spawnReviewerThread, spawnWorktreeThread, threadUrl } from "./threads";
import type { Workflow } from "./workflow";

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

/** Apply a machine event to a stored item and run the resulting effects. */
export function dispatch(cos: Cos, itemId: string, event: MachineEvent, actor: string): Promise<WorkItem | null> {
  return withItemLock(itemId, () => dispatchLocked(cos, itemId, event, actor));
}

/** dispatch() for callers that already hold the item's lock. */
export async function dispatchLocked(cos: Cos, itemId: string, event: MachineEvent, actor: string): Promise<WorkItem | null> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) return null;
  const { policy } = await cos.config();
  const workflow = await cos.workflow(item.repo);
  const next = transition(item, event, workflow, policy);
  const patch = resolveSentinels(cos, { ...next.patch });
  // A report belongs to the turn that filed it.
  if (event.type === "turn_ended" && !("pendingReport" in patch)) patch.pendingReport = null;
  // A pending question only means something while the item waits on it.
  if (next.status !== "waiting_on_human" && item.status === "waiting_on_human" && !("waitingKind" in patch)) {
    patch.waitingKind = null;
    patch.waitingReason = null;
  }
  const updated = cos.store.updateWorkItem(item.id, { ...patch, status: next.status, stage: next.stage });
  if (!updated) return null;
  if (next.status !== item.status || next.stage !== item.stage) {
    cos.store.log({
      level: next.status === "failed" ? "error" : next.status === "retrying" ? "warn" : "info",
      kind: "transition",
      repo: item.repo,
      workItemId: item.id,
      message: `${item.stage}/${item.status} → ${next.stage}/${next.status} (${event.type})`,
      actor,
    });
    cos.invalidate();
  }
  for (const effect of next.effects) {
    if (effect.type === "verify_command" || effect.type === "ship" || effect.type === "merge") {
      startJob(cos, item.id, effect, actor);
      continue;
    }
    try {
      await runEffect(cos, item.id, effect, workflow, actor);
    } catch (error) {
      const message = await cos.safe(error instanceof Error ? error.message : String(error));
      cos.store.log({ level: "error", kind: "effect", repo: item.repo, workItemId: item.id, message: `${effect.type} failed: ${message}`, actor });
      if (effect.type !== "notify") await dispatchLocked(cos, item.id, { type: "effect_error", effect, message }, actor);
    }
  }
  return cos.store.getWorkItem(item.id);
}

function resolveSentinels(cos: Cos, patch: Partial<WorkItem>): Partial<WorkItem> {
  const now = cos.now();
  if (patch.finishedAt === "now") patch.finishedAt = now.toISOString();
  if (patch.jobStartedAt === "now") patch.jobStartedAt = now.toISOString();
  if (typeof patch.retryAt === "string" && patch.retryAt.startsWith("+")) patch.retryAt = new Date(now.getTime() + Number(patch.retryAt.slice(1))).toISOString();
  return patch;
}

// ---- effects ----

async function runEffect(cos: Cos, itemId: string, effect: Effect, workflow: Workflow, actor: string): Promise<void> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) return;
  switch (effect.type) {
    case "notify":
      await cos.notify(effect.title, effect.body, item.threadId ?? undefined);
      return;
    case "prompt": {
      const repo = await cos.repo(item.repo);
      if (!repo) throw new Error(`repo ${item.repo} is no longer configured`);
      await sendPrompt(cos, item, repo, workflow, effect, actor);
      return;
    }
    default:
      return;
  }
}

async function defaultBranch(cos: Cos, repo: RepoConfig): Promise<string | undefined> {
  try {
    return (await (await cos.github()).getRepo(repo.owner, repo.repo)).default_branch;
  } catch {
    return undefined;
  }
}

async function sendPrompt(cos: Cos, item: WorkItem, repo: RepoConfig, workflow: Workflow, effect: Extract<Effect, { type: "prompt" }>, actor: string): Promise<void> {
  const reviewing = effect.kind === "review" || effect.kind === "rereview";
  const body = stagePrompt(effect.kind, item, workflow, {
    detail: effect.detail,
    verifyCommand: workflow.verify.command.trim() || undefined,
    defaultBranch: reviewing ? await defaultBranch(cos, repo) : undefined,
  });
  const stage = promptStage(effect.kind, item.stage === "done" ? "build" : item.stage);
  // Record the send time first: an idle that predates it belongs to an older turn.
  const sentAt = cos.now().getTime();
  cos.store.updateWorkItem(item.id, { promptSentAt: sentAt, lastActivityAt: cos.now().toISOString() });

  if (effect.target === "builder") {
    if (!item.threadId || effect.fresh) {
      const brief = await taskBrief(cos, repo, item);
      const spawned = await spawnWorktreeThread(cos, {
        repo,
        title: item.branch ?? item.issueTitle,
        prompt: `${brief}\n\n---\n\n${body}`,
        pluginMetadata: { workItemId: item.id, repo: item.repo, issueNumber: item.issueNumber, branch: item.branch, role: "builder" },
      });
      cos.store.updateWorkItem(item.id, { threadId: spawned.thread.id, environmentId: spawned.thread.environmentId ?? null, providerId: spawned.providerId, model: spawned.model, idleSeenAt: null });
      cos.store.log({ level: "info", kind: "spawn", repo: item.repo, workItemId: item.id, message: `spawned builder ${spawned.thread.id} for ${stage} (${spawned.providerId ?? "default provider"}${spawned.model ? ` / ${spawned.model}` : ""})`, actor });
      if (item.issueNumber && !item.threadId) {
        const github = await cos.github();
        await github
          .createIssueComment(repo.owner, repo.repo, item.issueNumber, `🤖 Chief of Staff started an agent on this issue.\n\nBB thread: ${threadUrl(cos, spawned.thread.id)}\nBranch: \`${item.branch ?? "(assigned by BB)"}\``)
          .catch((error) => cos.bb.log.warn(`issue comment failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      void recordEnvironmentBranch(cos, item.id, spawned.thread.id);
      cos.invalidate();
      return;
    }
    await sendToThread(cos, item.threadId, body);
  } else {
    if (!item.reviewThreadId || effect.fresh) {
      if (!item.environmentId) throw new Error("the builder has no workspace to review yet");
      const brief = await taskBrief(cos, repo, item);
      const spawned = await spawnReviewerThread(cos, {
        repo,
        environmentId: item.environmentId,
        parentThreadId: item.threadId ?? undefined,
        title: `review: ${item.branch ?? item.issueTitle}`,
        prompt: `${reviewerBrief(item, brief)}\n\n---\n\n${body}`,
        pluginMetadata: { workItemId: item.id, repo: item.repo, issueNumber: item.issueNumber, role: "reviewer" },
      });
      cos.store.updateWorkItem(item.id, { reviewThreadId: spawned.thread.id });
      cos.store.log({ level: "info", kind: "spawn", repo: item.repo, workItemId: item.id, message: `spawned reviewer ${spawned.thread.id}`, actor });
      cos.invalidate();
      return;
    }
    await sendToThread(cos, item.reviewThreadId, body);
  }
  cos.store.log({ level: "info", kind: "prompt", repo: item.repo, workItemId: item.id, message: `sent ${effect.kind.replace("_", " ")} prompt to ${effect.target}`, actor });
}

// ---- jobs: verify command, ship, merge ----

function startJob(cos: Cos, itemId: string, effect: Effect, actor: string): void {
  if (jobRunning(itemId)) {
    cos.bb.log.debug(`job for ${itemId} already running; ${effect.type} skipped`);
    return;
  }
  const token = cos.store.getWorkItem(itemId)?.jobStartedAt ?? null;
  /** Deliver a job result only if the item is still waiting on this very job. */
  const report = (event: MachineEvent) =>
    withItemLock(itemId, async () => {
      const current = cos.store.getWorkItem(itemId);
      if (!current || current.jobStartedAt !== token || current.status !== "cos") {
        cos.bb.log.debug(`stale ${effect.type} result for ${itemId} dropped`);
        return;
      }
      await dispatchLocked(cos, itemId, event, actor);
    });
  // A job collects its result and delivers it after unregistering, so the
  // follow-up job it triggers (verify → ship) is not mistaken for a duplicate.
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
      result = { type: "effect_error", effect, message };
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

async function runJob(cos: Cos, itemId: string, effect: Effect, report: (event: MachineEvent) => Promise<void>, actor: string): Promise<void> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) return;
  const repo = await cos.repo(item.repo);
  if (!repo) throw new Error(`repo ${item.repo} is no longer configured`);
  const workflow = await cos.workflow(item.repo);
  switch (effect.type) {
    case "verify_command":
      return runVerifyCommand(cos, item, workflow, report, actor);
    case "ship":
      return ship(cos, item, repo, workflow, report, actor);
    case "merge":
      return merge(cos, item, repo, report, actor);
    default:
      return;
  }
}

async function workspaceFor(cos: Cos, item: WorkItem): Promise<{ hostId: string; path: string; branch: string }> {
  if (!item.environmentId) throw new Error("work item has no environment");
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

async function runVerifyCommand(cos: Cos, item: WorkItem, workflow: Workflow, report: (event: MachineEvent) => Promise<void>, actor: string): Promise<void> {
  const command = workflow.verify.command.trim();
  const ws = await workspaceFor(cos, item);
  await commitLeftovers(cos, ws, item);
  const result = await cos.hostExec(ws.hostId, { command, shell: true, cwd: ws.path, timeoutMs: workflow.verify.timeoutMinutes * 60_000 });
  const output = `$ ${command}\n${result.stdout}\n${result.stderr}`.slice(-OUTPUT_TAIL);
  if (result.exitCode !== 0) {
    cos.store.log({ level: "warn", kind: "verify", repo: item.repo, workItemId: item.id, message: result.timedOut ? `verify command timed out after ${workflow.verify.timeoutMinutes} min` : `verify command failed (exit ${result.exitCode ?? "signal"})`, actor });
    await report({ type: "verify_failed", output: result.timedOut ? `${output}\n(timed out after ${workflow.verify.timeoutMinutes} min)` : output });
    return;
  }
  cos.store.log({ level: "info", kind: "verify", repo: item.repo, workItemId: item.id, message: `verify command passed in ${Math.round(result.durationMs / 1000)}s`, actor });
  await report({ type: "verify_passed", output });
}

async function pushBranch(cos: Cos, ws: { hostId: string; path: string; branch: string }, item: WorkItem, actor: string): Promise<void> {
  const push = await git(cos, ws, ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${ws.branch}`], 5 * 60_000);
  if (push.exitCode !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout).trim().slice(-2000)}`);
  cos.store.log({ level: "info", kind: "push", repo: item.repo, workItemId: item.id, message: `pushed ${ws.branch}`, actor });
}

async function ship(cos: Cos, item: WorkItem, repo: RepoConfig, workflow: Workflow, report: (event: MachineEvent) => Promise<void>, actor: string): Promise<void> {
  const ws = await workspaceFor(cos, item);
  await commitLeftovers(cos, ws, item);
  if (workflow.ship.action === "push") {
    await pushBranch(cos, ws, item, actor);
    await report({ type: "pushed" });
    return;
  }
  if (!repo.allow.openPr) {
    await report({ type: "ship_refused", reason: `Opening pull requests is not allowed for ${repoKey(repo)} (allow.openPr is off). Allow it, or set the ship action to "push".` });
    return;
  }
  const github = await cos.github();
  const info = await github.getRepo(repo.owner, repo.repo);
  const ahead = await git(cos, ws, ["rev-list", "--count", `origin/${info.default_branch}..HEAD`]);
  if (ahead.exitCode === 0 && ahead.stdout.trim() === "0") {
    await report({ type: "ship_refused", reason: `The branch has no commits ahead of ${info.default_branch}; there is nothing to ship.` });
    return;
  }
  await pushBranch(cos, ws, item, actor);
  const existing = await github.findPullByHead(repo.owner, repo.repo, ws.branch);
  if (existing && existing.state === "open") {
    await report({ type: "pr_opened", prNumber: existing.number, prUrl: existing.html_url });
    return;
  }
  const fresh = cos.store.getWorkItem(item.id) ?? item;
  const written = fresh.reports.ship ? splitShipReport(fresh.reports.ship.summary) : null;
  const title = written?.title ?? (fresh.issueNumber ? `${fresh.issueTitle} (#${fresh.issueNumber})` : fresh.issueTitle || ws.branch);
  const body = await buildPrBody(cos, fresh, workflow, written?.body ?? null);
  const pr = await github.createPull(repo.owner, repo.repo, { title: title.slice(0, 250), body, head: ws.branch, base: info.default_branch, ...(workflow.ship.draft ? { draft: true } : {}) });
  cos.store.log({ level: "info", kind: "pr", repo: item.repo, workItemId: item.id, message: `opened PR #${pr.number} ${pr.html_url}`, actor });
  if (repo.reviewers.length || repo.teamReviewers.length) {
    await github.requestReviewers(repo.owner, repo.repo, pr.number, repo.reviewers, repo.teamReviewers).catch((error) => cos.bb.log.warn(`request reviewers failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (repo.labels.length) {
    await github.addLabels(repo.owner, repo.repo, pr.number, repo.labels).catch((error) => cos.bb.log.warn(`add labels failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (fresh.issueNumber) {
    await github.createIssueComment(repo.owner, repo.repo, fresh.issueNumber, `🤖 Chief of Staff opened pull request #${pr.number}: ${pr.html_url}`).catch(() => undefined);
  }
  await report({ type: "pr_opened", prNumber: pr.number, prUrl: pr.html_url });
}

async function merge(cos: Cos, item: WorkItem, repo: RepoConfig, report: (event: MachineEvent) => Promise<void>, actor: string): Promise<void> {
  if (!item.prNumber) throw new Error("no pull request to merge");
  if (!repo.allow.merge) {
    await report({ type: "ship_refused", reason: `Merging is not allowed for ${repoKey(repo)} (allow.merge is off). Allow it, or set the ship action to "pr".` });
    return;
  }
  const github = await cos.github();
  const pr = await github.getPull(repo.owner, repo.repo, item.prNumber);
  if (pr.merged) {
    await report({ type: "pr_merged" });
    return;
  }
  if (repo.mergeFilter.requireApproval) {
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

export async function buildPrBody(cos: Cos, item: WorkItem, workflow: Workflow, written: string | null): Promise<string> {
  const fallback = item.threadId ? await lastAssistantText(cos, item.threadId) : null;
  const summary = written ?? item.reports.build?.summary ?? (fallback ? fallback.slice(0, 4000) : "(the agent left no summary)");
  const lines = [
    written ? summary : `## Summary\n${summary}`,
    ``,
    item.issueNumber ? `Closes #${item.issueNumber}` : ``,
    ``,
    `## Delivery`,
    `- Agent: ${item.providerId ?? "default"}${item.model ? ` / ${item.model}` : ""}${item.threadId ? ` ([thread](${threadUrl(cos, item.threadId)}))` : ""}`,
    item.reports.plan ? `- Plan: approved${workflow.plan.requireApproval ? " by a human" : ""}` : ``,
    item.reports.review ? `- Review: ${workflow.review.mode === "agent" ? "independent reviewer agent" : "self-review"}, ${item.counters.reviewRounds} round(s) of changes` : ``,
    `- Fix cycles: ${item.fixAttempts}`,
  ];
  if (item.reports.verify || workflow.verify.command.trim()) {
    lines.push(``, `## Verification`);
    if (item.reports.verify) lines.push(item.reports.verify.summary);
    if (workflow.verify.command.trim()) lines.push(``, `\`${workflow.verify.command.trim()}\``, ``, "```", (item.checkOutput ?? "").slice(-4000), "```");
  }
  lines.push(``, `🤖 Shipped by the BB Chief of Staff plugin`);
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

// ---- CI watching ----

const CI_MARKER = (itemId: string) => `ci-failed:${itemId}`;

/** Poll every open PR we own. Called from the sweep. */
export async function watchCi(cos: Cos, actor: string): Promise<void> {
  const items = cos.store.listWorkItems({ activeOnly: true }).filter((i) => i.prNumber && i.stage === "ship" && ["ci", "ready", "waiting_on_human"].includes(i.status));
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
      if (item.status !== "ci" && item.status !== "ready") continue;
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
        const workflow = await cos.workflow(item.repo);
        if (item.status === "ci" || workflow.ship.action === "merge") await dispatch(cos, item.id, { type: "ci_passing" }, actor);
      }
    } catch (error) {
      cos.bb.log.warn(`CI watch for ${item.repo}#${item.prNumber} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

export { EFFECT_LABEL };
