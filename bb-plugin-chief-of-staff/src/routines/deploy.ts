import type { RoutineStep } from "../config";
import type { StepContext, StepOutcome } from "./index";

type DeployStep = Extract<RoutineStep, { type: "deploy" }>;

export async function runDeploy(ctx: StepContext, step: DeployStep): Promise<StepOutcome> {
  const workflow = step.workflow ?? ctx.repo.deployWorkflow;
  const command = step.command ?? ctx.repo.deployCommand;
  const { owner, repo } = ctx.repo;
  if (workflow) {
    const github = await ctx.cos.github();
    const info = await github.getRepo(owner, repo);
    const ref = step.ref ?? info.default_branch;
    if (ctx.dryRun) return { status: "dry_run", summary: `would dispatch workflow ${workflow} on ${ref}` };
    const dispatchedAt = new Date(ctx.cos.now().getTime() - 5_000).toISOString();
    await github.dispatchWorkflow(owner, repo, workflow, ref, step.inputs);
    ctx.cos.store.log({ level: "info", kind: "deploy", repo: `${owner}/${repo}`, workItemId: null, message: `dispatched workflow ${workflow} on ${ref} triggered by ${ctx.actor}`, actor: ctx.actor });
    const deadline = ctx.cos.now().getTime() + step.pollTimeoutMinutes * 60_000;
    let runId: number | null = null;
    while (ctx.cos.now().getTime() < deadline && !ctx.signal.aborted) {
      await sleep(15_000, ctx.signal);
      if (runId === null) {
        const runs = await github.listWorkflowRuns(owner, repo, workflow, dispatchedAt);
        if (runs[0]) runId = runs[0].id;
        else continue;
      }
      const run = await github.getWorkflowRun(owner, repo, runId);
      if (run.status === "completed") {
        const ok = run.conclusion === "success";
        return { status: ok ? "succeeded" : "failed", summary: `workflow ${workflow} ${run.conclusion}: ${run.html_url}`, details: { runId, url: run.html_url } };
      }
    }
    return { status: "failed", summary: `workflow ${workflow} did not complete within ${step.pollTimeoutMinutes} min`, details: { runId } };
  }
  if (command) {
    if (ctx.dryRun) return { status: "dry_run", summary: `would run deploy command: ${command}` };
    const checkout = await ctx.cos.checkout(ctx.repo);
    const result = await ctx.cos.hostExec(checkout.hostId, { command, shell: true, cwd: checkout.path, timeoutMs: step.pollTimeoutMinutes * 60_000 }, ctx.signal);
    ctx.cos.store.log({ level: "info", kind: "deploy", repo: `${owner}/${repo}`, workItemId: null, message: `ran deploy command on ${checkout.hostId} (exit ${result.exitCode}) triggered by ${ctx.actor}`, actor: ctx.actor });
    const tail = `${result.stdout}\n${result.stderr}`.slice(-4000);
    if (result.exitCode !== 0) return { status: "failed", summary: `deploy command exited ${result.exitCode ?? "by signal"}${result.timedOut ? " (timed out)" : ""}`, details: { output: tail } };
    return { status: "succeeded", summary: `deploy command succeeded in ${Math.round(result.durationMs / 1000)}s`, details: { output: tail } };
  }
  return { status: "failed", summary: "no deploy command or workflow configured for this repo" };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
