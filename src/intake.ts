// Intake: turn GitHub issues (or a task typed by the operator) into work
// items and start them on the workflow. The first step prompt spawns the
// agent thread (see delivery.ts), so starting is just a "start" event.
import { randomUUID } from "node:crypto";
import type { Cos } from "./context";
import { BRANCH_PREFIX, issueBranchName, repoKey, slugify, type RepoConfig } from "./config";
import type { GitHubClient, GitHubIssue } from "./github";
import { dispatch, resumeQueued } from "./delivery";
import type { NewWorkItem, WorkItem } from "./state";
import { initialNodes } from "./machine";
import { isStatusComment } from "./statusComment";

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
  // No filter would mean "every open issue": never do that implicitly.
  if (!filter.labels.length && !filter.assignee) return [];
  return github.listOpenIssues(repo.owner, repo.repo, { labels: filter.labels, assignee: filter.assignee });
}

/**
 * What the agent is asked to do and the repo's conventions. Sent once, when a
 * thread is spawned; step prompts that follow refer back to it.
 */
export async function taskBrief(cos: Cos, repo: RepoConfig, item: WorkItem): Promise<string> {
  let github: GitHubClient | null;
  try {
    github = await cos.github();
  } catch {
    github = null;
  }
  const lines: string[] = [];
  const issue = item.issueNumber && github ? await github.getIssue(repo.owner, repo.repo, item.issueNumber).catch(() => null) : null;
  if (issue && github) {
    // Chief of Staff's own status comment tells the agent nothing it does not already know.
    const comments = (await github.listIssueComments(repo.owner, repo.repo, issue.number).catch(() => [])).filter((c) => !isStatusComment(c.body));
    lines.push(`You are working on GitHub issue #${issue.number} in ${repo.owner}/${repo.repo}: ${issue.title}`, issue.html_url, ``, (issue.body ?? "(no description)").slice(0, MAX_BODY));
    if (comments.length) {
      lines.push(``, `## Issue comments`);
      for (const comment of comments.slice(-10)) lines.push(`- **${comment.user?.login ?? "unknown"}** (${comment.created_at}): ${comment.body.slice(0, MAX_COMMENT)}`);
    }
  } else if (item.issueNumber) {
    lines.push(`You are working on GitHub issue #${item.issueNumber} in ${repo.owner}/${repo.repo}: ${item.issueTitle}`, `(The issue could not be loaded; read it with \`gh issue view ${item.issueNumber}\`.)`);
  } else {
    lines.push(`You are working on a task in ${repo.owner}/${repo.repo}: ${item.issueTitle}`, ``, (item.taskBody ?? "(no description)").slice(0, MAX_BODY));
  }
  lines.push(``, `Your workspace is an isolated git worktree. Chief of Staff (a BB plugin) takes this task through the workflow “${item.workflow.name}” one step at a time and tells you which step you are on.`);
  if (github) {
    const conventions: string[] = [];
    for (const file of ["AGENTS.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md"]) {
      const content = await github.getFileContent(repo.owner, repo.repo, file).catch(() => null);
      if (content) conventions.push(`### ${file}\n${content.slice(0, MAX_CONVENTIONS)}`);
      if (conventions.length >= 2) break;
    }
    if (conventions.length) lines.push(``, `## Repository conventions`, ...conventions);
  }
  return lines.join("\n");
}

/** Why an operator action was refused: everything is paused, or just this project. */
export function pausedMessage(cos: Cos, repo: string, action: string): string {
  return cos.store.isRepoPaused(repo) && !cos.store.isPaused() ? `Project ${repo} is paused. Resume it before ${action}.` : `Chief of Staff is paused. Resume it before ${action}.`;
}

