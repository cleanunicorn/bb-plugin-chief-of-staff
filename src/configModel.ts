// Editing model for the visual configurator. Pure functions only (zod, the
// config schemas and the RPC contract's schemas) so the frontend bundle can use
// it and tests can cover it.
// The stored format stays the same JSON documents the server parses.
import { isPlaceholderRepo, migrateLegacyRepo, parseGitHubRemote, repoConfigSchema, repoKey, reposDocumentSchema } from "./config";
import type { RepoConfig } from "./config";
import { z } from "zod";
import { generalSettingsSchema } from "../rpcContract";
import type { GeneralSettings } from "../rpcContract";

export type LoadResult<T> = { ok: true; items: T[] } | { ok: false; error: string };

function load<T>(raw: string, parse: (json: unknown) => { success: true; data: T[] } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }): LoadResult<T> {
  const text = raw.trim();
  if (!text) return { ok: true, items: [] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ") };
  return { ok: true, items: parsed.data };
}

/** Load every repo entry, placeholders included, with schema defaults filled in. */
export function loadRepos(raw: string): LoadResult<RepoConfig> {
  return load(raw, (json) => {
    const r = reposDocumentSchema.safeParse(json);
    // owner/repo may be omitted (inferred from the project remote); edit them as "".
    if (r.success) return { success: true, data: r.data.repos.map((e) => ({ ...e, owner: e.owner ?? "", repo: e.repo ?? "" })) };
    // Keep half-filled entries editable: an entry missing only its identity
    // (owner, repo, projectId) loads blank there and is flagged by validateRepos.
    const entries = (json as { repos?: unknown })?.repos;
    if (!Array.isArray(entries)) return r;
    const items: RepoConfig[] = [];
    for (const entry of entries) {
      const e = (migrateLegacyRepo(entry ?? {}) ?? {}) as Record<string, unknown>;
      const ident = (k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
      const filled = repoConfigSchema.safeParse({ ...e, owner: ident("owner") || "_", repo: ident("repo") || "_", projectId: ident("projectId") || "_" });
      if (!filled.success) return r;
      items.push({ ...filled.data, owner: ident("owner"), repo: ident("repo"), projectId: ident("projectId") });
    }
    return { success: true, data: items };
  });
}

/** A BB project as the configurator sees it. */
export type ProjectRef = { id: string; remote: string | null };

/** Fill a blank owner/repo from the BB project's GitHub remote. */
export function inferIdentity(repo: RepoConfig, projects: ProjectRef[]): RepoConfig {
  if (repo.owner.trim() && repo.repo.trim()) return repo;
  const remote = parseGitHubRemote(projects.find((p) => p.id === repo.projectId)?.remote);
  if (!remote) return repo;
  return { ...repo, owner: repo.owner.trim() || remote.owner, repo: repo.repo.trim() || remote.repo };
}

/**
 * Point a repo entry at another BB project. The GitHub repository follows the
 * project when it was blank or still matched the previous project's remote;
 * a repository the user typed by hand is kept.
 */
export function selectProject(repo: RepoConfig, projectId: string, projects: ProjectRef[]): RepoConfig {
  const remoteOf = (id: string) => parseGitHubRemote(projects.find((p) => p.id === id)?.remote);
  const previous = remoteOf(repo.projectId);
  const blank = !repo.owner.trim() || !repo.repo.trim();
  const fromPrevious = Boolean(previous && previous.owner.toLowerCase() === repo.owner.toLowerCase() && previous.repo.toLowerCase() === repo.repo.toLowerCase());
  if (!blank && !fromPrevious) return { ...repo, projectId };
  const next = remoteOf(projectId);
  if (next) return { ...repo, projectId, owner: next.owner, repo: next.repo };
  // New project has no GitHub remote: drop the old project's repository, keep a partial manual one.
  return fromPrevious ? { ...repo, projectId, owner: "", repo: "" } : { ...repo, projectId };
}

/** A new repo with every default filled in and a blank identity. */
export function blankRepo(projectId = ""): RepoConfig {
  // Parse a stub to get every schema default, then blank the identity fields.
  const defaults = repoConfigSchema.parse({ owner: "_", repo: "_", projectId: "_" });
  return { ...defaults, owner: "", repo: "", projectId };
}

/** "a, b ,,c" -> ["a","b","c"] */
export function parseList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse "owner/repo" or a GitHub URL into its parts. */
export function parseRepoSlug(text: string): { owner: string; repo: string } | null {
  const cleaned = text
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(cleaned);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

function dropEmpty<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out as T;
}

export function cleanRepo(repo: RepoConfig): RepoConfig {
  const base = dropEmpty(repo as unknown as Record<string, unknown>) as unknown as RepoConfig;
  return { ...base, issueFilter: dropEmpty(repo.issueFilter as unknown as Record<string, unknown>) as unknown as RepoConfig["issueFilter"] };
}

/**
 * Point repositories that chose workflow `id` back at the default, for when
 * that workflow is deleted. Returns the same array when none chose it.
 */
export function detachWorkflow(repos: RepoConfig[], id: string): { repos: RepoConfig[]; detached: RepoConfig[] } {
  const detached = repos.filter((r) => r.workflow === id);
  if (!detached.length) return { repos, detached };
  return { repos: repos.map((r) => (r.workflow === id ? { ...r, workflow: undefined } : r)), detached };
}

export function serializeRepos(repos: RepoConfig[]): string {
  return JSON.stringify({ repos: repos.map(cleanRepo) }, null, 2);
}

export type Issues = Record<number, string[]>;

function schemaIssues(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((i) => `${i.path.map(String).join(".") || "entry"}: ${i.message}`);
}

/** Blocking problems per repo index (empty object = savable). */
export function validateRepos(repos: RepoConfig[]): Issues {
  const issues: Issues = {};
  const seen = new Map<string, number>();
  repos.forEach((repo, i) => {
    // The seeded example entry is ignored by the server; it must not block saving.
    if (isPlaceholderRepo(repo)) return;
    const list = schemaIssues(repoConfigSchema.safeParse(cleanRepo(repo)));
    if (!repo.owner.trim() || !repo.repo.trim()) list.unshift("set the GitHub repository (owner/repo)");
    if (!repo.projectId.trim()) list.unshift("pick the BB project that holds the checkout");
    const key = repoKey(repo).toLowerCase();
    if (repo.owner && repo.repo) {
      if (seen.has(key)) list.push(`duplicate of entry ${seen.get(key)! + 1}`);
      else seen.set(key, i);
    }
    const unique = [...new Set(list)];
    if (unique.length) issues[i] = unique;
  });
  return issues;
}

// ---------- general settings ----------

const GENERAL_LABELS: Record<keyof GeneralSettings, string> = {
  maxConcurrentTotal: "Max tasks across all repos",
  stallThresholdMinutes: "Stalled after (minutes)",
  intakeIntervalMinutes: "Intake every (minutes)",
  defaultProviderId: "Default provider",
  defaultModel: "Default model",
  notifyPush: "BB push notifications",
  archiveThreadsOnDone: "Archive threads when a task is done",
};

/**
 * Why cos_set_settings would reject these changes, one line per setting.
 * Checks what is sent, not the whole draft: the read side has no ranges, so a
 * value set elsewhere must not block saving an unrelated change.
 */
export function generalSettingsProblems(changes: Partial<GeneralSettings>): { key: keyof GeneralSettings; text: string }[] {
  const parsed = generalSettingsSchema.partial().safeParse(changes);
  if (parsed.success) return [];
  const out: { key: keyof GeneralSettings; text: string }[] = [];
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] as keyof GeneralSettings;
    if (out.some((p) => p.key === key)) continue;
    const label = GENERAL_LABELS[key] ?? String(key);
    const field = generalSettingsSchema.shape[key] as z.ZodType | undefined;
    let text = `${label}: ${issue.message}`;
    if (field instanceof z.ZodNumber) {
      if (issue.code === "invalid_type" && issue.expected === "int") text = `${label} must be a whole number`;
      else if (issue.code === "too_small" || issue.code === "too_big") {
        const { minValue: lo, maxValue: hi } = field;
        text = lo !== null && hi !== null ? `${label} must be between ${lo} and ${hi}` : lo !== null ? `${label} must be at least ${lo}` : `${label} must be at most ${hi}`;
      }
    } else if (field instanceof z.ZodString && issue.code === "too_big") {
      text = `${label} is longer than ${field.maxLength} characters`;
    }
    out.push({ key, text });
  }
  return out;
}
