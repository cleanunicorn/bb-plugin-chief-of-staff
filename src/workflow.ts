// User-defined workflows: a graph of typed steps. Pure (zod only) so the
// configurator bundle and the engine share it.
//
// A workflow is a list of steps. Each step has an id, a name, instructions,
// `next` (the steps that follow it) and the properties of its type:
//   agent: an agent works on the instructions (optionally read-only and in
//          parallel, gated by a human approval or by its own pass/fail verdict)
//   check: Chief of Staff runs a command in the worktree
//   ship:  push, open a pull request, or merge it when CI is green
//   model: sets the provider, model and reasoning level for the agent steps
//          after it, until another model step changes them. "auto" (the
//          default) runs a read-only agent that reads the task and picks the
//          best model from the ones available; "fixed" sets them as written
// `next` edges form a DAG; `onFail` points back to an earlier step to re-run
// from when a verdict, check or CI fails.
import { z } from "zod";

export const STEP_TYPES = ["agent", "check", "ship", "model"] as const;
export type StepType = (typeof STEP_TYPES)[number];

const stepId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "lowercase letters, digits, - and _ (max 40)");
const position = z.object({ x: z.number(), y: z.number() });
const attempts = z.number().int().min(0).max(10);

const base = {
  id: stepId,
  name: z.string().min(1).max(80),
  instructions: z.string().max(20_000).default(""),
  next: z.array(stepId).default([]),
  /** Canvas position; laid out automatically when missing. */
  position: position.optional(),
};

/** A model an agent step may pick for the steps after it. */
export const modelChoiceSchema = z.object({
  /** What the agent reports to pick it. */
  id: stepId,
  /** When this is the right choice; shown to the agent. */
  when: z.string().min(1).max(1000),
  providerId: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  reasoningLevel: z.string().max(50).optional(),
});
export type ModelChoice = z.output<typeof modelChoiceSchema>;

export const agentStepSchema = z.object({
  ...base,
  type: z.literal("agent"),
  /** Changes code: runs in the task's builder thread, one writing step at a time. Otherwise read-only. */
  writes: z.boolean().default(false),
  /** Read-only steps: how many agents work on it in parallel. */
  agents: z.number().int().min(1).max(4).default(1),
  /** A person approves the step's report, or sends it back with feedback. */
  approval: z.boolean().default(false),
  /** The agent reports pass or fail; fail re-runs from `onFail`. */
  verdict: z.boolean().default(false),
  onFail: stepId.optional(),
  maxRounds: attempts.default(2),
  /**
   * With choices, the agent analyses the task and picks one in its report; the
   * agent steps after this one then run with it (until another step changes it).
   */
  chooses: z.array(modelChoiceSchema).max(12).default([]),
});

export const checkStepSchema = z.object({
  ...base,
  type: z.literal("check"),
  command: z.string().min(1).max(2000),
  timeoutMinutes: z.number().int().min(1).max(240).default(30),
  onFail: stepId.optional(),
  maxAttempts: attempts.default(2),
});

export const shipStepSchema = z.object({
  ...base,
  type: z.literal("ship"),
  action: z.enum(["push", "pr", "merge"]).default("pr"),
  draft: z.boolean().default(false),
  /** With action "merge": wait for an approving review on GitHub. */
  requireApproval: z.boolean().default(true),
  /** Where to go back to when CI is red. */
  onFail: stepId.optional(),
  maxAttempts: attempts.default(2),
});

export const MODEL_MODES = ["auto", "fixed"] as const;
export type ModelMode = (typeof MODEL_MODES)[number];

/**
 * Sets how agents run from here on. "auto": an agent reads the task and the
 * step's instructions and picks the provider, model and reasoning level from
 * the ones available. "fixed": the fields below; empty ones leave the setting
 * as it was (an earlier model step, else the repository's, else the global
 * default). Without a mode (steps saved before it existed) a step that sets a
 * field is fixed, otherwise automatic: see `modelMode`.
 */
