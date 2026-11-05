import type { RoutineStep } from "../config";
import { planBatchMerge, type MergeCandidate } from "./batchMergePlan";
import type { StepContext, StepOutcome } from "./index";
import { spawnWorktreeThread } from "../threads";
import { randomUUID } from "node:crypto";

type BatchMergeStep = Extract<RoutineStep, { type: "batch_merge" }>;

export async function collectCandidates(ctx: StepContext): Promise<{ candidates: MergeCandidate[]; defaultBranch: string }> {
  const github = await ctx.cos.github();
  const { owner, repo } = ctx.repo;
  const info = await github.getRepo(owner, repo);
  const pulls = await github.listOpenPulls(owner, repo);
  const candidates: MergeCandidate[] = [];
  for (const pr of pulls) {
    const full = await github.getPull(owner, repo, pr.number);
    const reviews = await github.listReviews(owner, repo, pr.number);
    const latestByUser = new Map<string, string>();
    for (const review of reviews) if (review.user && review.state !== "COMMENTED") latestByUser.set(review.user.login, review.state);
    const states = [...latestByUser.values()];
    const ci = await github.ciSummary(owner, repo, full.head.sha);
    candidates.push({
      number: full.number,
      title: full.title,
      headRef: full.head.ref,
      baseRef: full.base.ref,
      createdAt: full.created_at,
      labels: full.labels.map((l) => l.name),
      draft: full.draft,
      approved: states.includes("APPROVED"),
      changesRequested: states.includes("CHANGES_REQUESTED"),
      ci: ci.state,
      mergeable: full.mergeable,
      mergeableState: full.mergeable_state,
      body: full.body,
      author: full.user?.login ?? null,
    });
  }
  return { candidates, defaultBranch: info.default_branch };
}

export async function runBatchMerge(ctx: StepContext, step: BatchMergeStep): Promise<StepOutcome> {
  const github = await ctx.cos.github();
  const { owner, repo } = ctx.repo;
  const { candidates, defaultBranch } = await collectCandidates(ctx);
  const ownBranches = new Set(ctx.cos.store.listWorkItems({ repo: `${owner}/${repo}`, limit: 500 }).map((i) => i.branch).filter((b): b is string => Boolean(b)));
  const plan = planBatchMerge(candidates, {
    branchPrefix: ctx.repo.branchPrefix,
    onlyOwnBranches: ctx.repo.mergeFilter.onlyOwnBranches,
    labels: step.labels ?? ctx.repo.mergeFilter.labels,
    requireApproval: step.requireApproval ?? ctx.repo.mergeFilter.requireApproval,
    defaultBranch,
    ownBranches,
  });
  const headOf = (n: number) => candidates.find((c) => c.number === n)?.headRef ?? "?";
  const strategy = step.strategy ?? ctx.repo.mergeStrategy;
  const conflictHandling = step.conflictHandling ?? ctx.repo.conflictHandling;
  const merged: number[] = [];
  const skipped: { number: number; reason: string }[] = [];
  const conflicts: { number: number; action: string }[] = [];
  for (const decision of plan.decisions) {
    if (decision.action === "skip") {
      skipped.push({ number: decision.number, reason: decision.reason });
      continue;
    }
    if (decision.action === "conflict") {
      if (conflictHandling === "rebase-via-agent" && !ctx.dryRun) {
        const action = await spawnRebaseAgent(ctx, decision.number, headOf(decision.number), defaultBranch);
        conflicts.push({ number: decision.number, action });
      } else {
        conflicts.push({ number: decision.number, action: ctx.dryRun ? "would " + (conflictHandling === "skip" ? "skip and report" : "spawn rebase agent") : "skipped and reported" });
      }
      continue;
    }
    if (ctx.dryRun) {
      merged.push(decision.number);
      continue;
    }
    try {
      const result = await github.mergePull(owner, repo, decision.number, strategy);
      if (result.merged) {
        merged.push(decision.number);
        ctx.cos.store.log({ level: "info", kind: "merge", repo: `${owner}/${repo}`, workItemId: null, message: `merged PR #${decision.number} (${strategy}) triggered by ${ctx.actor}`, actor: ctx.actor });
      } else skipped.push({ number: decision.number, reason: result.message });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/405|409|not mergeable|conflict/i.test(message)) {
        if (conflictHandling === "rebase-via-agent") conflicts.push({ number: decision.number, action: await spawnRebaseAgent(ctx, decision.number, headOf(decision.number), defaultBranch) });
        else conflicts.push({ number: decision.number, action: "merge rejected (conflict), skipped and reported" });
      } else skipped.push({ number: decision.number, reason: message.slice(0, 300) });
    }
  }
  const summary = `${ctx.dryRun ? "would merge" : "merged"} ${merged.length} PR(s)${merged.length ? ` [#${merged.join(", #")}]` : ""}; skipped ${skipped.length}; conflicts ${conflicts.length}`;
  return { status: ctx.dryRun ? "dry_run" : "succeeded", summary, details: { merged, skipped, conflicts, strategy, order: plan.ordered.map((p) => p.number) } };
}

async function spawnRebaseAgent(ctx: StepContext, prNumber: number, headRef: string, defaultBranch: string): Promise<string> {
  const key = `${ctx.repo.owner}/${ctx.repo.repo}`;
  const existing = ctx.cos.store.listWorkItems({ repo: key, activeOnly: true }).find((i) => i.prNumber === prNumber);
  if (existing) return `rebase agent already active (thread ${existing.threadId})`;
  const item = ctx.cos.store.insertWorkItem({
    id: randomUUID(),
    repo: key,
    issueNumber: null,
    issueTitle: `Rebase PR #${prNumber} (${headRef})`,
    threadId: null,
    environmentId: null,
    branch: headRef,
    prNumber,
    prUrl: `https://github.com/${key}/pull/${prNumber}`,
    status: "queued",
    providerId: null,
    model: null,
    fixAttempts: 0,
    retryCount: 0,
    lastError: null,
    checkOutput: null,
    source: `routine:${ctx.routine.name}`,
    lastActivityAt: null,
    finishedAt: null,
  });
  const spawned = await spawnWorktreeThread(ctx.cos, {
    repo: ctx.repo,
    title: `rebase/pr-${prNumber}`,
    baseBranch: headRef,
    prompt: [
      `Pull request #${prNumber} in ${key} (branch \`${headRef}\`) conflicts with \`${defaultBranch}\`.`,
      `Your worktree starts from \`${headRef}\`. Rebase it onto \`origin/${defaultBranch}\`, resolve every conflict preserving the PR's intent, run the project's tests, then push with:`,
      "```",
      `git push --force-with-lease origin HEAD:${headRef}`,
      "```",
      `Finish with a short summary of the conflicts you resolved.`,
    ].join("\n"),
    pluginMetadata: { workItemId: item.id, repo: key, prNumber, branch: headRef },
  });
  ctx.cos.store.updateWorkItem(item.id, { status: "pr_open", threadId: spawned.thread.id, environmentId: spawned.thread.environmentId ?? null, providerId: spawned.providerId, model: spawned.model, lastActivityAt: ctx.cos.now().toISOString() });
  ctx.cos.store.log({ level: "info", kind: "merge", repo: key, workItemId: item.id, message: `spawned rebase agent ${spawned.thread.id} for PR #${prNumber}`, actor: ctx.actor });
  return `spawned rebase agent (thread ${spawned.thread.id})`;
}
