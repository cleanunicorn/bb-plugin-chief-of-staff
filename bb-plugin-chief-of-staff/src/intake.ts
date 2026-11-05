// GitHub issue intake: find eligible issues, spawn one agent thread per issue.
import { randomUUID } from "node:crypto";
import type { Cos } from "./context";
import { issueBranchName, repoKey, type RepoConfig } from "./config";
import type { GitHubClient, GitHubIssue } from "./github";
import { spawnWorktreeThread, threadUrl } from "./threads";
import { transition } from "./machine";

export interface IntakeResult {
  repo: string;
  considered: number;
  started: { issue: number; threadId: string }[];
  skipped: { issue: number; reason: string }[];
  error?: string;
}

const MAX_BODY = 12_000;
const MAX_COMMENT = 2_000;
const MAX_CONVENTIONS = 8_000;

export async function eligibleIssues(github: GitHubClient, repo: RepoConfig): Promise<GitHubIssue[]> {
  const filter = repo.issueFilter;
  if (filter.numbers.length) {
    const issues: GitHubIssue[] = [];
    for (const number of filter.numbers) {
      const issue = await github.getIssue(repo.owner, repo.repo, number);
      if (issue.state === "open" && !issue.pull_request) issues.push(issue);
    }
    return issues;
  }
  if (!filter.labels.length && !filter.milestone && !filter.assignee) return [];
  return github.listOpenIssues(repo.owner, repo.repo, { labels: filter.labels, milestone: filter.milestone, assignee: filter.assignee });
}

export async function buildIssuePrompt(github: GitHubClient, repo: RepoConfig, issue: GitHubIssue, branch: string): Promise<string> {
  const comments = await github.listIssueComments(repo.owner, repo.repo, issue.number).catch(() => []);
  const conventions: string[] = [];
  for (const file of ["AGENTS.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md"]) {
    const content = await github.getFileContent(repo.owner, repo.repo, file).catch(() => null);
    if (content) conventions.push(`### ${file}\n${content.slice(0, MAX_CONVENTIONS)}`);
    if (conventions.length >= 2) break;
  }
  const lines = [
    `You are working on GitHub issue #${issue.number} in ${repo.owner}/${repo.repo}: ${issue.title}`,
    ``,
    `Your workspace is an isolated git worktree. Commit your work on the current branch (${branch}); do not push and do not open a pull request. The Chief of Staff plugin runs the repo checks, pushes the branch and opens the PR when you finish.`,
    ``,
    `When you are done, end your final message with two sections:`,
    `## Summary` ,
    `(what changed and why)`,
    `## Test evidence`,
    `(commands you ran and their results)`,
    repo.checkCommand ? `\nThe check command that must pass before a PR is opened: \`${repo.checkCommand}\`` : ``,
    ``,
    `## Issue #${issue.number}: ${issue.title}`,
    issue.html_url,
    ``,
    (issue.body ?? "(no description)").slice(0, MAX_BODY),
  ];
  if (comments.length) {
    lines.push(``, `## Issue comments`);
    for (const comment of comments.slice(-10)) lines.push(`- **${comment.user?.login ?? "unknown"}** (${comment.created_at}): ${comment.body.slice(0, MAX_COMMENT)}`);
  }
  if (conventions.length) lines.push(``, `## Repository conventions`, ...conventions);
  return lines.join("\n");
}

export async function runIntake(cos: Cos, opts: { repo?: string; dryRun?: boolean; actor: string } ): Promise<IntakeResult[]> {
  const config = await cos.config();
  const results: IntakeResult[] = [];
  let github: GitHubClient;
  try {
    github = await cos.github();
  } catch (error) {
    return [{ repo: "*", considered: 0, started: [], skipped: [], error: error instanceof Error ? error.message : String(error) }];
  }
  if (!github.hasToken) return [{ repo: "*", considered: 0, started: [], skipped: [], error: "no GitHub token (set the githubToken setting or log in with gh)" }];
  for (const repo of config.repos) {
    const key = repoKey(repo);
    if (opts.repo && opts.repo !== key) continue;
    const result: IntakeResult = { repo: key, considered: 0, started: [], skipped: [] };
    results.push(result);
    if (!repo.allow.intake) {
      result.error = "intake disabled for this repo (allow.intake=false)";
      continue;
    }
    try {
      const issues = await eligibleIssues(github, repo);
      result.considered = issues.length;
      for (const issue of issues) {
        if (cos.store.findActiveForIssue(key, issue.number)) {
          result.skipped.push({ issue: issue.number, reason: "active thread exists" });
          continue;
        }
        const pr = await github.findOpenPullForIssue(repo.owner, repo.repo, issue.number, repo.branchPrefix);
        if (pr) {
          result.skipped.push({ issue: issue.number, reason: `open PR #${pr.number}` });
          continue;
        }
        if (cos.store.countActive(key) >= repo.maxConcurrent) {
          result.skipped.push({ issue: issue.number, reason: `repo at max concurrency (${repo.maxConcurrent})` });
          continue;
        }
        if (cos.store.countActiveAll() >= config.values.maxConcurrentTotal) {
          result.skipped.push({ issue: issue.number, reason: `global max concurrency (${config.values.maxConcurrentTotal})` });
          continue;
        }
        if (opts.dryRun) {
          result.started.push({ issue: issue.number, threadId: "(dry-run)" });
          continue;
        }
        const started = await startIssue(cos, github, repo, issue, opts.actor);
        result.started.push({ issue: issue.number, threadId: started.threadId ?? "?" });
      }
    } catch (error) {
      result.error = await cos.safe(error instanceof Error ? error.message : String(error));
      cos.store.log({ level: "error", kind: "intake", repo: key, workItemId: null, message: `intake failed: ${result.error}`, actor: opts.actor });
    }
  }
  if (results.some((r) => r.started.length)) cos.invalidate();
  return results;
}