export const modelStepSchema = z.object({
  ...base,
  type: z.literal("model"),
  mode: z.enum(MODEL_MODES).optional(),
  /** Fixed mode: the agent, a BB provider id such as "claude-code". */
  providerId: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  reasoningLevel: z.string().max(50).optional(),
  /** A model step cannot fail; declared so code can read `onFail` on any step. */
  onFail: z.undefined().optional(),
});

export const stepSchema = z.discriminatedUnion("type", [agentStepSchema, checkStepSchema, shipStepSchema, modelStepSchema]);
export type Step = z.output<typeof stepSchema>;
export type AgentStep = z.output<typeof agentStepSchema>;
export type CheckStep = z.output<typeof checkStepSchema>;
export type ShipStep = z.output<typeof shipStepSchema>;
export type ModelStep = z.output<typeof modelStepSchema>;

/** Instructions an automatic model step starts with. */
export const DEFAULT_MODEL_INSTRUCTIONS = "Read the task and choose the best model for the job from the ones available: strong enough to do it well, no more expensive than it needs.";

/** Whether a model step picks automatically or sets fixed values. */
export function modelMode(step: ModelStep): ModelMode {
  if (step.mode) return step.mode;
  return step.providerId?.trim() || step.model?.trim() || step.reasoningLevel?.trim() ? "fixed" : "auto";
}

/**
 * The agent work a step runs, as an agent step: agent steps themselves, and
 * automatic model steps, which run one read-only agent that picks the model
 * (`picksModel`). Null for steps without an agent (checks, ship, fixed model steps).
 */
export type AgentWork = AgentStep & { picksModel?: true };
export function agentWork(step: Step | undefined | null): AgentWork | null {
  if (!step) return null;
  if (step.type === "agent") return step;
  if (step.type !== "model" || modelMode(step) !== "auto") return null;
  return {
    id: step.id,
    name: step.name,
    type: "agent",
    instructions: step.instructions.trim() || DEFAULT_MODEL_INSTRUCTIONS,
    next: step.next,
    ...(step.position ? { position: step.position } : {}),
    writes: false,
    agents: 1,
    approval: false,
    verdict: false,
    maxRounds: 0,
    chooses: [],
    picksModel: true,
  };
}

/** The provider, model and reasoning level a step's agents run with; unset fields fall back to the repository's, then the global default. */
export interface AgentSettings {
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  /**
   * Set by an automatic model step's pick: the three fields go together, so an
   * unset one (usually the reasoning level) means the provider's own default,
   * never an earlier step's, the repository's or the global value.
   */
  complete?: true;
}

/** The provider, model and reasoning level an agent spawns with: `settings` over the repository's, over the global defaults. */
export function resolveAgent(settings: AgentSettings | undefined, repo: AgentSettings, defaults: { providerId?: string; model?: string }): AgentSettings {
  if (settings?.complete) return { providerId: settings.providerId, model: settings.model, reasoningLevel: settings.reasoningLevel };
  return {
    providerId: settings?.providerId || repo.providerId || defaults.providerId || undefined,
    model: settings?.model || repo.model || defaults.model || undefined,
    reasoningLevel: settings?.reasoningLevel || repo.reasoningLevel || undefined,
  };
}

export const workflowSchema = z.object({ id: stepId, name: z.string().min(1).max(80), steps: z.array(stepSchema).min(1) });
export type Workflow = z.output<typeof workflowSchema>;

export const workflowsDocumentSchema = z.object({ workflows: z.array(workflowSchema).min(1), default: stepId });
export type WorkflowsDocument = z.output<typeof workflowsDocumentSchema>;

// ---------- defaults ----------