export async function runIntake(cos: Cos, opts: { repo?: string; dryRun?: boolean; actor: string }): Promise<IntakeResult[]> {
  if (cos.store.isPaused()) throw new Error("Chief of Staff is paused. Resume it before starting intake.");
  const config = await cos.config();
  if (!opts.dryRun) await resumeQueued(cos, opts.actor);
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
    if (cos.store.isRepoPaused(key)) {
      result.error = "this project is paused";
      continue;
    }
    if (!repo.intake) {
      result.error = "intake is paused for this repo";
      continue;
    }
    try {
      const issues = await eligibleIssues(github, repo);
      result.considered = issues.length;
      for (const issue of issues) {
        if (cos.store.isPaused(key)) break;
        if (cos.store.findActiveForIssue(key, issue.number)) {
          result.skipped.push({ issue: issue.number, reason: "active thread exists" });
          continue;
        }
        const pr = await github.findOpenPullForIssue(repo.owner, repo.repo, issue.number, BRANCH_PREFIX);
        if (pr) {
          result.skipped.push({ issue: issue.number, reason: `open PR #${pr.number}` });
          continue;
        }
        const capacity = capacityProblem(cos, repo, config.values.maxConcurrentTotal);
        if (capacity) {
          result.skipped.push({ issue: issue.number, reason: capacity });
          continue;
        }
        if (opts.dryRun) {
          result.started.push({ issue: issue.number, threadId: "(dry-run)" });
          continue;
        }
        const item = await startIssue(cos, repo, issue, opts.actor);
        result.started.push({ issue: issue.number, threadId: item?.threadId ?? "?" });
      }
    } catch (error) {
      result.error = await cos.safe(error instanceof Error ? error.message : String(error));
      cos.store.log({ level: "error", kind: "intake", repo: key, workItemId: null, message: `intake failed: ${result.error}`, actor: opts.actor });
    }
  }
  if (results.some((r) => r.started.length)) cos.invalidate();
  return results;
}

function capacityProblem(cos: Cos, repo: RepoConfig, maxTotal: number): string | null {
  if (cos.store.countOccupied(repoKey(repo)) >= repo.maxConcurrent) return `repo at max concurrency (${repo.maxConcurrent})`;
  if (cos.store.countOccupied() >= maxTotal) return `global max concurrency (${maxTotal})`;
  return null;
}

/** A queued item that runs the repo's workflow as it is right now (later edits do not change it). */
async function newItem(cos: Cos, repo: RepoConfig, fields: { issueNumber: number | null; issueTitle: string; branch: string; source: string; taskBody?: string | null }): Promise<NewWorkItem> {
  const workflow = await cos.workflow(repoKey(repo));
  return {
    id: randomUUID(),
    repo: repoKey(repo),
    threadId: null,
    environmentId: null,
    prNumber: null,
    prUrl: null,
    status: "queued",
    providerId: null,
    model: null,
    lastError: null,
    lastActivityAt: null,
    finishedAt: null,
    workflow,
    nodes: initialNodes(workflow),
    ...fields,
  };
}

export async function startIssue(cos: Cos, repo: RepoConfig, issue: GitHubIssue, actor: string): Promise<WorkItem | null> {
  const item = cos.store.insertWorkItem(await newItem(cos, repo, { issueNumber: issue.number, issueTitle: issue.title, branch: issueBranchName(issue.number, issue.title), source: "intake" }));
  cos.store.log({ level: "info", kind: "intake", repo: item.repo, workItemId: item.id, message: `picked up issue #${issue.number}: ${issue.title}`, actor });
  return dispatch(cos, item.id, { type: "start" }, actor);
}

/** Start a task the operator described, without a GitHub issue. */
export async function startTask(cos: Cos, input: { repo: string; title?: string; body: string; force?: boolean }, actor: string): Promise<WorkItem | null> {
  if (cos.store.isPaused(input.repo)) throw new Error(pausedMessage(cos, input.repo, "starting a task"));
  const repo = await cos.repo(input.repo);
  if (!repo) throw new Error(`repo ${input.repo} is not configured`);
  const body = input.body.trim();
  const title = input.title?.trim() || body.replace(/\s+/g, " ").slice(0, 200);
  if (!title) throw new Error("the task needs a prompt");
  await resumeQueued(cos, actor);
  if (!input.force) {
    const capacity = capacityProblem(cos, repo, (await cos.config()).values.maxConcurrentTotal);
    if (capacity) throw new Error(`${capacity}; try again later`);
  }
  const item = cos.store.insertWorkItem(await newItem(cos, repo, { issueNumber: null, issueTitle: title, branch: `${BRANCH_PREFIX}task-${slugify(title)}`, source: actor.startsWith("tool") ? "tool" : "task", taskBody: body || title }));
  cos.store.log({ level: "info", kind: "intake", repo: item.repo, workItemId: item.id, message: `started task: ${title}`, actor });
  cos.invalidate();
  return dispatch(cos, item.id, { type: "start" }, actor, input.force);
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
