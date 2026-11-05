// PR delivery: run repo checks, push the branch, open the PR, watch CI and
// feed failures back to the agent thread. Driven by machine effects.
import type { Cos } from "./context";
import { repoKey, type RepoConfig } from "./config";
import type { GitHubClient } from "./github";
import { transition, type Effect, type MachineEvent } from "./machine";
import type { WorkItem } from "./state";
import { lastAssistantText, sendToThread, threadUrl } from "./threads";
import { spawnForItem } from "./intake";

const OUTPUT_TAIL = 12_000;

/** Apply a machine event to a stored item and run the resulting effects. */
export async function dispatch(cos: Cos, itemId: string, event: MachineEvent, actor: string): Promise<WorkItem | null> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) return null;
  const { policy } = await cos.config();
  const next = transition(item, event, policy);
  const patch = { ...next.patch } as Partial<WorkItem>;
  if (patch.finishedAt === "now") patch.finishedAt = cos.now().toISOString();
  const updated = cos.store.updateWorkItem(item.id, { ...patch, status: next.status });
  if (!updated) return null;
  if (next.status !== item.status) {
    cos.store.log({ level: next.status === "failed" ? "error" : "info", kind: "transition", repo: item.repo, workItemId: item.id, message: `${item.status} → ${next.status} (${event.type})`, actor });
    cos.invalidate();
  }
  for (const effect of next.effects) {
    try {
      await runEffect(cos, updated.id, effect, actor);
    } catch (error) {
      const message = await cos.safe(error instanceof Error ? error.message : String(error));
      cos.store.log({ level: "error", kind: "effect", repo: item.repo, workItemId: item.id, message: `${effect.type} failed: ${message}`, actor });
      cos.store.updateWorkItem(item.id, { status: "waiting_on_human", lastError: `${effect.type}: ${message}` });
      await cos.notify(`Chief of Staff needs help: ${item.repo}#${item.issueNumber ?? "?"}`, `${effect.type} failed: ${message}`, updated.threadId ?? undefined);
      cos.invalidate();
    }
  }
  return cos.store.getWorkItem(item.id);
}

