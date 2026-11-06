// Editing model for the visual configurator. Pure functions only (zod + the
// config schemas) so the frontend bundle can use it and tests can cover it.
// The stored format stays the same JSON documents the server parses.
import { parseGitHubRemote, repoConfigSchema, repoKey, reposDocumentSchema, routineSchema, routinesDocumentSchema } from "./config";
import type { RepoConfig, Routine, RoutineStep } from "./config";

export type StepType = RoutineStep["type"];
export const STEP_TYPES: StepType[] = ["batch_merge", "release", "deploy", "run_agent", "notify"];

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
      const e = (entry ?? {}) as Record<string, unknown>;
      const ident = (k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
      const filled = repoConfigSchema.safeParse({ ...e, owner: ident("owner") || "_", repo: ident("repo") || "_", projectId: ident("projectId") || "_" });
      if (!filled.success) return r;
      items.push({ ...filled.data, owner: ident("owner"), repo: ident("repo"), projectId: ident("projectId") });
    }
    return { success: true, data: items };
  });
}

export function loadRoutines(raw: string): LoadResult<Routine> {
  return load(raw, (json) => {
    const r = routinesDocumentSchema.safeParse(json);
    return r.success ? { success: true, data: r.data.routines } : r;
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

/** A new repo starts least-privilege: intake + PRs only, nothing that ships. */
export function blankRepo(projectId = ""): RepoConfig {
  // Parse a stub to get every schema default, then blank the identity fields.
  const defaults = repoConfigSchema.parse({ owner: "_", repo: "_", projectId: "_" });
  return { ...defaults, owner: "", repo: "", projectId };
}

export function blankStep(type: StepType): RoutineStep {
  switch (type) {
    case "batch_merge":
      return { type };
    case "release":
      return { type, strategy: "patch", draft: false };
    case "deploy":
      return { type, pollTimeoutMinutes: 30 };
    case "run_agent":
      return { type, prompt: "", waitMinutes: 0 };
    case "notify":
      return { type, title: "" };
  }
}

/** New routines are disabled dry runs, so nothing fires until the user opts in. */
export function blankRoutine(repo: string, existingNames: string[] = []): Routine {
  let name = "New routine";
  for (let n = 2; existingNames.includes(name); n++) name = `New routine ${n}`;
  return { name, enabled: false, every: "1d", repo, dryRun: true, continueOnError: false, steps: [blankStep("batch_merge")] };
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

export function cleanStep(step: RoutineStep): RoutineStep {
  const s = dropEmpty(step as unknown as Record<string, unknown>) as unknown as RoutineStep;
  if ((s.type === "batch_merge") && s.labels && s.labels.length === 0) delete s.labels;
  if (s.type === "deploy" && s.inputs && Object.keys(s.inputs).length === 0) delete s.inputs;
  return s;
}

export function cleanRoutine(routine: Routine): Routine {
  const base = dropEmpty(routine as unknown as Record<string, unknown>) as unknown as Routine;
  // cron and every are alternatives; keep only the one in use.
  if (base.cron) delete base.every;
  return { ...base, steps: routine.steps.map(cleanStep) };
}

export function serializeRepos(repos: RepoConfig[]): string {
  return JSON.stringify({ repos: repos.map(cleanRepo) }, null, 2);
}

export function serializeRoutines(routines: Routine[]): string {
  return JSON.stringify({ routines: routines.map(cleanRoutine) }, null, 2);
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

const CRON_FIELD = /^[\d*,/\-A-Za-z?LW#]+$/;

/** Cheap client-side cron shape check; the server validates fully on save. */
export function cronShapeError(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron needs 5 fields: minute hour day month weekday";
  if (!parts.every((p) => CRON_FIELD.test(p))) return "cron has invalid characters";
  return null;
}

export function validateRoutines(routines: Routine[]): Issues {
  const issues: Issues = {};
  const seen = new Map<string, number>();
  routines.forEach((routine, i) => {
    const list = schemaIssues(routineSchema.safeParse(cleanRoutine(routine)));
    if (routine.cron && routine.cron.trim()) {
      const e = cronShapeError(routine.cron);
      if (e) list.push(e);
    }
    routine.steps.forEach((step, si) => {
      if (step.type === "run_agent" && !step.prompt.trim()) list.push(`step ${si + 1}: the agent needs a prompt`);
      if (step.type === "notify" && !step.title.trim()) list.push(`step ${si + 1}: the notification needs a title`);
    });
    if (seen.has(routine.name)) list.push(`duplicate name (entry ${seen.get(routine.name)! + 1})`);
    else seen.set(routine.name, i);
    const unique = [...new Set(list)];
    if (unique.length) issues[i] = unique;
  });
  return issues;
}

/** Non-blocking hints: routines on unconfigured repos or steps the repo does not allow. */
export function routineHints(routine: Routine, repos: RepoConfig[]): string[] {
  const repo = repos.find((r) => repoKey(r) === routine.repo);
  if (!repo) return [`${routine.repo} is not a configured repository; the routine will not run`];
  const hints: string[] = [];
  const need: Partial<Record<StepType, keyof RepoConfig["allow"]>> = { batch_merge: "merge", release: "release", deploy: "deploy" };
  for (const step of routine.steps) {
    const flag = need[step.type];
    if (flag && !repo.allow[flag]) hints.push(`${routine.repo} does not allow "${flag}", so the ${step.type.replace("_", " ")} step will be refused`);
  }
  if (!routine.cron && !routine.every) hints.push("no schedule: manual runs only");
  return [...new Set(hints)];
}

export type ScheduleMode = "manual" | "every" | "cron";

export function scheduleMode(routine: Pick<Routine, "cron" | "every">): ScheduleMode {
  if (routine.cron !== undefined) return "cron";
  if (routine.every !== undefined) return "every";
  return "manual";
}

export function splitEvery(every: string | undefined): { amount: number; unit: "m" | "h" | "d" } {
  const m = /^(\d+)(m|h|d)$/.exec(every ?? "");
  return m ? { amount: Number(m[1]), unit: m[2] as "m" | "h" | "d" } : { amount: 1, unit: "d" };
}
