// Shared services handed to every module: store, config, GitHub, host exec, notify.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, type ExecInput, type ExecOutput } from "../contract";
import { parseRepos, type ProjectRemotes, type RepoConfig } from "./config";
import { GitHubClient, redact } from "./github";
import type { StateStore } from "./state";
import type { SettingsHandle, SettingsValues } from "./settings";
import { DEFAULT_POLICY, type MachinePolicy } from "./machine";
import { parseWorkflow, resolveWorkflow, workflowSchema, type Workflow } from "./workflow";

export interface LoadedConfig {
  values: SettingsValues;
  repos: RepoConfig[];
  /** The global workflow (repos merge their overrides over it). */
  workflow: Workflow;
  errors: string[];
  warnings: string[];
  policy: MachinePolicy;
}

export interface Cos {
  bb: BbPluginApi;
  store: StateStore;
  settings: SettingsHandle;
  now(): Date;
  config(): Promise<LoadedConfig>;
  repo(key: string): Promise<RepoConfig | null>;
  /** The workflow a repo runs (global merged with the repo's overrides). */
  workflow(repoKey: string): Promise<Workflow>;
  /** BB projects (non-personal) with their git remote, used to infer owner/repo. */
  projects(): Promise<Array<{ id: string; name: string; gitRemoteUrl: string | null }>>;
  /** projectId -> git remote URL, or undefined when the project list is unavailable. */
  projectRemotes(): Promise<ProjectRemotes | undefined>;
  github(): Promise<GitHubClient>;
  /** Token source for display: "setting" | "gh-cli" | "none". Never the token itself. */
  tokenSource(): Promise<"setting" | "gh-cli" | "none">;
  hostExec(hostId: string, input: ExecInput, signal?: AbortSignal): Promise<ExecOutput>;
  hostReadFile(hostId: string, path: string): Promise<string | null>;
  /** The host + checkout path for a repo (project default source). */
  checkout(repo: RepoConfig): Promise<{ hostId: string; path: string }>;
  notify(title: string, body: string, threadId?: string): Promise<void>;
  invalidate(): void;
  safe(text: string): Promise<string>;
}