export const DEFAULT_INSTRUCTIONS = {
  plan: "Investigate the codebase and write an implementation plan: the approach, the files you will change, risks and open questions, and how you will test it.",
  build: "Implement the task following the plan. Add or update tests for what you change.",
  verify: "Verify the change does what the task asks. Exercise it the way a user would and collect evidence (commands and output, screenshots, logs). Fail with what is broken.",
  review:
    "Review the changes on this branch against the task: correctness, edge cases, tests, and the repository's conventions. Pass if it is ready. Fail with a numbered list of concrete findings (file:line) that must change.",
};

export const DEFAULT_WORKFLOW: Workflow = workflowSchema.parse({
  id: "default",
  name: "Plan, build, review, ship",
  steps: [
    { id: "plan", name: "Plan", type: "agent", instructions: DEFAULT_INSTRUCTIONS.plan, approval: true, next: ["build"] },
    { id: "build", name: "Build", type: "agent", writes: true, instructions: DEFAULT_INSTRUCTIONS.build, next: ["review"] },
    { id: "review", name: "Review", type: "agent", verdict: true, onFail: "build", instructions: DEFAULT_INSTRUCTIONS.review, next: ["ship"] },
    { id: "ship", name: "Ship", type: "ship", action: "pr", onFail: "build" },
  ],
});

export const DEFAULT_DOCUMENT: WorkflowsDocument = { workflows: [DEFAULT_WORKFLOW], default: DEFAULT_WORKFLOW.id };

// ---------- graph helpers ----------

export function stepById(wf: Workflow, id: string): Step | undefined {
  return wf.steps.find((s) => s.id === id);
}

/** Steps with an edge into `id`. */
export function predecessors(wf: Workflow, id: string): string[] {
  return wf.steps.filter((s) => s.next.includes(id)).map((s) => s.id);
}

/** `id` and every step reachable from it through `next`. */
export function descendants(wf: Workflow, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of stepById(wf, cur)?.next ?? []) stack.push(n);
  }
  return seen;
}

export function reachable(wf: Workflow, from: string, to: string): boolean {
  return from !== to && descendants(wf, from).has(to);
}

/** Steps nothing points at. */
export function entrySteps(wf: Workflow): string[] {
  const targets = new Set(wf.steps.flatMap((s) => s.next));
  return wf.steps.filter((s) => !targets.has(s.id)).map((s) => s.id);
}

/** Steps that point at nothing: the task is done when all of them are. */
export function finalSteps(wf: Workflow): string[] {
  return wf.steps.filter((s) => !s.next.length).map((s) => s.id);
}

/** Longest-path depth of each step (0 for entries); parallel steps share a depth. */
export function depths(wf: Workflow): Map<string, number> {
  const depth = new Map<string, number>();
  const order = topoOrder(wf);
  for (const id of order) {
    const d = Math.max(-1, ...predecessors(wf, id).map((p) => depth.get(p) ?? 0)) + 1;
    depth.set(id, d);
  }
  return depth;
}

/** Topological order of the `next` graph (input order breaks ties); cyclic leftovers appended. */
export function topoOrder(wf: Workflow): string[] {
  const indeg = new Map(wf.steps.map((s) => [s.id, 0]));
  for (const s of wf.steps) for (const n of s.next) if (indeg.has(n)) indeg.set(n, indeg.get(n)! + 1);
  const queue = wf.steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const n of stepById(wf, id)?.next ?? []) {
      if (!indeg.has(n)) continue;
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  for (const s of wf.steps) if (!out.includes(s.id)) out.push(s.id);
  return out;
}

/** A report's pick on an automatic model step: what the agent chose. */
export interface ModelPick {
  providerId?: string | null;
  model?: string | null;
  reasoningLevel?: string | null;
}
type ReportLike = { choice?: string | null; pick?: ModelPick | null } | null;

/**
 * The pick an automatic model step's report named. A pick needs a provider and
 * a model (a reasoning level is optional); anything less is no pick.
 */
