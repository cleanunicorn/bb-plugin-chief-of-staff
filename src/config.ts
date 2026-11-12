// Typed configuration parsed from plugin settings. Repos are stored as a JSON
// document in a multiline string setting (validated here).
import { z } from "zod";
import { legacyStagesSchema } from "./workflow";

export const issueFilterSchema = z.object({
  labels: z.array(z.string()).default([]),
  /** GitHub login the issue must be assigned to (e.g. a bot account). */
  assignee: z.string().optional(),
});

export const repoConfigSchema = z.object({
  /** GitHub owner. Optional: inferred from the BB project's git remote. */
  owner: z.string().min(1).optional(),
  /** GitHub repository name. Optional: inferred from the BB project's git remote. */
  repo: z.string().min(1).optional(),
  /** BB project id whose checkout hosts the work (see `bb project list`). */
  projectId: z.string().min(1),
  /** Host that owns the checkout. Defaults to the project's default source host. */
  hostId: z.string().optional(),
  /** Pick up matching issues automatically. Off: only tasks you start. */
  intake: z.boolean().default(true),
  issueFilter: issueFilterSchema.default({ labels: ["agent-ready"] }),
  /** Comment on the GitHub issue when an agent starts and when a PR opens. Off: no issue comments. */
  issueComments: z.boolean().default(true),
  maxConcurrent: z.number().int().min(0).default(2),
  providerId: z.string().optional(),
  model: z.string().optional(),
  reasoningLevel: z.string().optional(),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).default("auto"),
  /** GitHub logins asked to review the pull requests Chief of Staff opens. */
  reviewers: z.array(z.string()).default([]),
  /** How Ship merges when its action is "merge". */
  mergeStrategy: z.enum(["merge", "squash", "rebase"]).default("squash"),
  /**
   * The workflow this repository runs (an id from the workflow setting; empty
   * = the default). Older configs hold per-stage overrides here instead; they
   * are converted into a workflow of their own.
   */
  workflow: z.union([z.string().min(1), legacyStagesSchema]).optional(),
});
/** A repo entry with owner/repo resolved (explicitly or from the project remote). */
export type RepoConfig = z.output<typeof repoConfigSchema> & { owner: string; repo: string };
export type IssueFilter = z.output<typeof issueFilterSchema>;

/** Branches Chief of Staff names start with this. */
export const BRANCH_PREFIX = "cos/";

/**
 * Fold settings from before the workflow into the current shape: `checkCommand`
 * becomes the repo's verify command, `allow.intake: false` pauses intake, and
 * `mergeFilter.requireApproval: false` lifts the merge approval gate. Every
 * other legacy key (deploy, release, routines-only options) is dropped.
 */
export function migrateLegacyRepo(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = { ...(entry as Record<string, unknown>) };
  // A workflow id (current format) is left alone; stage overrides (older) absorb the legacy keys.
  if (typeof e.workflow === "string") {
    delete e.checkCommand;
    return e;
  }
  const workflow = { ...((e.workflow as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  if (typeof e.checkCommand === "string" && e.checkCommand.trim() && !workflow.verify?.command) workflow.verify = { ...workflow.verify, command: e.checkCommand.trim() };
  const mergeFilter = e.mergeFilter as { requireApproval?: unknown } | undefined;
  if (mergeFilter?.requireApproval === false && workflow.ship?.requireApproval === undefined) workflow.ship = { ...workflow.ship, requireApproval: false };
  const allow = e.allow as { intake?: unknown } | undefined;
  if (allow?.intake === false && e.intake === undefined) e.intake = false;
  if (Object.keys(workflow).length) e.workflow = workflow;
  const filter = e.issueFilter as Record<string, unknown> | undefined;
  if (filter) e.issueFilter = { labels: filter.labels, ...(filter.assignee ? { assignee: filter.assignee } : {}) };
  return e;
}

export const reposDocumentSchema = z.object({ repos: z.array(z.preprocess(migrateLegacyRepo, repoConfigSchema)).default([]) });

/** projectId of the seeded example entry; ignored until edited. */
export const PLACEHOLDER_PROJECT_ID = "proj_xxxxxxxxxx";

export const SEED_REPOS = {
  repos: [
    {
      projectId: PLACEHOLDER_PROJECT_ID,
      issueFilter: { labels: ["agent-ready"] },
      maxConcurrent: 2,
    },
  ],
};

export type ParseResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

function parseJsonDocument<T>(raw: string, schema: z.ZodType<T>, emptyValue: T): ParseResult<T> {
  const text = raw.trim();
  if (!text) return { ok: true, value: emptyValue, warnings: [] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ") };
  return { ok: true, value: parsed.data, warnings: [] };
}

/** True for the seeded example entry (old seeds used owner/repo "owner/repo"). */
export function isPlaceholderRepo(entry: { projectId: string; owner?: string; repo?: string }): boolean {
  return entry.projectId === PLACEHOLDER_PROJECT_ID || (entry.owner === "owner" && entry.repo === "repo");
}

/** Parse "owner/repo" out of a github.com remote URL (https, ssh, or scp-style). */
export function parseGitHubRemote(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)?(?:www\.)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** BB project id -> git remote URL, used to infer owner/repo. */
export type ProjectRemotes = ReadonlyMap<string, string | null>;

/**
 * Parse the repos document. Entries without `owner`/`repo` take them from the
 * BB project's GitHub remote. Without `projects` (synchronous settings
 * validation) such entries still validate but are left out of the result.
 */
export function parseRepos(raw: string, projects?: ProjectRemotes): ParseResult<RepoConfig[]> {
  const result = parseJsonDocument(raw, reposDocumentSchema, { repos: [] });
  if (!result.ok) return result;
  const warnings: string[] = [];
  const seen = new Set<string>();
  const repos: RepoConfig[] = [];
  for (const entry of result.value.repos) {
    // Placeholder entries from the seed are ignored until edited.
    if (isPlaceholderRepo(entry)) {
      warnings.push("placeholder repo entry ignored");
      continue;
    }
    const remote = projects?.has(entry.projectId) ? parseGitHubRemote(projects.get(entry.projectId)) : null;
    const owner = entry.owner ?? remote?.owner;
    const name = entry.repo ?? remote?.repo;
    if (!owner || !name) {
      if (!projects) continue; // resolved later, when the project list is available
      warnings.push(
        projects.has(entry.projectId)
          ? `project ${entry.projectId} has no GitHub remote; set owner and repo explicitly`
          : `project ${entry.projectId} not found; set owner and repo explicitly or fix projectId`,
      );
      continue;
    }
    if (remote && (remote.owner.toLowerCase() !== owner.toLowerCase() || remote.repo.toLowerCase() !== name.toLowerCase())) {
      warnings.push(`${owner}/${name} differs from project ${entry.projectId} remote ${remote.owner}/${remote.repo}`);
    }
    const repo: RepoConfig = { ...entry, owner, repo: name };
    const key = repoKey(repo);
    if (seen.has(key)) {
      warnings.push(`duplicate repo ${key} ignored`);
      continue;
    }
    seen.add(key);
    repos.push(repo);
  }
  return { ok: true, value: repos, warnings };
}

export function repoKey(repo: { owner: string; repo: string }): string {
  return `${repo.owner}/${repo.repo}`;
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "issue";
}

export function issueBranchName(issueNumber: number, title: string): string {
  return `${BRANCH_PREFIX}issue-${issueNumber}-${slugify(title)}`;
}
