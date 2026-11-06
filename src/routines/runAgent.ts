import { randomUUID } from "node:crypto";
import type { RoutineStep } from "../config";
import { spawnWorktreeThread } from "../threads";
import type { StepContext, StepOutcome } from "./index";

type RunAgentStep = Extract<RoutineStep, { type: "run_agent" }>;

export async function runAgentStep(ctx: StepContext, step: RunAgentStep): Promise<StepOutcome> {
  const key = `${ctx.repo.owner}/${ctx.repo.repo}`;
  const title = step.title ?? `${ctx.routine.name}: agent task`;
  if (ctx.dryRun) return { status: "dry_run", summary: `would spawn agent "${title}"` };
  const repo = { ...ctx.repo, providerId: step.providerId ?? ctx.repo.providerId, model: step.model ?? ctx.repo.model };
  const item = ctx.cos.store.insertWorkItem({
    id: randomUUID(),
    repo: key,
    issueNumber: null,
    issueTitle: title,
    threadId: null,
    environmentId: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    status: "queued",
    stage: "build",
    providerId: null,
    model: null,
    fixAttempts: 0,
    retryCount: 0,
    lastError: null,
    checkOutput: null,
    source: `routine:${ctx.routine.name}`,
    lastActivityAt: null,
    finishedAt: null,
  });
  const spawned = await spawnWorktreeThread(ctx.cos, { repo, title, prompt: step.prompt, pluginMetadata: { workItemId: item.id, repo: key, routine: ctx.routine.name } });
  ctx.cos.store.updateWorkItem(item.id, { status: "agent", threadId: spawned.thread.id, environmentId: spawned.thread.environmentId ?? null, providerId: spawned.providerId, model: spawned.model, lastActivityAt: ctx.cos.now().toISOString() });
  if (step.waitMinutes > 0) {
    const result = await ctx.cos.bb.sdk.threads.wait({ threadId: spawned.thread.id, status: "idle", timeoutMs: step.waitMinutes * 60_000, signal: ctx.signal });
    if (!result.matched) return { status: "failed", summary: `agent thread ${spawned.thread.id} did not finish within ${step.waitMinutes} min`, details: { threadId: spawned.thread.id } };
  }
  return { status: "succeeded", summary: `spawned agent thread ${spawned.thread.id}`, details: { threadId: spawned.thread.id, workItemId: item.id } };
}
