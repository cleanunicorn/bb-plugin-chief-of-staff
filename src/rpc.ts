// RPC handlers for the contract in ../rpcContract.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { liveWarnings, type Cos } from "./context";
import { generalSettingsSchema, rpcContract } from "../rpcContract";
import type { GeneralSettings } from "../rpcContract";
import { buildRoster, itemRunDetail, rosterSteps, reconcile } from "./roster";
import { pausedMessage, runIntake, startTask } from "./intake";
import { parseWorkflows, stepById, topoOrder } from "./workflow";
import { dispatch, replayDeferred } from "./delivery";
import { parseRepos } from "./config";
import { computeStats, statsWindowStart } from "./stats";
import { answerQuestion, getQuestion } from "./answer";
import { listSkills } from "./threads";
import { isReferenceable } from "./skills";

export { rpcContract };

export function registerRpc(bb: BbPluginApi, cos: Cos): void {
  bb.rpc.register(
    rpcContract,
    {
      async cos_overview() {
        const config = await cos.config();
        return {
          paused: cos.store.isPaused(),
          tokenSource: await cos.tokenSource(),
          occupiedCapacity: cos.store.countOccupied(),
          repos: await Promise.all(
            config.repos.map(async (r) => {
              const key = `${r.owner}/${r.repo}`;
              const workflow = await cos.workflow(key);
              return {
                key,
                projectId: r.projectId,
                maxConcurrent: r.maxConcurrent,
                active: cos.store.countOccupied(key),
                labels: r.issueFilter.labels,
                intake: r.intake,
                paused: cos.store.isRepoPaused(key),
                workflowId: workflow.id,
                workflowName: workflow.name,
                stepNames: topoOrder(workflow).map((id) => stepById(workflow, id)?.name ?? id),
              };
            }),
          ),
          errors: config.errors,
          warnings: liveWarnings(cos, config),
          settings: {
            stallThresholdMinutes: config.values.stallThresholdMinutes,
            maxConcurrentTotal: config.values.maxConcurrentTotal,
            intakeIntervalMinutes: config.values.intakeIntervalMinutes,
          },
        };
      },
      async cos_set_paused(input, ctx) {
        cos.store.setPaused(input.paused);
        cos.store.log({ level: "info", kind: "control", repo: null, workItemId: null, message: input.paused ? "automation paused" : "automation resumed", actor: callerActor(ctx) });
        cos.invalidate();
        if (!input.paused) {
          await replayDeferred(cos);
          if (!cos.store.isPaused()) await reconcile(cos);
        }
        return { paused: cos.store.isPaused() };
      },
      async cos_set_repo_paused(input, ctx) {
        if (!(await cos.repo(input.repo))) throw new Error(`repo ${input.repo} is not configured`);
        cos.store.setRepoPaused(input.repo, input.paused);
        cos.store.log({ level: "info", kind: "control", repo: input.repo, workItemId: null, message: input.paused ? "project paused" : "project resumed", actor: callerActor(ctx) });
        cos.invalidate();
        if (!input.paused && !cos.store.isPaused()) {
          await replayDeferred(cos);
          if (!cos.store.isPaused()) await reconcile(cos);
        }
        return { repo: input.repo, paused: cos.store.isRepoPaused(input.repo) };
      },
      async cos_roster(input) {
        return buildRoster(cos, input);
      },
      async cos_intake_now(input) {
        return { results: await runIntake(cos, { repo: input.repo, dryRun: input.dryRun, actor: "rpc:client" }) };
      },
      async cos_item_action(input) {
        const target = cos.store.getWorkItem(input.id);
        if (target && cos.store.isPaused(target.repo)) throw new Error(pausedMessage(cos, target.repo, "changing a task"));
        if (!target && cos.store.isPaused()) throw new Error(pausedMessage(cos, "", "changing a task"));
        const item = await itemAction(cos, input.id, input.action, "rpc:client", { step: input.step, feedback: input.feedback });
        return { status: item?.status ?? "unknown" };
      },
      async cos_item_workflow(input) {
        const item = cos.store.getWorkItem(input.id);
        if (!item) throw new Error(`work item ${input.id} not found`);
        const live = Object.fromEntries(rosterSteps(item).map((s) => [s.id, { status: s.status, phase: s.phase, reported: s.reported, agents: s.agents, waitingKind: s.waitingKind, retrying: s.retrying, attempts: s.attempts, round: s.round, picked: s.picked ?? null }]));
        return { title: `${item.repo}${item.issueNumber ? `#${item.issueNumber}` : ""} ${item.issueTitle}`, workflow: item.workflow, live, ...itemRunDetail(cos, item) };
      },
      async cos_journal_detail(input) {
        return { detail: cos.store.journalDetail(input.itemId, input.id) };
      },
      async cos_start_task(input, ctx) {
        const item = await startTask(cos, { repo: input.repo, title: input.title, body: input.body }, callerActor(ctx));
        if (!item) throw new Error("could not start the task");
        return { id: item.id, workflow: item.workflow.name, status: item.status };
      },
      async cos_question(input) {
        return getQuestion(cos, input.id);
      },
      async cos_answer(input, ctx) {
        const target = cos.store.getWorkItem(input.id);
        if (cos.store.isPaused(target?.repo)) throw new Error(pausedMessage(cos, target?.repo ?? "", "answering"));
        return answerQuestion(cos, input.id, input.answer, callerActor(ctx));
      },
      async cos_stats(input) {
        const now = cos.now();
        return computeStats(cos.store.statsRows(statsWindowStart(now, input.windowDays)), now, input.windowDays, cos.store.countWorkItems());
      },
      async cos_log(input) {
        return { entries: cos.store.listLog(input) };
      },
      async cos_get_config() {
        const values = await cos.settings.get();
        return { repos: values.repos, workflow: values.workflow ?? "" };
      },
      async cos_set_config(input, ctx) {
        const warnings: string[] = [];
        const patch: { repos?: string; workflow?: string } = {};
        if (input.workflow !== undefined) {
          const parsed = parseWorkflows(input.workflow);
          if (!parsed.ok) throw new Error(`workflow: ${parsed.error}`);
          patch.workflow = input.workflow;
        }
        if (input.repos !== undefined) {
          const parsed = parseRepos(input.repos, await cos.projectRemotes());
          if (!parsed.ok) throw new Error(`repos: ${parsed.error}`);
          warnings.push(...parsed.warnings);
          patch.repos = input.repos;
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
      async cos_skills() {
        const { repos } = await cos.config();
        const projectIds = [...new Set(repos.map((r) => r.projectId).filter(Boolean))];
        const lists = await Promise.all(projectIds.map((id) => listSkills(cos, id, null)));
        const byName = new Map<string, { name: string; description: string | null; scope: string | null }>();
        for (const skill of lists.flat()) if (isReferenceable(skill.name) && !byName.has(skill.name)) byName.set(skill.name, { name: skill.name, description: skill.description ?? null, scope: skill.scope ?? null });
        return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
      },
      async cos_set_settings(input, ctx) {
        const { githubToken, clearGithubToken, ...rest } = input;
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
    { experimental_discoverable: true, experimental_description: "Chief of Staff: takes issues and tasks through user-defined agent workflows" },
  );
}

export type ItemAction = "retry" | "rerun_step" | "approve" | "revise" | "mark_done" | "mark_failed";

export async function itemAction(cos: Cos, id: string, action: ItemAction, actor: string, opts: { step?: string; feedback?: string } = {}) {
  const item = cos.store.getWorkItem(id);
  if (!item) throw new Error(`work item ${id} not found`);
  if (opts.step && !item.workflow.steps.some((s) => s.id === opts.step)) throw new Error(`step "${opts.step}" is not in this task's workflow (${item.workflow.steps.map((s) => s.id).join(", ")})`);
  switch (action) {
    case "retry":
      return dispatch(cos, id, { type: "retry", step: opts.step }, actor);
    case "rerun_step": {
      if (!opts.step) throw new Error("rerun needs the step to run again");
      return dispatch(cos, id, { type: "rerun", step: opts.step, feedback: opts.feedback }, actor);
    }
    case "approve":
      return dispatch(cos, id, { type: "approve", step: opts.step }, actor);
    case "revise":
      if (!opts.feedback?.trim()) throw new Error("revise needs feedback for the agent");
      return dispatch(cos, id, { type: "revise", step: opts.step, feedback: opts.feedback }, actor);
    case "mark_done":
      cos.store.log({ level: "info", kind: "manual", repo: item.repo, workItemId: id, message: "marked done", actor });
      cos.invalidate();
      return cos.store.updateWorkItem(id, { status: "done", queuedEvent: null, finishedAt: cos.now().toISOString() });
    case "mark_failed":
      cos.store.log({ level: "info", kind: "manual", repo: item.repo, workItemId: id, message: "marked failed", actor });
      cos.invalidate();
      return cos.store.updateWorkItem(id, { status: "failed", queuedEvent: null, finishedAt: cos.now().toISOString() });
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
