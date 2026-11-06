// The delivery workflow: Plan → Build → Verify → Review → Ship. Each stage can
// be switched off (Build is the one stage that always runs) and carries free
// text instructions for the agent. A global workflow lives in the `workflow`
// setting; a repo can override any field of any stage. Pure (zod only) so the
// configurator bundle can use it.
import { z } from "zod";

export const STAGES = ["plan", "build", "verify", "review", "ship"] as const;
export type Stage = (typeof STAGES)[number];
export type StageOrDone = Stage | "done";

export const STAGE_LABEL: Record<StageOrDone, string> = { plan: "Plan", build: "Build", verify: "Verify", review: "Review", ship: "Ship", done: "Done" };

const instructions = z.string().max(20_000);
const attempts = z.number().int().min(0).max(10);

// Field shapes without defaults, shared by the full schema and the override schema.
const planFields = { enabled: z.boolean(), instructions, requireApproval: z.boolean() };
const buildFields = { instructions };
const verifyFields = { enabled: z.boolean(), instructions, command: z.string().max(2000), timeoutMinutes: z.number().int().min(1).max(240), maxAttempts: attempts };
const reviewFields = { enabled: z.boolean(), instructions, mode: z.enum(["agent", "self"]), maxRounds: attempts };
const shipFields = { enabled: z.boolean(), instructions, action: z.enum(["push", "pr", "merge"]), draft: z.boolean(), maxCiFixes: attempts };

export const DEFAULT_WORKFLOW = {
  plan: { enabled: true, instructions: "", requireApproval: true },
  build: { instructions: "" },
  verify: { enabled: true, instructions: "", command: "", timeoutMinutes: 30, maxAttempts: 2 },
  review: { enabled: true, instructions: "", mode: "agent" as const, maxRounds: 2 },
  ship: { enabled: true, instructions: "", action: "pr" as const, draft: false, maxCiFixes: 2 },
};

export const workflowSchema = z.object({
  plan: z.object(planFields).partial().transform((v) => ({ ...DEFAULT_WORKFLOW.plan, ...v })).default(DEFAULT_WORKFLOW.plan),
  build: z.object(buildFields).partial().transform((v) => ({ ...DEFAULT_WORKFLOW.build, ...v })).default(DEFAULT_WORKFLOW.build),
  verify: z.object(verifyFields).partial().transform((v) => ({ ...DEFAULT_WORKFLOW.verify, ...v })).default(DEFAULT_WORKFLOW.verify),
  review: z.object(reviewFields).partial().transform((v) => ({ ...DEFAULT_WORKFLOW.review, ...v })).default(DEFAULT_WORKFLOW.review),
  ship: z.object(shipFields).partial().transform((v) => ({ ...DEFAULT_WORKFLOW.ship, ...v })).default(DEFAULT_WORKFLOW.ship),
});
export type Workflow = z.output<typeof workflowSchema>;

/** Per-repo override: any subset of any stage's fields. */
export const workflowOverrideSchema = z.object({
  plan: z.object(planFields).partial().optional(),
  build: z.object(buildFields).partial().optional(),
  verify: z.object(verifyFields).partial().optional(),
  review: z.object(reviewFields).partial().optional(),
  ship: z.object(shipFields).partial().optional(),
});
export type WorkflowOverride = z.output<typeof workflowOverrideSchema>;

export const workflowDocumentSchema = z.object({ workflow: workflowSchema.default(DEFAULT_WORKFLOW) });

/** Parse the global `workflow` setting. Empty means the defaults. */
export function parseWorkflow(raw: string): { ok: true; value: Workflow } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: workflowSchema.parse({}) };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = workflowDocumentSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ") };
  return { ok: true, value: parsed.data.workflow };
}

export function serializeWorkflow(workflow: Workflow): string {
  return JSON.stringify({ workflow }, null, 2);
}

/**
 * The workflow one repo runs: the global workflow with the repo's overrides
 * merged over it field by field. A legacy `checkCommand` on the repo fills the
 * verify command when neither the override nor the global workflow sets one.
 */
export function resolveWorkflow(global: Workflow, override: WorkflowOverride | undefined, legacy: { checkCommand?: string } = {}): Workflow {
  const o = override ?? {};
  const merged: Workflow = {
    plan: { ...global.plan, ...stripUndefined(o.plan) },
    build: { ...global.build, ...stripUndefined(o.build) },
    verify: { ...global.verify, ...stripUndefined(o.verify) },
    review: { ...global.review, ...stripUndefined(o.review) },
    ship: { ...global.ship, ...stripUndefined(o.ship) },
  };
  if (!o.verify?.command?.trim() && legacy.checkCommand?.trim()) merged.verify.command = legacy.checkCommand.trim();
  return merged;
}

function stripUndefined<T extends object>(obj: T | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Build always runs; the others follow their `enabled` flag. Verify with nothing to do is skipped. */
export function stageEnabled(workflow: Workflow, stage: Stage): boolean {
  switch (stage) {
    case "build":
      return true;
    case "verify":
      return workflow.verify.enabled && Boolean(workflow.verify.command.trim() || workflow.verify.instructions.trim());
    default:
      return workflow[stage].enabled;
  }
}

/** The enabled stages, in order. */
export function activeStages(workflow: Workflow): Stage[] {
  return STAGES.filter((s) => stageEnabled(workflow, s));
}

/** First enabled stage after `stage` ("done" when none is left). */
export function nextStage(workflow: Workflow, stage: Stage, opts: { skipReview?: boolean } = {}): StageOrDone {
  for (let i = STAGES.indexOf(stage) + 1; i < STAGES.length; i++) {
    const candidate = STAGES[i];
    if (candidate === "review" && opts.skipReview) continue;
    if (stageEnabled(workflow, candidate)) return candidate;
  }
  return "done";
}

/** Where a new item starts: Plan when enabled, otherwise Build. */
export function firstStage(workflow: Workflow): Stage {
  return stageEnabled(workflow, "plan") ? "plan" : "build";
}