export function pickedModel(node: { reports: ReportLike[] } | undefined): AgentSettings | undefined {
  for (const r of node?.reports ?? []) {
    const providerId = r?.pick?.providerId?.trim();
    const model = r?.pick?.model?.trim();
    const reasoningLevel = r?.pick?.reasoningLevel?.trim();
    if (providerId && model) return { providerId, model, ...(reasoningLevel ? { reasoningLevel } : {}) };
  }
  return undefined;
}

/** "claude-code · claude-opus-5-5 · high", or null for nothing set. */
export function describePick(settings: AgentSettings | undefined): string | null {
  return [settings?.providerId, settings?.model, settings?.reasoningLevel].filter(Boolean).join(" · ") || null;
}

/** Steps that use the task's worktree exclusively: code-writing agents, checks, ship. */
export function isExclusive(step: Step): boolean {
  return step.type === "agent" ? step.writes : step.type !== "model";
}

/** The choice an agent step's report named, when it has choices and one of its reports names a valid one. */
export function chosenModel(step: AgentStep, node: { reports: ReportLike[] } | undefined): ModelChoice | undefined {
  if (!step.chooses.length || !node) return undefined;
  for (const r of node.reports) {
    const found = r?.choice ? step.chooses.find((c) => c.id === r.choice!.trim()) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * The settings set by the model steps (fixed, or picked by an automatic one's agent) and model choices of agent steps before `id`. Model steps apply to
 * everything after them until a later one overrides a field, so the last one
 * before `id` (in topological order, among its ancestors) wins, field by field.
 * An automatic step's pick is the exception: it replaces all three fields and
 * marks the result `complete`, so nothing from before it leaks in.
 */
export function settingsFor(wf: Workflow, id: string, nodes?: Record<string, { reports: ReportLike[] }>): AgentSettings {
  const before = new Set(wf.steps.filter((s) => reachable(wf, s.id, id)).map((s) => s.id));
  let out: AgentSettings = {};
  for (const sid of topoOrder(wf)) {
    const s = stepById(wf, sid);
    if (!s || !before.has(sid)) continue;
    if (s.type === "model" && modelMode(s) === "auto") {
      // A pick replaces everything set before it, as a whole.
      const pick = pickedModel(nodes?.[sid]);
      if (pick) out = { ...pick, complete: true };
      continue;
    }
    const source = s.type === "model" ? s : s.type === "agent" ? chosenModel(s, nodes?.[sid]) : undefined;
    if (!source) continue;
    for (const key of ["providerId", "model", "reasoningLevel"] as const) {
      const value = source[key]?.trim();
      if (value) out[key] = value;
    }
  }
  return out;
}

/** Problems that make a workflow unrunnable, as human-readable messages. */
export function validateWorkflow(wf: Workflow): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of wf.steps) {
    if (ids.has(s.id)) problems.push(`two steps have the id "${s.id}"`);
    ids.add(s.id);
  }
  const name = (id: string) => stepById(wf, id)?.name ?? id;
  for (const s of wf.steps) {
    for (const n of s.next) {
      if (n === s.id) problems.push(`${s.name} points at itself`);
      else if (!ids.has(n)) problems.push(`${s.name} points at a missing step "${n}"`);
    }
  }
  if (topoOrder(wf).some((id, i, order) => predecessors(wf, id).some((p) => order.indexOf(p) > i))) {
    problems.push("the arrows form a loop; use “on fail” to go back to an earlier step");
  }
  for (const s of wf.steps) {
    if (s.type === "agent" && s.writes && s.agents > 1) problems.push(`${s.name}: only read-only steps can run several agents`);
    if (s.type === "agent" && s.onFail && !s.verdict) problems.push(`${s.name}: “on fail” needs the pass/fail verdict switched on`);
    if (s.onFail) {
      if (!ids.has(s.onFail)) problems.push(`${s.name}: on fail goes to a missing step "${s.onFail}"`);
      else if (s.onFail !== s.id && !reachable(wf, s.onFail, s.id)) problems.push(`${s.name}: on fail must go back to a step before it (${name(s.onFail)} is not)`);
    }
    if (s.type === "agent" && s.chooses.length) {
      const seen = new Set<string>();
      for (const c of s.chooses) {
        if (seen.has(c.id)) problems.push(`${s.name}: two model choices have the id "${c.id}"`);
        seen.add(c.id);
        if (!c.providerId?.trim() && !c.model?.trim() && !c.reasoningLevel?.trim()) problems.push(`${s.name}: model choice "${c.id}" sets nothing`);
      }
    }
    if (s.type === "model" && modelMode(s) === "fixed" && !s.providerId?.trim() && !s.model?.trim() && !s.reasoningLevel?.trim()) problems.push(`${s.name}: set a provider, a model or a reasoning level`);
    if (s.type !== "agent" && s.type !== "model") {
      const writerBefore = wf.steps.some((w) => w.type === "agent" && w.writes && reachable(wf, w.id, s.id));
      if (!writerBefore) problems.push(`${s.name}: needs a step that writes code before it`);
    }
  }
  // Steps sharing the worktree exclusively must run one after the other.
  const exclusive = wf.steps.filter(isExclusive);
  for (let i = 0; i < exclusive.length; i++) {
    for (let j = i + 1; j < exclusive.length; j++) {
      const a = exclusive[i]!;
      const b = exclusive[j]!;
      if (!reachable(wf, a.id, b.id) && !reachable(wf, b.id, a.id)) problems.push(`${a.name} and ${b.name} could run at the same time, but both change the worktree; connect one after the other`);
    }
  }
  return [...new Set(problems)];
}

/** Problems with the whole document (unique workflow ids, a valid default). */
export function validateDocument(doc: WorkflowsDocument): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const wf of doc.workflows) {
    if (seen.has(wf.id)) problems.push(`two workflows have the id "${wf.id}"`);
    seen.add(wf.id);
    for (const p of validateWorkflow(wf)) problems.push(`${wf.name}: ${p}`);
  }
  if (!seen.has(doc.default)) problems.push(`the default workflow "${doc.default}" does not exist`);
  return problems;
}

