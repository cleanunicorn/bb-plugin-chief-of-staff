// RPC handlers for the contract in ../rpcContract.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Cos } from "./context";
import { rpcContract } from "../rpcContract";
import { buildRoster } from "./roster";
import { runIntake } from "./intake";
import { dispatch } from "./delivery";
import { isRoutineRunning, runRoutineGuarded } from "./sweep";
import { nextFireTime } from "./schedule";
import { parseRepos, parseRoutines } from "./config";
import { collectCandidates } from "./routines/batchMerge";
import { planBatchMerge } from "./routines/batchMergePlan";
import { computeStats } from "./stats";

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
            maxFixRetries: config.values.maxFixRetries,
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
        return { repos: values.repos, routines: values.routines };
      },
      async cos_set_config(input) {
        const warnings: string[] = [];
        const patch: { repos?: string; routines?: string } = {};
        if (input.repos !== undefined) {
          const parsed = parseRepos(input.repos);
          if (!parsed.ok) throw new Error(`repos: ${parsed.error}`);
          warnings.push(...parsed.warnings);
          patch.repos = input.repos;
        }
        if (input.routines !== undefined) {
          const parsed = parseRoutines(input.routines);
          if (!parsed.ok) throw new Error(`routines: ${parsed.error}`);
          warnings.push(...parsed.warnings);
          patch.routines = input.routines;
        }
        await cos.settings.experimental_set(patch);
        cos.invalidate();
        return { ok: true as const, warnings };
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

export async function itemAction(cos: Cos, id: string, action: "retry" | "resume" | "rerun_checks" | "mark_done" | "mark_failed", actor: string) {
  const item = cos.store.getWorkItem(id);
  if (!item) throw new Error(`work item ${id} not found`);
  switch (action) {
    case "retry":
      return dispatch(cos, id, { type: "retry" }, actor);
    case "resume":
      return dispatch(cos, id, { type: "human_resume" }, actor);
    case "rerun_checks":
      cos.store.updateWorkItem(id, { status: "running" });
      return dispatch(cos, id, { type: "thread_idle" }, actor);
    case "mark_done":
      cos.store.log({ level: "info", kind: "manual", repo: item.repo, workItemId: id, message: "marked done", actor });
      cos.invalidate();
      return cos.store.updateWorkItem(id, { status: "done", finishedAt: cos.now().toISOString() });
    case "mark_failed":
      cos.store.log({ level: "info", kind: "manual", repo: item.repo, workItemId: id, message: "marked failed", actor });
      cos.invalidate();
      return cos.store.updateWorkItem(id, { status: "failed", finishedAt: cos.now().toISOString() });
  }
}
