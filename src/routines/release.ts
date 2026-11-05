import type { RoutineStep } from "../config";
import { nextVersion, renderChangelog } from "../version";
import type { StepContext, StepOutcome } from "./index";

type ReleaseStep = Extract<RoutineStep, { type: "release" }>;

export async function runRelease(ctx: StepContext, step: ReleaseStep): Promise<StepOutcome> {
  const github = await ctx.cos.github();
  const { owner, repo } = ctx.repo;
  const info = await github.getRepo(owner, repo);
  const strategy = step.strategy ?? ctx.repo.versionStrategy;
  const latestTag = await github.latestTag(owner, repo);
  let since: string | null = null;
  if (latestTag) {
    const commit = await github.request<{ commit: { committer: { date: string } } }>("GET", `/repos/${owner}/${repo}/commits/${latestTag.sha}`);
    since = commit.commit.committer.date;
  }
  const merged = await github.listMergedPullsSince(owner, repo, since);
  const mergedIntoDefault = merged.filter((pr) => pr.base.ref === info.default_branch).sort((a, b) => (a.merged_at ?? "").localeCompare(b.merged_at ?? ""));
  const existingTags = latestTag ? [latestTag.name] : [];
  const version = nextVersion(latestTag?.name ?? null, strategy, { prefix: ctx.repo.tagPrefix, now: ctx.cos.now(), mergedTitles: mergedIntoDefault.map((p) => p.title), existingCalverTags: existingTags });
  const tag = `${ctx.repo.tagPrefix}${version}`;
  const changelog = renderChangelog(tag, mergedIntoDefault.map((p) => ({ number: p.number, title: p.title, author: p.user?.login ?? null, url: p.html_url })), ctx.cos.now());
  if (!mergedIntoDefault.length && latestTag) {
    return { status: "skipped", summary: `nothing merged since ${latestTag.name}; no release`, details: { since } };
  }
  if (ctx.dryRun) {
    return { status: "dry_run", summary: `would tag ${tag} with ${mergedIntoDefault.length} merged PR(s)`, details: { tag, changelog, pulls: mergedIntoDefault.map((p) => p.number) } };
  }
  let targetSha = (await github.getBranchHead(owner, repo, info.default_branch)).object.sha;
  // Bump the version file on the default branch when it is a package.json.
  if (ctx.repo.versionFile && /package\.json$/.test(ctx.repo.versionFile)) {
    try {
      const current = await github.request<{ content?: string; sha: string }>("GET", `/repos/${owner}/${repo}/contents/${ctx.repo.versionFile}?ref=${encodeURIComponent(info.default_branch)}`);
      if (current.content) {
        const text = Buffer.from(current.content, "base64").toString("utf8");
        const updated = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
        if (updated !== text) {
          const commit = await github.request<{ commit: { sha: string } }>("PUT", `/repos/${owner}/${repo}/contents/${ctx.repo.versionFile}`, {
            message: `chore(release): ${tag}`,
            content: Buffer.from(updated, "utf8").toString("base64"),
            sha: current.sha,
            branch: info.default_branch,
          });
          targetSha = commit.commit.sha;
        }
      }
    } catch (error) {
      ctx.cos.store.log({ level: "warn", kind: "release", repo: `${owner}/${repo}`, workItemId: null, message: `version file bump skipped: ${error instanceof Error ? error.message : String(error)}`, actor: ctx.actor });
    }
  }
  await github.createTag(owner, repo, tag, targetSha);
  const release = await github.createRelease(owner, repo, { tag_name: tag, name: tag, body: changelog, draft: step.draft, target_commitish: targetSha });
  ctx.cos.store.log({ level: "info", kind: "release", repo: `${owner}/${repo}`, workItemId: null, message: `created release ${tag} ${release.html_url} triggered by ${ctx.actor}`, actor: ctx.actor });
  return { status: "succeeded", summary: `released ${tag} (${mergedIntoDefault.length} PRs) ${release.html_url}`, details: { tag, url: release.html_url, pulls: mergedIntoDefault.map((p) => p.number) } };
}
