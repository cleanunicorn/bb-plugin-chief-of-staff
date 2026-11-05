// Routine runner: executes ordered steps against one repo with per-step
// logging, dry-run support and allow-flag gating.
import { randomUUID } from "node:crypto";
import type { Cos } from "../context";
import type { RepoConfig, Routine, RoutineStep } from "../config";
import type { RoutineRun, RoutineStepResult } from "../state";
import { runBatchMerge } from "./batchMerge";
import { runRelease } from "./release";
import { runDeploy } from "./deploy";
import { runAgentStep } from "./runAgent";

export interface StepContext {
  cos: Cos;
  repo: RepoConfig;
  routine: Routine;
  dryRun: boolean;
  actor: string;
  runId: string;
  signal: AbortSignal;
}

export interface StepOutcome {
  status: "succeeded" | "failed" | "skipped" | "dry_run";
  summary: string;
  details?: unknown;
}

export async function runRoutine(cos: Cos, routine: Routine, opts: { dryRun?: boolean; actor: string; signal?: AbortSignal }): Promise<RoutineRun> {
  const repo = await cos.repo(routine.repo);
  const dryRun = opts.dryRun ?? routine.dryRun;
  const run: RoutineRun = {
    id: randomUUID(),
    routine: routine.name,
    repo: routine.repo,
    triggeredBy: opts.actor,
    dryRun,
    status: "running",
    startedAt: cos.now().toISOString(),
    finishedAt: null,
    steps: [],
  };
  cos.store.insertRun(run);
  cos.store.log({ level: "info", kind: "routine", repo: routine.repo, workItemId: null, message: `routine "${routine.name}" started${dryRun ? " (dry run)" : ""}`, actor: opts.actor });
  cos.invalidate();
  const signal = opts.signal ?? new AbortController().signal;
  if (!repo) {
    run.steps.push(stepResult(0, "config", { status: "failed", summary: `repo ${routine.repo} is not configured; refusing to run` }, run.startedAt, cos.now().toISOString()));
    return finish(cos, run, "failed", opts.actor);
  }
  let failed = 0;
  for (const [index, step] of routine.steps.entries()) {
    const startedAt = cos.now().toISOString();
    let outcome: StepOutcome;
    try {
      outcome = await runStep({ cos, repo, routine, dryRun, actor: opts.actor, runId: run.id, signal }, step);
    } catch (error) {
      outcome = { status: "failed", summary: await cos.safe(error instanceof Error ? error.message : String(error)) };
    }
    run.steps.push(stepResult(index, step.type, outcome, startedAt, cos.now().toISOString()));
    cos.store.updateRun(run);
    cos.store.log({
      level: outcome.status === "failed" ? "error" : "info",
      kind: `routine:${step.type}`,
      repo: routine.repo,
      workItemId: null,
      message: `[${routine.name}] step ${index + 1} ${step.type}: ${outcome.status} — ${outcome.summary}`,
      actor: opts.actor,
    });
    cos.invalidate();
    if (outcome.status === "failed") {
      failed += 1;
      if (!routine.continueOnError) break;
    }
  }
  const status: RoutineRun["status"] = failed === 0 ? "succeeded" : run.steps.length === routine.steps.length && failed < routine.steps.length ? "partial" : "failed";
  return finish(cos, run, status, opts.actor);
}

function finish(cos: Cos, run: RoutineRun, status: RoutineRun["status"], actor: string): RoutineRun {
  run.status = status;
  run.finishedAt = cos.now().toISOString();
  cos.store.updateRun(run);
  cos.store.log({ level: status === "succeeded" ? "info" : "warn", kind: "routine", repo: run.repo, workItemId: null, message: `routine "${run.routine}" ${status}`, actor });
  if (status !== "succeeded") void cos.notify(`Routine ${run.routine} ${status}`, run.steps.filter((s) => s.status === "failed").map((s) => `${s.type}: ${s.summary}`).join("\n") || "see the Chief of Staff log");
  cos.invalidate();
  return run;
}

function stepResult(index: number, type: string, outcome: StepOutcome, startedAt: string, finishedAt: string): RoutineStepResult {
  return { index, type, status: outcome.status, summary: outcome.summary.slice(0, 2000), details: outcome.details === undefined ? null : outcome.details, startedAt, finishedAt };
}

export async function runStep(ctx: StepContext, step: RoutineStep): Promise<StepOutcome> {
  switch (step.type) {
    case "batch_merge":
      if (!ctx.repo.allow.merge) return { status: "skipped", summary: "allow.merge is false for this repo" };
      return runBatchMerge(ctx, step);
    case "release":
      if (!ctx.repo.allow.release) return { status: "skipped", summary: "allow.release is false for this repo" };
      return runRelease(ctx, step);
    case "deploy":
      if (!ctx.repo.allow.deploy) return { status: "skipped", summary: "allow.deploy is false for this repo" };
      return runDeploy(ctx, step);
    case "run_agent":
      return runAgentStep(ctx, step);
    case "notify": {
      const body = step.body ?? `Routine ${ctx.routine.name} on ${ctx.routine.repo}`;
      if (ctx.dryRun) return { status: "dry_run", summary: `would notify: ${step.title}` };
      await ctx.cos.notify(step.title, body);
      return { status: "succeeded", summary: `notified: ${step.title}` };
    }
  }
}