// ---------- the stage config from before custom workflows ----------

const legacyStages = z.object({
  plan: z.object({ enabled: z.boolean(), instructions: z.string(), requireApproval: z.boolean() }).partial().optional(),
  build: z.object({ instructions: z.string() }).partial().optional(),
  verify: z.object({ enabled: z.boolean(), instructions: z.string(), command: z.string(), timeoutMinutes: z.number(), maxAttempts: z.number() }).partial().optional(),
  review: z.object({ enabled: z.boolean(), instructions: z.string(), mode: z.string(), maxRounds: z.number() }).partial().optional(),
  ship: z.object({ enabled: z.boolean(), instructions: z.string(), action: z.enum(["push", "pr", "merge"]), draft: z.boolean(), maxCiFixes: z.number(), requireApproval: z.boolean() }).partial().optional(),
});
export type LegacyStages = z.output<typeof legacyStages>;
export const legacyStagesSchema = legacyStages;

const join = (...parts: (string | undefined)[]) => parts.filter((p) => p && p.trim()).join("\n\n");

/** Turn the fixed-stage config into an equivalent workflow. */
export function fromStages(stages: LegacyStages, id = "default", name = "Plan, build, verify, review, ship"): Workflow {
  const steps: Record<string, unknown>[] = [];
  const on = (s: { enabled?: boolean } | undefined) => s?.enabled !== false;
  if (on(stages.plan)) steps.push({ id: "plan", name: "Plan", type: "agent", instructions: join(DEFAULT_INSTRUCTIONS.plan, stages.plan?.instructions), approval: stages.plan?.requireApproval !== false });
  steps.push({ id: "build", name: "Build", type: "agent", writes: true, instructions: join(DEFAULT_INSTRUCTIONS.build, stages.build?.instructions) });
  if (on(stages.verify) && stages.verify?.command?.trim()) {
    steps.push({ id: "verify", name: "Verify", type: "check", command: stages.verify.command.trim(), timeoutMinutes: clamp(stages.verify.timeoutMinutes ?? 30, 1, 240), onFail: "build", maxAttempts: clamp(stages.verify.maxAttempts ?? 2, 0, 10) });
  }
  if (on(stages.verify) && stages.verify?.instructions?.trim()) {
    steps.push({ id: "verify-agent", name: "Verify by hand", type: "agent", verdict: true, onFail: "build", instructions: join(DEFAULT_INSTRUCTIONS.verify, stages.verify.instructions), maxRounds: clamp(stages.verify.maxAttempts ?? 2, 0, 10) });
  }
  if (on(stages.review)) steps.push({ id: "review", name: "Review", type: "agent", verdict: true, onFail: "build", instructions: join(DEFAULT_INSTRUCTIONS.review, stages.review?.instructions), maxRounds: clamp(stages.review?.maxRounds ?? 2, 0, 10) });
  if (on(stages.ship)) {
    steps.push({ id: "ship", name: "Ship", type: "ship", action: stages.ship?.action ?? "pr", draft: stages.ship?.draft ?? false, requireApproval: stages.ship?.requireApproval ?? true, onFail: "build", maxAttempts: clamp(stages.ship?.maxCiFixes ?? 2, 0, 10) });
  }
  steps.forEach((s, i) => {
    if (steps[i + 1]) s.next = [steps[i + 1]!.id as string];
  });
  return workflowSchema.parse({ id, name, steps });
}