export function createContext(bb: BbPluginApi, store: StateStore, settings: SettingsHandle): Cos {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  let cachedToken: { value: string | null; source: "setting" | "gh-cli" | "none"; at: number } | null = null;

  async function resolveToken(): Promise<{ value: string | null; source: "setting" | "gh-cli" | "none" }> {
    if (cachedToken && Date.now() - cachedToken.at < 5 * 60_000) return cachedToken;
    const values = await settings.get();
    if (values.githubToken && values.githubToken.trim()) {
      cachedToken = { value: values.githubToken.trim(), source: "setting", at: Date.now() };
      return cachedToken;
    }
    // Fallback: the gh CLI's stored credential on the server host.
    try {
      const config = await bb.sdk.system.config();
      const hostId = config.primaryHostId;
      if (hostId) {
        const result = await host.call("exec", { command: "gh", args: ["auth", "token"], cwd: "/", timeoutMs: 20_000 }, { hostId, timeoutMs: 30_000 });
        const token = result.exitCode === 0 ? result.stdout.trim() : "";
        if (token) {
          cachedToken = { value: token, source: "gh-cli", at: Date.now() };
          return cachedToken;
        }
      }
    } catch {
      /* no gh available */
    }
    cachedToken = { value: null, source: "none", at: Date.now() };
    return cachedToken;
  }

  settings.onChange(() => {
    cachedToken = null;
    configCache = null;
  });

  let configCache: { at: number; value: LoadedConfig } | null = null;

  const cos: Cos = {
    bb,
    store,
    settings,
    now: () => new Date(),
    async config() {
      if (configCache && Date.now() - configCache.at < 5_000) return configCache.value;
      const values = await settings.get();
      const errors: string[] = [];
      const warnings: string[] = [];
      const remotes = await cos.projectRemotes();
      if (!remotes) warnings.push("BB project list unavailable; repos without explicit owner/repo are skipped");
      const reposResult = parseRepos(values.repos, remotes);
      if (!reposResult.ok) errors.push(`repos: ${reposResult.error}`);
      else warnings.push(...reposResult.warnings);
      const workflowResult = parseWorkflow(values.workflow ?? "");
      if (!workflowResult.ok) errors.push(`workflow: ${workflowResult.error}`);
      const workflow = workflowResult.ok ? workflowResult.value : workflowSchema.parse({});
      const repos = reposResult.ok ? reposResult.value : [];
      const value: LoadedConfig = {
        values,
        repos,
        workflow,
        errors,
        warnings,
        policy: DEFAULT_POLICY,
      };
      configCache = { at: Date.now(), value };
      return value;
    },
    async repo(key) {
      const { repos } = await cos.config();
      return repos.find((r) => `${r.owner}/${r.repo}` === key) ?? null;
    },
    async workflow(key) {
      const config = await cos.config();
      const repo = config.repos.find((r) => `${r.owner}/${r.repo}` === key);
      return resolveWorkflow(config.workflow, repo?.workflow);
    },
    async projects() {
      const projects = await bb.sdk.projects.list({ includePersonal: false });
      return projects.map((p) => ({ id: p.id, name: p.name, gitRemoteUrl: p.gitRemoteUrl ?? null }));
    },
    async projectRemotes() {
      try {
        return new Map((await cos.projects()).map((p) => [p.id, p.gitRemoteUrl]));
      } catch (error) {
        bb.log.warn(`project list failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
    async github() {
      const token = await resolveToken();
      return new GitHubClient({ token: token.value });
    },
    async tokenSource() {
      return (await resolveToken()).source;
    },
    async hostExec(hostId, input, signal) {
      // The host enforces input.timeoutMs (and kills the process tree); the call deadline only adds slack.
      const timeoutMs = Math.min(4 * 60 * 60_000 + 60_000, (input.timeoutMs ?? 10 * 60_000) + 30_000);
      return host.call("exec", input, { hostId, timeoutMs, signal });
    },
    async hostReadFile(hostId, path) {
      const result = await host.call("readFile", { path }, { hostId, timeoutMs: 20_000 });
      return result.exists ? result.content : null;
    },
    async checkout(repo) {
      const projects = await bb.sdk.projects.list({ includePersonal: false });
      const project = projects.find((p) => p.id === repo.projectId);
      if (!project) throw new Error(`project ${repo.projectId} not found for ${repo.owner}/${repo.repo}`);
      const source = (repo.hostId ? project.sources.find((s) => s.hostId === repo.hostId) : undefined) ?? project.sources.find((s) => s.isDefault) ?? project.sources[0];
      if (!source) throw new Error(`project ${project.name} has no checkout source`);
      return { hostId: source.hostId, path: source.path };
    },
    async notify(title, body, threadId) {
      const values = await settings.get();
      const safeTitle = await cos.safe(title);
      const safeBody = await cos.safe(body);
      bb.realtime.publish("cos-alert", { title: safeTitle, body: safeBody, threadId: threadId ?? null, at: new Date().toISOString() });
      if (values.notifyPush) {
        try {
          await bb.sdk.plugins.callRpc({
            pluginId: "push-notifications",
            method: "notifications.send",
            input: { title: safeTitle.slice(0, 4000), body: safeBody.slice(0, 4000), ...(threadId ? { threadId } : {}) },
            outputSchema: z.any(),
          });
        } catch (error) {
          bb.log.debug(`push notification skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    invalidate() {
      try {
        bb.rpc.experimental_invalidateAll();
      } catch {
        /* rpc not registered yet */
      }
      bb.realtime.publish("cos-changed", { at: Date.now() });
    },
    async safe(text) {
      const token = await resolveToken();
      return redact(text, token.value);
    },
  };
  return cos;
}
