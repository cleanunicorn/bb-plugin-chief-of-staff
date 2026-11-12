// The one status comment Chief of Staff keeps on a GitHub issue. It is created
// when an agent first starts and edited, never repeated, when the task restarts
// with a fresh builder or intake picks the same issue up again.
import type { RepoConfig } from "./config";
import type { Cos } from "./context";
import { GitHubError } from "./github";
import type { WorkItem } from "./state";
import { publicThreadUrl } from "./threads";

/** Hidden first line of the status comment: how a lost comment id is found again. */
export const STATUS_MARKER = "<!-- cos-status -->";
/** Comments posted before the marker existed began like this. */
const LEGACY_PREFIX = "🤖 Chief of Staff started an agent on this issue";

/** KV key of the status comment id: one per repository issue, shared by every work item for it. */
export const statusKey = (repo: string, issueNumber: number) => `status-comment:${repo}#${issueNumber}`;

/** The marker counts only at the very start, so a person quoting it in a comment is not mistaken for ours. */
export function isStatusComment(body: string): boolean {
  return body.startsWith(STATUS_MARKER) || body.startsWith(LEGACY_PREFIX);
}

function statusBody(cos: Cos, item: WorkItem, threadId: string, restarted: boolean): string {
  const link = publicThreadUrl(cos, threadId);
  return [
    STATUS_MARKER,
    `${LEGACY_PREFIX} (workflow: ${item.workflow.name}).`,
    ...(restarted ? [``, `Restarted with a new agent.`] : []),
    ...(link ? [``, `BB thread: ${link}`] : []),
  ].join("\n");
}

/**
 * Create or edit the issue's status comment for a builder just spawned in
 * `threadId`. Best-effort: the thread already exists, so a GitHub failure is
 * logged and never thrown. Only a missing or foreign comment (404, 403) leads
 * to a new one; any other failure leaves the issue alone rather than risk a duplicate.
 */
export async function postStatusComment(cos: Cos, repo: RepoConfig, item: WorkItem, threadId: string): Promise<void> {
  if (!item.issueNumber || repo.issueComments === false) return;
  const issue = item.issueNumber;
  try {
    const github = await cos.github();
    const key = statusKey(item.repo, issue);
    let commentId = (await cos.bb.storage.kv.get<number>(key)) ?? null;
    if (commentId === null) {
      // Nothing stored: a first run, an upgrade, or a crash between create and store.
      const existing = (await github.listIssueComments(repo.owner, repo.repo, issue)).filter((c) => isStatusComment(c.body));
      commentId = existing.at(-1)?.id ?? null;
    }
    if (commentId !== null) {
      try {
        await github.updateIssueComment(repo.owner, repo.repo, commentId, statusBody(cos, item, threadId, true));
        await cos.bb.storage.kv.set(key, commentId);
        return;
      } catch (error) {
        const gone = error instanceof GitHubError && (error.status === 404 || error.status === 403);
        if (!gone) throw error;
        cos.bb.log.info(`status comment ${commentId} on ${item.repo}#${issue} cannot be edited (${(error as GitHubError).status}); posting a new one`);
      }
    }
    const created = await github.createIssueComment(repo.owner, repo.repo, issue, statusBody(cos, item, threadId, false));
    await cos.bb.storage.kv.set(key, created.id);
  } catch (error) {
    cos.bb.log.warn(`status comment on ${item.repo}#${issue} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
  }
}
