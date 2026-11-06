// RPC handlers for the contract in ../rpcContract.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Cos } from "./context";
import { generalSettingsSchema, rpcContract } from "../rpcContract";
import type { GeneralSettings } from "../rpcContract";
import { buildRoster } from "./roster";
import { runIntake, startTask } from "./intake";
import { parseWorkflow } from "./workflow";
import { dispatch } from "./delivery";
import { isRoutineRunning, runRoutineGuarded } from "./sweep";
import { nextFireTime, validateCron } from "./schedule";
import { parseRepos, parseRoutines } from "./config";
import { collectCandidates } from "./routines/batchMerge";
import { planBatchMerge } from "./routines/batchMergePlan";
import { computeStats } from "./stats";
import { answerQuestion, getQuestion } from "./answer";

export { rpcContract };

export function registerRpc(bb: BbPluginApi, cos: Cos): void {
  bb.rpc.register(
    rpcContract,
    {
      async cos_overview() {
        const config = await cos.config();
        return {
          tokenSource: await cos.tokenSource(),
          repos: config.repos.map((r) => ({
            key: `${r.owner}/${r.repo}`,
            projectId: r.projectId,
            maxConcurrent: r.maxConcurrent,
            active: cos.store.countActive(`${r.owner}/${r.repo}`),
            labels: r.issueFilter.labels,
            allow: r.allow,
            checkCommand: r.checkCommand ?? null,
            deployCommand: r.deployCommand ?? null,
            deployWorkflow: r.deployWorkflow ?? null,
          })),
          errors: config.errors,
          warnings: config.warnings,
          settings: {
            stallThresholdMinutes: config.values.stallThresholdMinutes,
            maxConcurrentTotal: config.values.maxConcurrentTotal,
            autoRetryStalled: config.values.autoRetryStalled,
            intakeIntervalMinutes: config.values.intakeIntervalMinutes,
          },
        };
      },
      async cos_roster(input) {
        return { entries: await buildRoster(cos, input) };
      },
      async cos_routines() {
        return { routines: await describeRoutines(cos) };
      },
      async cos_runs(input) {
        return { runs: cos.store.listRuns(input) };
      },
      async cos_run_routine(input, ctx) {
        const { routines } = await cos.config();
        const routine = routines.find((r) => r.name === input.name);
        if (!routine) throw new Error(`routine "${input.name}" not found`);
        return runRoutineGuarded(cos, routine, { dryRun: input.dryRun, actor: `rpc:${ctx.experimental_caller.kind === "plugin" ? ctx.experimental_caller.pluginId : "client"}`, signal: ctx.experimental_signal });
      },
      async cos_set_routine_enabled(input) {
        cos.store.setEnabledOverride(input.name, input.enabled);
        cos.store.log({ level: "info", kind: "routine", repo: null, workItemId: null, message: `routine "${input.name}" ${input.enabled ? "enabled" : "disabled"}`, actor: "rpc:client" });
        cos.invalidate();
        return { ok: true as const };
      },
      async cos_intake_now(input) {
        return { results: await runIntake(cos, { repo: input.repo, dryRun: input.dryRun, actor: "rpc:client" }) };
      },
      async cos_item_action(input) {
        const item = await itemAction(cos, input.id, input.action, "rpc:client");
        return { status: item?.status ?? "unknown" };
      },
      async cos_start_task(input, ctx) {
        const item = await startTask(cos, { repo: input.repo, title: input.title, body: input.body }, callerActor(ctx));
        if (!item) throw new Error("could not start the task");
        return { id: item.id, stage: item.stage, status: item.status };
      },
      async cos_question(input) {
        return getQuestion(cos, input.id);
      },
      async cos_answer(input, ctx) {
        return answerQuestion(cos, input.id, input.answer, callerActor(ctx));
      },
      async cos_stats(input) {
        return computeStats(cos.store.listWorkItems({ limit: 5000 }), cos.store.listRuns({ limit: 500 }), cos.now(), input.windowDays);
      },
      async cos_log(input) {
        return { entries: cos.store.listLog(input) };
      },
      async cos_merge_preview(input) {
        const repo = await cos.repo(input.repo);
        if (!repo) throw new Error(`repo ${input.repo} is not configured`);
        const { candidates, defaultBranch } = await collectCandidates({ cos, repo, routine: { name: "preview", enabled: true, repo: input.repo, dryRun: true, continueOnError: false, steps: [] }, dryRun: true, actor: "rpc:client", runId: "preview", signal: new AbortController().signal });
        const ownBranches = new Set(cos.store.listWorkItems({ repo: input.repo, limit: 500 }).map((i) => i.branch).filter((b): b is string => Boolean(b)));
        const plan = planBatchMerge(candidates, { branchPrefix: repo.branchPrefix, onlyOwnBranches: repo.mergeFilter.onlyOwnBranches, labels: repo.mergeFilter.labels, requireApproval: repo.mergeFilter.requireApproval, defaultBranch, ownBranches });
        return {
          decisions: plan.decisions.map((d) => {
            const pr = candidates.find((c) => c.number === d.number)!;
            return { ...d, title: pr.title, headRef: pr.headRef };
          }),
        };
      },
      async cos_get_config() {
        const values = await cos.settings.get();
        return { repos: values.repos, routines: values.routines, workflow: values.workflow ?? "" };
      },
      async cos_set_config(input, ctx) {
        const warnings: string[] = [];
        const patch: { repos?: string; routines?: string; workflow?: string } = {};
        if (input.workflow !== undefined) {
          const parsed = parseWorkflow(input.workflow);
          if (!parsed.ok) throw new Error(`workflow: ${parsed.error}`);
          patch.workflow = input.workflow;
        }
        if (input.repos !== undefined) {
          const parsed = parseRepos(input.repos, await cos.projectRemotes());
          if (!parsed.ok) throw new Error(`repos: ${parsed.error}`);
          warnings.push(...parsed.warnings);
          patch.repos = input.repos;
        }
        if (input.routines !== undefined) {
          const parsed = parseRoutines(input.routines);
          if (!parsed.ok) throw new Error(`routines: ${parsed.error}`);
          for (const r of parsed.value) {
            const cronError = r.cron ? validateCron(r.cron, r.timezone) : null;
            if (cronError) throw new Error(`routines: ${r.name}: invalid cron "${r.cron}": ${cronError}`);
          }
          warnings.push(...parsed.warnings);
          patch.routines = input.routines;
        }
        await cos.settings.experimental_set(patch);
        cos.invalidate();
        const changedDocs = Object.keys(patch);
        if (changedDocs.length) cos.store.log({ level: "info", kind: "config", repo: null, workItemId: null, message: `configuration updated: ${changedDocs.join(", ")}`, actor: callerActor(ctx) });
        return { ok: true as const, warnings };
      },
      async cos_get_settings() {
        const values = await cos.settings.get();
        const general = pickGeneral(values) as GeneralSettings;
        // Pickers are a convenience: a failing lookup degrades to free-text inputs.
        const [projects, providers] = await Promise.all([
          safely(async () => (await cos.projects()).map((p) => ({ id: p.id, name: p.name, remote: p.gitRemoteUrl }))),
          safely(async () => (await cos.bb.sdk.providers.catalog()).map((p) => ({ id: p.id, displayName: p.displayName, available: p.available, enabled: p.enabled }))),
        ]);
        return { values: general, token: { stored: Boolean(values.githubToken && values.githubToken.trim()), source: await cos.tokenSource() }, projects, providers };
      },
      async cos_set_settings(input, ctx) {
        const { githubToken, clearGithubToken, ...rest } = input;
        if (rest.notifyWebhookUrl) {
          let url: URL;
          try {
            url = new URL(rest.notifyWebhookUrl);
          } catch {
            throw new Error("notifyWebhookUrl must be a valid https:// URL or empty");
          }
          if (url.protocol !== "https:") throw new Error("notifyWebhookUrl must use https://");
        }
        if (githubToken !== undefined && clearGithubToken) throw new Error("set or clear the GitHub token, not both");
        const patch: Record<string, string | number | boolean | null> = {};
        for (const [key, value] of Object.entries(rest)) if (value !== undefined) patch[key] = value;
        if (githubToken !== undefined) patch.githubToken = githubToken.trim();
        if (clearGithubToken) patch.githubToken = null;
        const changed = Object.keys(patch);
        if (!changed.length) return { ok: true as const, changed };
        await cos.settings.experimental_set(patch as Parameters<typeof cos.settings.experimental_set>[0]);
        cos.invalidate();
        // Key names only: values (and especially the token) are never logged.
        cos.store.log({ level: "info", kind: "config", repo: null, workItemId: null, message: `settings updated: ${changed.join(", ")}`, actor: callerActor(ctx) });
        return { ok: true as const, changed };
      },
    },
    { experimental_discoverable: true, experimental_description: "Chief of Staff: agent roster, issue intake, PR delivery and routines" },
  );
}