/** Merge a repo's stage overrides over the global stage config, field by field. */
export function mergeStages(global: LegacyStages, override: LegacyStages): LegacyStages {
  const out: Record<string, unknown> = { ...global };
  for (const [k, v] of Object.entries(override)) out[k] = { ...((global as Record<string, object | undefined>)[k] ?? {}), ...(v ?? {}) };
  return out as LegacyStages;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// ---------- the setting ----------

export type ParsedWorkflows = { ok: true; value: WorkflowsDocument; legacy: LegacyStages | null; warnings: string[] } | { ok: false; error: string };

/**
 * Parse the `workflow` setting. Accepts the current document
 * (`{workflows:[...], default}`), the stage config from before custom
 * workflows (`{workflow:{plan,build,...}}`, converted), or empty (defaults).
 */
export function parseWorkflows(raw: string): ParsedWorkflows {
  const text = raw.trim();
  if (!text) return { ok: true, value: DEFAULT_DOCUMENT, legacy: null, warnings: [] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const obj = (json ?? {}) as Record<string, unknown>;
  if (!("workflows" in obj) && "workflow" in obj) {
    const legacy = legacyStages.safeParse(obj.workflow ?? {});
    if (!legacy.success) return { ok: false, error: issues(legacy.error) };
    return { ok: true, value: { workflows: [fromStages(legacy.data)], default: "default" }, legacy: legacy.data, warnings: ["workflow setting uses the old stage format; it was converted"] };
  }
  const parsed = workflowsDocumentSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: issues(parsed.error) };
  const problems = validateDocument(parsed.data);
  if (problems.length) return { ok: false, error: problems.join("; ") };
  return { ok: true, value: { ...parsed.data, workflows: parsed.data.workflows.map(withModelModes) }, legacy: null, warnings: [] };
}

/**
 * A work item's stored workflow snapshot, with the defaults of fields added
 * since it was taken (e.g. `chooses`). Items keep the workflow they started
 * with across plugin updates, so code must never meet a step missing a field
 * its schema defaults, even in a step that no longer parses.
 */
export function normalizeWorkflow(raw: Workflow): Workflow {
  if (!raw || !Array.isArray(raw.steps)) return raw;
  return withModelModes({ ...raw, steps: raw.steps.map(normalizeStep) });
}

/**
 * Write down the mode of model steps saved before modes existed (inferred by
 * `modelMode`), so editing their fields can no longer change what they are:
 * clearing the last value of a fixed step must not make it automatic.
 */
export function withModelModes(wf: Workflow): Workflow {
  if (!wf.steps.some((s) => s && s.type === "model" && !s.mode)) return wf;
  return { ...wf, steps: wf.steps.map((s) => (s && s.type === "model" && !s.mode ? { ...s, mode: modelMode(s) } : s)) };
}

const STEP_SCHEMAS: Record<string, z.ZodObject> = {
  agent: agentStepSchema,
  check: checkStepSchema,
  ship: shipStepSchema,
  model: modelStepSchema,
};

const jsType = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/**
 * A stored step, parsed by its schema; one that no longer parses (e.g. a limit
 * changed since it was saved) is repaired field by field rather than kept as
 * stored, so code never meets a missing or wrongly typed field. A field whose
 * value is missing or of the wrong type gets its schema default, an invalid
 * optional field is dropped, and array entries that no longer parse are
 * dropped. Values of the right type that break a limit (a long instruction)
 * are kept. Required fields without a default (id, name, command) are kept
 * as stored. Never mutates the input.
 */
function normalizeStep(s: Workflow["steps"][number]): Workflow["steps"][number] {
  if (!s || typeof s !== "object") return s;
  const parsed = stepSchema.safeParse(s);
  if (parsed.success) return parsed.data;
  const out: Record<string, unknown> = { ...(s as Record<string, unknown>) };
  const shape = STEP_SCHEMAS[String(out.type)]?.shape ?? { next: base.next };
  for (const [key, field] of Object.entries(shape) as [string, z.ZodType][]) {
    const own = field.safeParse(out[key]);
    if (own.success) {
      if (own.data !== undefined) out[key] = own.data;
      continue;
    }
    const fallback = field.safeParse(undefined);
    if (!fallback.success) continue; // required (id, name, command): kept as stored
    const value = out[key];
    if (fallback.data === undefined) {
      delete out[key]; // optional (onFail, position, model, ...): an invalid value is dropped
      continue;
    }
    if (Array.isArray(value) && Array.isArray(fallback.data)) {
      const element = arrayElement(field);
      out[key] = element ? value.filter((v) => element.safeParse(v).success) : fallback.data;
    } else if (jsType(value) !== jsType(fallback.data)) {
      out[key] = fallback.data;
    }
  }
  const retry = stepSchema.safeParse(out);
  return (retry.success ? retry.data : out) as Workflow["steps"][number];
}

/** The element schema of a (defaulted) array field. */
function arrayElement(field: z.ZodType): z.ZodType | undefined {
  const inner = field instanceof z.ZodDefault ? field.unwrap() : field;
  return inner instanceof z.ZodArray ? (inner.element as z.ZodType) : undefined;
}

export function serializeWorkflows(doc: WorkflowsDocument): string {
  return JSON.stringify(doc, null, 2);
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`).join("; ");
}

/** A fresh, unused step id based on a name. */
export function newStepId(wf: Workflow, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "step";
  let id = base;
  for (let n = 2; wf.steps.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return id;
}

/** A new step of a type with sensible defaults. */
export function blankStep(type: StepType, id: string, name: string): Step {
  switch (type) {
    case "agent":
      return agentStepSchema.parse({ id, name, type });
    case "check":
      return checkStepSchema.parse({ id, name, type, command: "npm test" });
    case "ship":
      return shipStepSchema.parse({ id, name, type });
    case "model":
      return modelStepSchema.parse({ id, name, type, mode: "auto", instructions: DEFAULT_MODEL_INSTRUCTIONS });
  }
}