export async function startIssue(cos: Cos, github: GitHubClient, repo: RepoConfig, issue: GitHubIssue, actor: string) {
  const key = repoKey(repo);
  const branch = issueBranchName(repo, issue.number, issue.title);
  const item = cos.store.insertWorkItem({
    id: randomUUID(),
    repo: key,
    issueNumber: issue.number,
    issueTitle: issue.title,
    threadId: null,
    environmentId: null,
    branch,
    prNumber: null,
    prUrl: null,
    status: "queued",
    providerId: null,
    model: null,
    fixAttempts: 0,
    retryCount: 0,
    lastError: null,
    checkOutput: null,
    source: "intake",
    lastActivityAt: null,
    finishedAt: null,
  });
  cos.store.log({ level: "info", kind: "intake", repo: key, workItemId: item.id, message: `picked up issue #${issue.number}: ${issue.title}`, actor });
  return spawnForItem(cos, github, repo, item.id, issue, actor);
}

/** Spawn (or respawn) the agent thread for a queued work item. */
export async function spawnForItem(cos: Cos, github: GitHubClient, repo: RepoConfig, itemId: string, issue: GitHubIssue | null, actor: string) {
  const item = cos.store.getWorkItem(itemId);
  if (!item) throw new Error(`work item ${itemId} not found`);
  const key = repoKey(repo);
  const resolvedIssue = issue ?? (item.issueNumber ? await github.getIssue(repo.owner, repo.repo, item.issueNumber) : null);
  const branch = item.branch ?? (resolvedIssue ? issueBranchName(repo, resolvedIssue.number, resolvedIssue.title) : `${repo.branchPrefix}${item.id.slice(0, 8)}`);
  const prompt = resolvedIssue ? await buildIssuePrompt(github, repo, resolvedIssue, branch) : `Continue the work tracked by Chief of Staff item ${item.id}.`;
  try {
    const spawned = await spawnWorktreeThread(cos, {
      repo,
      title: branch,
      prompt,
      pluginMetadata: { workItemId: item.id, repo: key, issueNumber: item.issueNumber, branch },
    });
    const next = transition(item, { type: "thread_spawned", threadId: spawned.thread.id, environmentId: spawned.thread.environmentId ?? null });
    cos.store.updateWorkItem(item.id, { ...next.patch, status: next.status, providerId: spawned.providerId, model: spawned.model, lastActivityAt: cos.now().toISOString() });
    cos.store.log({ level: "info", kind: "spawn", repo: key, workItemId: item.id, message: `spawned thread ${spawned.thread.id} on ${spawned.hostId} (${spawned.providerId ?? "default provider"}${spawned.model ? ` / ${spawned.model}` : ""})`, actor });
    if (resolvedIssue && item.retryCount === 0) {
      const url = threadUrl(cos, spawned.thread.id);
      await github
        .createIssueComment(repo.owner, repo.repo, resolvedIssue.number, `🤖 Chief of Staff started an agent on this issue.\n\nBB thread: ${url}\nBranch: \`${branch}\``)
        .catch((error) => cos.bb.log.warn(`issue comment failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    void recordEnvironmentBranch(cos, item.id, spawned.thread.id);
    return { threadId: spawned.thread.id };
  } catch (error) {
    const message = await cos.safe(error instanceof Error ? error.message : String(error));
    cos.store.updateWorkItem(item.id, { status: "failed", lastError: `spawn failed: ${message}`, finishedAt: cos.now().toISOString() });
    cos.store.log({ level: "error", kind: "spawn", repo: key, workItemId: item.id, message: `spawn failed: ${message}`, actor });
    await cos.notify(`Could not start agent for ${key}#${item.issueNumber ?? "?"}`, message);
    return { threadId: null };
  }
}

/** BB names the worktree branch itself; record the real name once the environment is ready. */
export async function recordEnvironmentBranch(cos: Cos, itemId: string, threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const thread = await cos.bb.sdk.threads.get({ threadId });
      if (thread.environmentId) {
        const env = await cos.bb.sdk.environments.get({ environmentId: thread.environmentId });
        if (env.branchName) {
          const item = cos.store.getWorkItem(itemId);
          if (item && (item.branch !== env.branchName || item.environmentId !== env.id)) {
            cos.store.updateWorkItem(itemId, { branch: env.branchName, environmentId: env.id });
            cos.invalidate();
          }
          return;
        }
      }
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