export async function describeRoutines(cos: Cos) {
  const { routines } = await cos.config();
  const now = cos.now();
  const configuredRepos = new Set((await cos.config()).repos.map((r) => `${r.owner}/${r.repo}`));
  return routines.map((routine) => {
    const override = cos.store.getEnabledOverride(routine.name);
    const enabled = override === null ? routine.enabled : override;
    const lastRunAt = cos.store.getLastRunAt(routine.name);
    const last = lastRunAt ? new Date(lastRunAt) : null;
    const next = enabled ? nextFireTime(routine, now, last) : null;
    return {
      name: routine.name,
      repo: routine.repo,
      enabled,
      schedule: routine.cron ?? (routine.every ? `every ${routine.every}` : null),
      nextRunAt: next ? next.toISOString() : null,
      lastRunAt,
      dryRun: routine.dryRun,
      steps: routine.steps.map((s) => s.type),
      running: isRoutineRunning(routine.name),
      configured: configuredRepos.has(routine.repo),
    };
  });
}

export type ItemAction = "retry" | "resume" | "rerun_checks" | "approve" | "revise" | "mark_done" | "mark_failed";

export async function itemAction(cos: Cos, id: string, action: ItemAction, actor: string, feedback?: string) {
  const item = cos.store.getWorkItem(id);
  if (!item) throw new Error(`work item ${id} not found`);
  switch (action) {
    case "retry":
    case "resume":
      return dispatch(cos, id, { type: "retry" }, actor);
    case "rerun_checks":
      return dispatch(cos, id, { type: "rerun_verify" }, actor);
    case "approve":
      return dispatch(cos, id, { type: "approve" }, actor);
    case "revise":
      if (!feedback?.trim()) throw new Error("revise needs feedback for the agent");
      return dispatch(cos, id, { type: "revise", feedback }, actor);
    case "mark_done":
      cos.store.log({ level: "info", kind: "manual", repo: item.repo, workItemId: id, message: "marked done", actor });
      cos.invalidate();
      return cos.store.updateWorkItem(id, { status: "done", stage: "done", finishedAt: cos.now().toISOString() });
    case "mark_failed":
      cos.store.log({ level: "info", kind: "manual", repo: item.repo, workItemId: id, message: "marked failed", actor });
      cos.invalidate();
      return cos.store.updateWorkItem(id, { status: "failed", finishedAt: cos.now().toISOString() });
  }
}

const GENERAL_KEYS = Object.keys(generalSettingsSchema.shape) as (keyof typeof generalSettingsSchema.shape)[];

function pickGeneral(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(GENERAL_KEYS.map((k) => [k, values[k]]));
}

function callerActor(ctx: { experimental_caller: { kind: string; pluginId?: string } }): string {
  return `rpc:${ctx.experimental_caller.kind === "plugin" ? ctx.experimental_caller.pluginId : "client"}`;
}

async function safely<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
