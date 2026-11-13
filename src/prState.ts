// Pull request state for the dashboard: open / merged / closed, checks and
// review, read from GitHub by the sweep and cached on the work item (see
// PrState in state.ts). The ship code records what it already knows when it
// opens, merges or sees a PR close; this pass keeps every other open PR
// fresh, tracked or not, and backfills PRs with no recorded state.
import type { Cos } from "./context";
import { GitHubRateLimitError, prStateFrom, reduceReviews } from "./github";
import type { PrState } from "./state";

/**
 * An open PR is read again once its last attempt is this old: the only
 * throttle of the pass, which runs every sweep. Each open PR costs about 4
 * REST requests (getPull, two in ciSummary, listReviews) per refresh, so 40
 * open PRs come to about 960 requests an hour, on top of CI watching's 3 per
 * tracked PR every 2 minutes. Merged and closed PRs cost one request, once.
 * GitHub allows 5,000 an hour; the pass shares the client's rate limiter, so
 * the dashboard's rate-limit banner covers it.
 */
export const PR_STALE_MS = 10 * 60_000;

/** Whether what the dashboard shows differs (the read time aside). */
function differs(a: PrState | null, b: PrState): boolean {
  return !a || a.number !== b.number || a.state !== b.state || a.draft !== b.draft || a.checks !== b.checks || a.review !== b.review;
}

/**
 * Read the state of every PR that is due (see listPrItemsDue), until
 * `deadline` (epoch ms). Never dispatches machine events: CI watching owns
 * the workflow. A rate limit stops the pass without marking the PR in hand
 * as attempted; any other failure marks it, so it goes to the back.
 */
export async function refreshPrStates(cos: Cos, actor: string, opts: { deadline?: number } = {}): Promise<void> {
  const due = cos.store.listPrItemsDue(new Date(cos.now().getTime() - PR_STALE_MS).toISOString());
  if (!due.length) return;
  const github = await cos.github();
  if (!github.hasToken) return;
  let changed = false;
  try {
    for (const item of due) {
      if (opts.deadline !== undefined && cos.now().getTime() >= opts.deadline) {
        cos.bb.log.info("PR state refresh stopped at the sweep's GitHub time budget; the rest waits for the next sweep");
        return;
      }
      try {
        const repo = await cos.repo(item.repo);
        if (!repo) {
          cos.store.touchPrChecked(item.id, cos.now().toISOString());
          continue;
        }
        const pr = await github.getPull(repo.owner, repo.repo, item.prNumber);
        let next = prStateFrom(pr, cos.now());
        if (next.state === "open") {
          const [ci, reviews] = await Promise.all([github.ciSummary(repo.owner, repo.repo, pr.head.sha), github.listReviews(repo.owner, repo.repo, item.prNumber)]);
          next = prStateFrom(pr, cos.now(), ci, reduceReviews(reviews));
        }
        cos.store.setPrState(item.id, next);
        if (!differs(item.prState, next)) continue;
        changed = true;
        // A PR merged or closed outside Chief of Staff; a first read (backfill) is not news.
        if (item.prState?.state === "open" && item.prState.number === next.number && next.state !== "open") {
          cos.store.log({ level: "info", kind: "pr", repo: item.repo, workItemId: item.id, message: `PR #${item.prNumber} was ${next.state}`, actor });
        }
      } catch (error) {
        if (error instanceof GitHubRateLimitError) {
          cos.bb.log.info(`PR state refresh paused: ${await cos.safe(error.message)}`);
          return;
        }
        cos.bb.log.warn(`PR state for ${item.repo}#${item.prNumber} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
        cos.store.touchPrChecked(item.id, cos.now().toISOString());
      }
    }
  } finally {
    if (changed) cos.invalidate();
  }
}
