// An agent reported its task already done on the default branch ("resolved").
// Chief of Staff checks the evidence it names: the merged pull request or the
// commit must be on the default branch on GitHub. That proves the change landed,
// not that it fixes the issue: that judgement is the agent's. Confirmed, the
// issue is closed with a comment saying why; otherwise the step waits on a person.
import type { RepoConfig } from "./config";
import type { Cos } from "./context";
import { GitHubError, type GitHubClient } from "./github";
import type { MachineEvent, ResolvedBy, StepReport } from "./machine";
import type { WorkItem } from "./state";

/** Hidden first line of the comment posted when Chief of Staff closes an already-resolved issue. */
export const RESOLVED_MARKER = "<!-- cos-resolved -->";
const SUMMARY_MAX = 3_000;

type Verdict = { ok: true; evidence: string } | { ok: false; reason: string };

/** The first "resolved" report of the step, with its evidence. */
export function resolvedReport(item: WorkItem, stepId: string): (StepReport & { resolvedBy?: ResolvedBy | null }) | null {
  return item.nodes[stepId]?.reports.find((r) => r?.outcome === "resolved") ?? null;
}

/** Whether the evidence is on the default branch. Rate limits and server errors throw (retried); a 404 or 422 is an answer. */
export async function checkEvidence(github: Pick<GitHubClient, "getPull" | "compareCommits">, repo: RepoConfig, defaultBranch: string, by: ResolvedBy | null | undefined): Promise<Verdict> {
  const answer = (error: unknown) => error instanceof GitHubError && (error.status === 404 || error.status === 422);
  if (by?.pr) {
    try {
      const pr = await github.getPull(repo.owner, repo.repo, by.pr);
      if (!pr.merged && !pr.merged_at) return { ok: false, reason: `pull request #${by.pr} is not merged.` };
      if (pr.base.ref !== defaultBranch) return { ok: false, reason: `pull request #${by.pr} was merged into ${pr.base.ref}, not ${defaultBranch}.` };
      return { ok: true, evidence: `pull request #${by.pr} (merged into ${defaultBranch})` };
    } catch (error) {
      if (!answer(error)) throw error;
      if (!by.commit) return { ok: false, reason: `pull request #${by.pr} was not found in ${repo.owner}/${repo.repo}.` };
    }
  }
  if (by?.commit) {
    try {
      const cmp = await github.compareCommits(repo.owner, repo.repo, defaultBranch, by.commit);
      // `base...head` with nothing ahead: every commit of head is in the default branch.
      if (cmp.ahead_by !== 0) return { ok: false, reason: `commit ${by.commit.slice(0, 12)} is not on ${defaultBranch} (${cmp.ahead_by} commit(s) ahead of it).` };
      return { ok: true, evidence: `commit ${by.commit.slice(0, 12)} (on ${defaultBranch})` };
    } catch (error) {
      if (!answer(error)) throw error;
      return { ok: false, reason: `commit ${by.commit.slice(0, 12)} was not found in ${repo.owner}/${repo.repo}.` };
    }
  }
  return { ok: false, reason: "the report names no merged pull request or commit." };
}

function commentBody(evidence: string, summary: string): string {
  const clipped = summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : summary;
  return [
    RESOLVED_MARKER,
    `🤖 Chief of Staff closed this issue: it is already resolved by ${evidence}.`,
    ``,
    `An agent found the change on the default branch; Chief of Staff checked the evidence on GitHub before closing. Reopen the issue if something is still missing.`,
    ...(clipped.trim() ? [``, `<details><summary>The agent's findings</summary>`, ``, clipped.trim(), ``, `</details>`] : []),
  ].join("\n");
}

/**
 * Close the task's issue as completed, then say why. An issue already closed is
 * left alone (a second run after a restart posts nothing twice). A refused close
 * is part of the result, not an error: the task is resolved either way.
 */
async function closeIssue(cos: Cos, github: GitHubClient, repo: RepoConfig, item: WorkItem, evidence: string, summary: string): Promise<string> {
  if (!item.issueNumber) return "";
  const issue = await github.getIssue(repo.owner, repo.repo, item.issueNumber).catch((error: unknown) => {
    // Deleted or transferred: nothing to close, and retrying will not bring it back.
    if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) return null;
    throw error;
  });
  if (!issue) return ` Issue #${item.issueNumber} could not be found to close.`;
  if (issue.state === "closed") return ` Issue #${item.issueNumber} was already closed.`;
  try {
    await github.closeIssue(repo.owner, repo.repo, item.issueNumber);
  } catch (error) {
    if (!(error instanceof GitHubError) || ![403, 404, 410].includes(error.status)) throw error;
    const why = await cos.safe(error.message);
    cos.store.log({ level: "warn", kind: "resolve", repo: item.repo, workItemId: item.id, message: `could not close issue #${item.issueNumber}: ${why}`, actor: "resolve" });
    return ` Chief of Staff could not close issue #${item.issueNumber} (GitHub said ${error.status}); close it by hand.`;
  }
  if (repo.issueComments !== false) {
    try {
      // The agent's text goes public: never with the token in it.
      await github.createIssueComment(repo.owner, repo.repo, item.issueNumber, commentBody(evidence, await cos.safe(summary)));
    } catch (error) {
      // Closed already: a lost comment is not worth reopening the question.
      cos.bb.log.warn(`resolved comment on ${item.repo}#${item.issueNumber} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return ` Closed issue #${item.issueNumber}.`;
}

/** Verify a step's "resolved" report and, in phase "closing", close the issue. Returns the engine's resolve_result. */
export async function verifyResolved(cos: Cos, item: WorkItem, repo: RepoConfig, stepId: string): Promise<MachineEvent> {
  const report = resolvedReport(item, stepId);
  const result = (ok: boolean, detail: string): MachineEvent => ({ type: "resolve_result", step: stepId, ok, detail });
  if (!report) return result(false, "the step has no resolved report.");
  const github = await cos.github();
  // Work of its own in review is not thrown away on an agent's say-so.
  if (item.prNumber) {
    const own = await github.getPull(repo.owner, repo.repo, item.prNumber).catch((error: unknown) => {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    });
    if (own?.state === "open") return result(false, `this task has its own open pull request #${item.prNumber}; close it first if it is not needed.`);
  }
  const { default_branch: defaultBranch } = await github.getRepo(repo.owner, repo.repo);
  const verdict = await checkEvidence(github, repo, defaultBranch, report.resolvedBy);
  if (!verdict.ok) return result(false, verdict.reason);
  // Phase "resolving": the step's approval gate comes first, so only the evidence is checked.
  if (item.nodes[stepId]?.phase !== "closing") return result(true, `${verdict.evidence}.`);
  const closed = await closeIssue(cos, github, repo, item, verdict.evidence, report.summary);
  cos.store.log({ level: "info", kind: "resolve", repo: item.repo, workItemId: item.id, message: `already resolved by ${verdict.evidence}.${closed}`, actor: "resolve" });
  return result(true, `${verdict.evidence}.${closed}`);
}
