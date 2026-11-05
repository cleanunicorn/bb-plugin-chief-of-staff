// Typed configuration parsed from plugin settings. Repos and routines are
// stored as JSON documents in multiline string settings (validated here).
import { z } from "zod";

export const issueFilterSchema = z.object({
  labels: z.array(z.string()).default([]),
  milestone: z.string().optional(),
  /** GitHub login the issue must be assigned to (e.g. a bot account). */
  assignee: z.string().optional(),
  /** Explicit issue numbers; when set, only these are eligible. */
  numbers: z.array(z.number().int().positive()).default([]),
});

export const repoAllowSchema = z.object({
  intake: z.boolean().default(true),
  openPr: z.boolean().default(true),
  merge: z.boolean().default(false),
  release: z.boolean().default(false),
  deploy: z.boolean().default(false),
});

export const repoConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** BB project id whose checkout hosts the work (see `bb project list`). */
  projectId: z.string().min(1),
  /** Host that owns the checkout. Defaults to the project's default source host. */
  hostId: z.string().optional(),
  issueFilter: issueFilterSchema.default({ labels: ["agent-ready"], numbers: [] }),
  maxConcurrent: z.number().int().min(0).default(2),
  providerId: z.string().optional(),
  model: z.string().optional(),
  reasoningLevel: z.string().optional(),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).default("auto"),
  /** Shell command run in the branch workspace before a PR is opened. */
  checkCommand: z.string().optional(),
  /** Shell command run by the `deploy` step. */
  deployCommand: z.string().optional(),
  /** GitHub Actions workflow file name (e.g. deploy.yml) for workflow_dispatch. */
  deployWorkflow: z.string().optional(),
  branchPrefix: z.string().default("cos/"),
  /** Rename the BB-created worktree branch to `<branchPrefix>issue-<n>-<slug>`. */
  renameBranch: z.boolean().default(true),
  allow: repoAllowSchema.default({ intake: true, openPr: true, merge: false, release: false, deploy: false }),
  reviewers: z.array(z.string()).default([]),
  teamReviewers: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  mergeStrategy: z.enum(["merge", "squash", "rebase"]).default("squash"),
  /** Only merge PRs opened by this plugin (branch prefix match) by default. */
  mergeFilter: z
    .object({ labels: z.array(z.string()).default([]), onlyOwnBranches: z.boolean().default(true), requireApproval: z.boolean().default(true) })
    .default({ labels: [], onlyOwnBranches: true, requireApproval: true }),
  conflictHandling: z.enum(["skip", "rebase-via-agent"]).default("skip"),
  versionStrategy: z.enum(["patch", "minor", "major", "calver", "conventional"]).default("patch"),
  versionFile: z.string().default("package.json"),
  tagPrefix: z.string().default("v"),
});
export type RepoConfig = z.output<typeof repoConfigSchema>;
export type IssueFilter = z.output<typeof issueFilterSchema>;

export const reposDocumentSchema = z.object({ repos: z.array(repoConfigSchema).default([]) });

export const routineStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("batch_merge"), strategy: z.enum(["merge", "squash", "rebase"]).optional(), labels: z.array(z.string()).optional(), conflictHandling: z.enum(["skip", "rebase-via-agent"]).optional(), requireApproval: z.boolean().optional() }),
  z.object({ type: z.literal("release"), strategy: z.enum(["patch", "minor", "major", "calver", "conventional"]).optional(), draft: z.boolean().default(false) }),
  z.object({ type: z.literal("deploy"), command: z.string().optional(), workflow: z.string().optional(), ref: z.string().optional(), inputs: z.record(z.string(), z.string()).optional(), pollTimeoutMinutes: z.number().int().positive().default(30) }),
  z.object({ type: z.literal("run_agent"), prompt: z.string().min(1), title: z.string().optional(), providerId: z.string().optional(), model: z.string().optional(), waitMinutes: z.number().int().min(0).default(0) }),
  z.object({ type: z.literal("notify"), title: z.string().min(1), body: z.string().optional() }),
]);
export type RoutineStep = z.output<typeof routineStepSchema>;

export const routineSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/),
  enabled: z.boolean().default(true),
  /** 5-field cron expression (server local time unless `timezone` set). */
  cron: z.string().optional(),
  /** Interval alternative to cron, e.g. "30m", "6h", "1d". */
  every: z.string().regex(/^\d+(m|h|d)$/).optional(),
  timezone: z.string().optional(),
  /** "owner/repo" this routine acts on. */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  dryRun: z.boolean().default(false),
  /** Stop at the first failed step (default) or keep going. */
  continueOnError: z.boolean().default(false),
  steps: z.array(routineStepSchema).min(1),
});
export type Routine = z.output<typeof routineSchema>;
export const routinesDocumentSchema = z.object({ routines: z.array(routineSchema).default([]) });

export const SEED_ROUTINES = {
  routines: [
    {
      name: "Nightly ship",
      enabled: false,
      cron: "0 2 * * *",
      repo: "owner/repo",
      dryRun: true,
      steps: [{ type: "batch_merge" }, { type: "release", strategy: "patch" }, { type: "deploy" }],
    },
  ],
};

export const SEED_REPOS = {
  repos: [
    {
      owner: "owner",
      repo: "repo",
      projectId: "proj_xxxxxxxxxx",
      issueFilter: { labels: ["agent-ready"] },
      maxConcurrent: 2,
      checkCommand: "npm test",
      allow: { intake: true, openPr: true, merge: false, release: false, deploy: false },
    },
  ],
};

export type ParseResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

function parseJsonDocument<T>(raw: string, schema: z.ZodType<T, any>, emptyValue: T): ParseResult<T> {
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

export function parseRepos(raw: string): ParseResult<RepoConfig[]> {
  const result = parseJsonDocument(raw, reposDocumentSchema, { repos: [] });
  if (!result.ok) return result;
  const warnings: string[] = [];
  const seen = new Set<string>();
  const repos: RepoConfig[] = [];
  for (const repo of result.value.repos) {
    const key = repoKey(repo);
    if (seen.has(key)) {
      warnings.push(`duplicate repo ${key} ignored`);
      continue;
    }
    seen.add(key);
    // Placeholder entries from the seed are ignored until edited.
    if (repo.owner === "owner" && repo.repo === "repo") {
      warnings.push("placeholder repo owner/repo ignored");
      continue;
    }
    repos.push(repo);
  }
  return { ok: true, value: repos, warnings };
}

export function parseRoutines(raw: string): ParseResult<Routine[]> {
  const result = parseJsonDocument(raw, routinesDocumentSchema, { routines: [] });
  if (!result.ok) return result;
  const warnings: string[] = [];
  const seen = new Set<string>();
  const routines: Routine[] = [];
  for (const routine of result.value.routines) {
    if (seen.has(routine.name)) {
      warnings.push(`duplicate routine ${routine.name} ignored`);
      continue;
    }
    if (!routine.cron && !routine.every) warnings.push(`routine ${routine.name} has no cron/every; manual runs only`);
    seen.add(routine.name);
    routines.push(routine);
  }
  return { ok: true, value: routines, warnings };
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

export function issueBranchName(repo: Pick<RepoConfig, "branchPrefix">, issueNumber: number, title: string): string {
  return `${repo.branchPrefix}issue-${issueNumber}-${slugify(title)}`;
}