async function runEffect(cos: Cos, itemId: string, effect: Effect, actor: string): Promise<void> {
  const item = cos.store.getWorkItem(itemId);
  if (!item) return;
  const repo = await cos.repo(item.repo);
  if (!repo) throw new Error(`repo ${item.repo} is no longer configured`);
  switch (effect.type) {
    case "notify":
      await cos.notify(effect.title, effect.body, item.threadId ?? undefined);
      return;
    case "run_checks":
      await runChecks(cos, item, repo, actor);
      return;
    case "open_pr":
      await openPullRequest(cos, item, repo, actor);
      return;
    case "send_fix_prompt":
      if (!item.threadId) throw new Error("no thread to send the fix prompt to");
      await sendToThread(
        cos,
        item.threadId,
        effect.reason === "checks"
          ? `The repository check command failed on your branch. Fix the problem, commit, and finish with the same Summary / Test evidence sections.\n\nCheck command: \`${repo.checkCommand ?? ""}\`\n\nOutput (tail):\n\`\`\`\n${effect.log.slice(-OUTPUT_TAIL)}\n\`\`\``
          : `CI failed on pull request #${item.prNumber}. Fix the failure, commit, and finish with updated Summary / Test evidence sections. Do not push; the Chief of Staff plugin pushes for you.\n\nFailing log (tail):\n\`\`\`\n${effect.log.slice(-OUTPUT_TAIL)}\n\`\`\``,
      );
      cos.store.updateWorkItem(item.id, { lastActivityAt: cos.now().toISOString() });
      cos.store.log({ level: "info", kind: "fix", repo: item.repo, workItemId: item.id, message: `sent ${effect.reason} failure back to thread (attempt ${item.fixAttempts})`, actor });
      return;
    case "respawn": {
      const github = await cos.github();
      await spawnForItem(cos, github, repo, item.id, null, actor);
      return;
    }
    case "watch_ci":
      // The periodic CI sweep picks pr_open items up; nothing to do eagerly.
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
  const commit = await git(cos, ws, ["-c", "user.name=Chief of Staff", "-c", "user.email=chief-of-staff@bb.local", "commit", "-m", `chore: checkpoint agent work for #${item.issueNumber ?? item.id}`]);
  if (commit.exitCode !== 0) throw new Error(`git commit failed: ${commit.stderr.trim()}`);
}

export async function runChecks(cos: Cos, item: WorkItem, repo: RepoConfig, actor: string): Promise<void> {
  const ws = await workspaceFor(cos, item);
  await commitLeftovers(cos, ws, item);
  if (repo.checkCommand) {
    const result = await cos.hostExec(ws.hostId, { command: repo.checkCommand, shell: true, cwd: ws.path, timeoutMs: 28 * 60_000 });
    const output = `$ ${repo.checkCommand}\n${result.stdout}\n${result.stderr}`.slice(-OUTPUT_TAIL);
    if (result.exitCode !== 0) {
      cos.store.log({ level: "warn", kind: "checks", repo: item.repo, workItemId: item.id, message: `check command failed (exit ${result.exitCode ?? "signal"})`, actor });
      await dispatch(cos, item.id, { type: "checks_failed", output: result.timedOut ? `${output}\n(timed out)` : output }, actor);
      return;
    }
    cos.store.updateWorkItem(item.id, { checkOutput: output });
    cos.store.log({ level: "info", kind: "checks", repo: item.repo, workItemId: item.id, message: `check command passed in ${Math.round(result.durationMs / 1000)}s`, actor });
  } else {
    cos.store.updateWorkItem(item.id, { checkOutput: "(no check command configured)" });
  }
  // Push whenever checks pass, so an existing PR receives the fix commits.
  await pushBranch(cos, ws, item);
  await dispatch(cos, item.id, { type: "checks_passed" }, actor);
}

async function pushBranch(cos: Cos, ws: { hostId: string; path: string; branch: string }, item: WorkItem): Promise<void> {
  const push = await git(cos, ws, ["push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${ws.branch}`], 5 * 60_000);
  if (push.exitCode !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout).trim().slice(-2000)}`);
  cos.store.log({ level: "info", kind: "push", repo: item.repo, workItemId: item.id, message: `pushed ${ws.branch}`, actor: "system" });
}

function extractSection(text: string | null, heading: string): string | null {
  if (!text) return null;
  const re = new RegExp(`^#{1,4}\\s*${heading}\\s*$([\\s\\S]*?)(?=^#{1,4}\\s|\\s*$(?![\\s\\S]))`, "im");
  const match = re.exec(text);
  return match ? match[1].trim() : null;
}

export async function buildPrBody(cos: Cos, item: WorkItem, repo: RepoConfig): Promise<string> {
  const text = item.threadId ? await lastAssistantText(cos, item.threadId) : null;
  const summary = extractSection(text, "Summary") ?? (text ? text.slice(0, 4000) : "(the agent left no summary)");
  const evidence = extractSection(text, "Test evidence") ?? "(none reported by the agent)";
  const lines = [
    `## Summary`,
    summary,
    ``,
    item.issueNumber ? `Closes #${item.issueNumber}` : ``,
    ``,
    `## Agent`,
    `- Provider: ${item.providerId ?? "default"}${item.model ? ` / model: ${item.model}` : ""}`,
    item.threadId ? `- BB thread: ${threadUrl(cos, item.threadId)}` : ``,
    `- Fix cycles used: ${item.fixAttempts}`,
    ``,
    `## Test evidence`,
    evidence,
    repo.checkCommand ? `\n### Check command\n\`${repo.checkCommand}\`\n\n\`\`\`\n${(item.checkOutput ?? "").slice(-4000)}\n\`\`\`` : ``,
    ``,
    `🤖 Opened by the BB Chief of Staff plugin`,
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

export async function openPullRequest(cos: Cos, item: WorkItem, repo: RepoConfig, actor: string): Promise<void> {
  if (!repo.allow.openPr) {
    await dispatch(cos, item.id, { type: "pr_open_failed", error: "allow.openPr is false for this repo" }, actor);
    return;
  }
  const github = await cos.github();
  const ws = await workspaceFor(cos, item);
  const info = await github.getRepo(repo.owner, repo.repo);
  const existing = await github.findPullByHead(repo.owner, repo.repo, ws.branch);
  if (existing && existing.state === "open") {
    await dispatch(cos, item.id, { type: "pr_opened", prNumber: existing.number, prUrl: existing.html_url }, actor);
    return;
  }
  const ahead = await git(cos, ws, ["rev-list", "--count", `origin/${info.default_branch}..HEAD`]);
  if (ahead.exitCode === 0 && ahead.stdout.trim() === "0") {
    await dispatch(cos, item.id, { type: "pr_open_failed", error: "branch has no commits ahead of the default branch" }, actor);
    return;
  }
  const title = item.issueNumber ? `${item.issueTitle} (#${item.issueNumber})` : item.issueTitle || ws.branch;
  const body = await buildPrBody(cos, item, repo);
  const pr = await github.createPull(repo.owner, repo.repo, { title: title.slice(0, 250), body, head: ws.branch, base: info.default_branch });
  cos.store.log({ level: "info", kind: "pr", repo: item.repo, workItemId: item.id, message: `opened PR #${pr.number} ${pr.html_url}`, actor });
  if (repo.reviewers.length || repo.teamReviewers.length) {
    await github.requestReviewers(repo.owner, repo.repo, pr.number, repo.reviewers, repo.teamReviewers).catch((error) => cos.bb.log.warn(`request reviewers failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (repo.labels.length) {
    await github.addLabels(repo.owner, repo.repo, pr.number, repo.labels).catch((error) => cos.bb.log.warn(`add labels failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  if (item.issueNumber) {
    await github.createIssueComment(repo.owner, repo.repo, item.issueNumber, `🤖 Chief of Staff opened pull request #${pr.number}: ${pr.html_url}`).catch(() => undefined);
  }
  await dispatch(cos, item.id, { type: "pr_opened", prNumber: pr.number, prUrl: pr.html_url }, actor);
}

/** Poll CI for every open PR we own. Called from the sweep. */
export async function watchCi(cos: Cos, actor: string): Promise<void> {
  const items = cos.store.listWorkItems({ activeOnly: true }).filter((i) => i.prNumber && (i.status === "pr_open" || i.status === "ci_failed" || i.status === "waiting_on_human"));
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
      if (item.status !== "pr_open") continue;
      const ci = await github.ciSummary(repo.owner, repo.repo, pr.head.sha);
      if (ci.state === "failing") {
        // Only react once per head sha.
        const marker = `ci-failed:${pr.head.sha}`;
        if (item.lastError === marker) continue;
        cos.store.updateWorkItem(item.id, { lastError: marker });
        let log = ci.failed.map((f) => `- ${f.name}: ${f.url}`).join("\n");
        const runId = ci.failed.find((f) => f.runId)?.runId;
        if (runId) log += `\n\n${await github.getJobLogsForRun(repo.owner, repo.repo, runId).catch(() => "(log download failed)")}`;
        await dispatch(cos, item.id, { type: "ci_failing", log }, actor);
      } else if (ci.state === "passing" && item.lastError?.startsWith("ci-failed:")) {
        await dispatch(cos, item.id, { type: "ci_passing" }, actor);
      }
    } catch (error) {
      cos.bb.log.warn(`CI watch for ${item.repo}#${item.prNumber} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
    }
  }
}
