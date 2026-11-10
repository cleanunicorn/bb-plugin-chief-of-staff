import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, deriveStatus, initialNodes, transition, type Effect, type MachineEvent, type StepReport } from "../src/machine";
import type { WorkItem } from "../src/state";
import { DEFAULT_MODEL_INSTRUCTIONS, DEFAULT_WORKFLOW, agentWork, blankStep, fromStages, modelMode, normalizeWorkflow, parseWorkflows, resolveAgent, settingsFor, validateWorkflow, workflowSchema, type AgentStep, type ModelStep, type Workflow } from "../src/workflow";
import { parseTextReport } from "../src/report";
import { pipelineLine, stepPrompt } from "../src/prompts";

const NOW = new Date("2026-11-07T10:00:00.000Z");

function itemFor(workflow: Workflow, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w1",
    repo: "acme/app",
    issueNumber: 12,
    issueTitle: "Fix login",
    threadId: null,
    environmentId: null,
    branch: "cos/issue-12-fix-login",
    prNumber: null,
    prUrl: null,
    status: "queued",
    providerId: null,
    model: null,
    fixAttempts: 0,
    retryCount: 0,
    lastError: null,
    source: "intake",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastActivityAt: null,
    finishedAt: null,
    waitingReason: null,
    waitingKind: null,
    jobStartedAt: null,
    taskBody: null,
    workflow,
    nodes: initialNodes(workflow),
    ...over,
  };
}

const report = (outcome: StepReport["outcome"] = "done", summary = "ok"): StepReport => ({ outcome, summary, at: NOW.toISOString(), via: "tool" });

/** Apply an event the way the dispatcher does; returns the new item and the effects. */
function run(item: WorkItem, event: MachineEvent): [WorkItem, Effect[]] {
  const t = transition(item, event, DEFAULT_POLICY, NOW);
  const explicit = "status" in t.patch ? t.patch.status : item.status;
  const derived = deriveStatus({ status: explicit === "failed" ? "failed" : "queued", workflow: item.workflow }, t.nodes);
  const status = explicit === "failed" ? "failed" : t.patch.status === "done" ? "done" : derived.status;
  return [{ ...item, ...t.patch, nodes: t.nodes, status, waitingKind: derived.waitingKind, waitingReason: derived.waitingReason }, t.effects];
}
const ended = (step: string, r: StepReport | null, item: WorkItem, agent = 0, question: string | null = null): MachineEvent => ({ type: "turn_ended", step, agent, round: item.nodes[step]!.round, report: r, question });
const agentFx = (e: Effect[]) => e.filter((x) => x.type === "agent");
const st = (item: WorkItem) => Object.fromEntries(Object.entries(item.nodes).map(([k, v]) => [k, v.status]));

const wf = (steps: unknown[]) => workflowSchema.parse({ id: "t", name: "Test", steps });

describe("workflow definition", () => {
  it("ships a valid default: Plan (approval) → Build → Review (verdict) → Ship", () => {
    expect(validateWorkflow(DEFAULT_WORKFLOW)).toEqual([]);
    expect(pipelineLine(DEFAULT_WORKFLOW, "build")).toBe("Plan → **Build** → Review → Ship");
  });

  it("rejects loops, parallel writers, bad back-jumps, checks without a writer, and writing fan-out", () => {
    const loop = wf([
      { id: "a", name: "A", type: "agent", writes: true, next: ["b"] },
      { id: "b", name: "B", type: "agent", next: ["a"] },
    ]);
    expect(validateWorkflow(loop).join(" ")).toMatch(/loop/);
    const parallelWriters = wf([
      { id: "p", name: "P", type: "agent", next: ["a", "b"] },
      { id: "a", name: "A", type: "agent", writes: true },
      { id: "b", name: "B", type: "agent", writes: true },
    ]);
    expect(validateWorkflow(parallelWriters).join(" ")).toMatch(/A and B could run at the same time/);
    const badJump = wf([
      { id: "a", name: "A", type: "agent", writes: true, next: ["b"] },
      { id: "b", name: "B", type: "agent", verdict: true, onFail: "c", next: ["c"] },
      { id: "c", name: "C", type: "agent" },
    ]);
    expect(validateWorkflow(badJump).join(" ")).toMatch(/must go back to a step before it/);
    const noWriter = wf([{ id: "c", name: "Tests", type: "check", command: "npm test" }]);
    expect(validateWorkflow(noWriter).join(" ")).toMatch(/needs a step that writes code before it/);
    const many = wf([{ id: "a", name: "A", type: "agent", writes: true, agents: 2 }]);
    expect(validateWorkflow(many).join(" ")).toMatch(/only read-only steps can run several agents/);
  });

  it("converts the stage config from before custom workflows", () => {
    const converted = fromStages({ plan: { requireApproval: false }, verify: { command: "npm test", maxAttempts: 3 }, review: { enabled: false }, ship: { action: "merge" } });
    expect(converted.steps.map((s) => s.id)).toEqual(["plan", "build", "verify", "ship"]);
    expect(converted.steps[0]).toMatchObject({ type: "agent", approval: false, next: ["build"] });
    expect(converted.steps[2]).toMatchObject({ type: "check", command: "npm test", onFail: "build", maxAttempts: 3 });
    expect(converted.steps[3]).toMatchObject({ type: "ship", action: "merge" });
    expect(validateWorkflow(converted)).toEqual([]);
    const parsed = parseWorkflows(JSON.stringify({ workflow: { review: { enabled: false } } }));
    expect(parsed.ok && parsed.value.workflows[0]!.steps.map((s) => s.id)).toEqual(["plan", "build", "ship"]);
    expect(parseWorkflows("").ok).toBe(true);
    expect(parseWorkflows(JSON.stringify({ workflows: [loop()], default: "t" })).ok).toBe(false);
  });
});

function loop() {
  return { id: "t", name: "T", steps: [{ id: "a", name: "A", type: "agent", writes: true, next: ["a"] }] };
}

describe("workflow engine", () => {
  it("walks the default workflow to an open PR", () => {
    let item = itemFor(DEFAULT_WORKFLOW);
    let fx: Effect[];
    [item, fx] = run(item, { type: "start" });
    expect(agentFx(fx)).toEqual([{ type: "agent", step: "plan", agent: 0, kind: "start" }]);
    expect(item.status).toBe("agent");

    [item, fx] = run(item, ended("plan", report("done", "1. patch auth.ts"), item));
    expect([item.status, item.waitingKind]).toEqual(["waiting_on_human", "approval"]);
    expect(fx[0]).toMatchObject({ type: "notify" });

    [item, fx] = run(item, { type: "approve" });
    expect(st(item)).toMatchObject({ plan: "done", build: "running" });
    expect(agentFx(fx)).toEqual([{ type: "agent", step: "build", agent: 0, kind: "start" }]);

    [item, fx] = run(item, ended("build", report(), item));
    expect(agentFx(fx)).toEqual([{ type: "agent", step: "review", agent: 0, kind: "start" }]);

    [item, fx] = run(item, ended("review", report("done", "LGTM"), item));
    expect(fx).toEqual([{ type: "ship", step: "ship" }]);
    expect([item.status, item.jobStartedAt]).toEqual(["cos", NOW.toISOString()]);

    [item] = run(item, { type: "pr_opened", step: "ship", prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" });
    expect([item.status, item.prNumber]).toEqual(["done", 7]);
    expect(item.finishedAt).toBe(NOW.toISOString());
    [item, fx] = run(item, { type: "pr_opened", step: "ship", prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" });
    expect(fx).toEqual([]);
    [item, fx] = run(item, { type: "ci_failing", log: "late failure" });
    expect(item.status).toBe("done");
    expect(fx).toEqual([]);
  });

  it("runs parallel read-only agents and joins before the next step", () => {
    const w = wf([
      { id: "plan", name: "Plan", type: "agent", agents: 2, next: ["build"] },
      { id: "build", name: "Build", type: "agent", writes: true },
    ]);
    let item = itemFor(w);
    let fx: Effect[];
    [item, fx] = run(item, { type: "start" });
    expect(agentFx(fx)).toEqual([
      { type: "agent", step: "plan", agent: 0, kind: "start" },
      { type: "agent", step: "plan", agent: 1, kind: "start" },
    ]);
    [item, fx] = run(item, ended("plan", report("done", "plan A"), item, 1));
    expect([st(item).plan, fx]).toEqual(["running", []]);
    // The same agent reporting twice counts once.
    [item] = run(item, ended("plan", report("done", "again"), item, 1));
    expect(item.nodes.plan!.reports.filter(Boolean)).toHaveLength(1);
    [item] = run(item, ended("plan", report("done", "plan B"), item, 0));
    expect(st(item)).toEqual({ plan: "done", build: "running" });
  });

  it("fans out to parallel steps and waits for all of them (join)", () => {
    const w = wf([
      { id: "build", name: "Build", type: "agent", writes: true, next: ["review", "docs"] },
      { id: "review", name: "Review", type: "agent", verdict: true, onFail: "build", next: ["ship"] },
      { id: "docs", name: "Docs check", type: "agent", next: ["ship"] },
      { id: "ship", name: "Ship", type: "ship" },
    ]);
    expect(validateWorkflow(w)).toEqual([]);
    expect(pipelineLine(w)).toBe("Build → (Review ∥ Docs check) → Ship");
    let item = itemFor(w);
    let fx: Effect[];
    [item] = run(item, { type: "start" });
    [item, fx] = run(item, ended("build", report(), item));
    expect(agentFx(fx).map((e) => (e as { step: string }).step)).toEqual(["review", "docs"]);
    [item, fx] = run(item, ended("review", report(), item));
    expect([st(item).ship, fx]).toEqual(["pending", []]);
    [, fx] = run(item, ended("docs", report(), item));
    expect(fx).toEqual([{ type: "ship", step: "ship" }]);
  });

  it("loops a failing verdict back with the findings, then escalates past its limit", () => {
    const w = wf([
      { id: "build", name: "Build", type: "agent", writes: true, next: ["review"] },
      { id: "review", name: "Review", type: "agent", verdict: true, onFail: "build", maxRounds: 1 },
    ]);
    let item = itemFor(w);
    let fx: Effect[];
    [item] = run(item, { type: "start" });
    [item] = run(item, ended("build", report(), item));
    [item, fx] = run(item, ended("review", report("failed", "1. auth.ts:12 null case"), item));
    expect(st(item)).toEqual({ build: "running", review: "pending" });
    expect(item.nodes.build!.feedback).toContain("auth.ts:12 null case");
    expect(item.nodes.build!.round).toBe(2);
    expect(agentFx(fx)).toEqual([{ type: "agent", step: "build", agent: 0, kind: "start" }]);
    [item] = run(item, ended("build", report(), item));
    expect(item.nodes.build!.feedback).toBeNull();
    [item] = run(item, ended("review", report("failed", "still broken"), item));
    expect([item.status, item.waitingKind, item.nodes.review!.attempts]).toEqual(["waiting_on_human", "escalation", 2]);
    // Send it back with instructions: budget resets, re-run from build with the feedback.
    [item] = run(item, { type: "revise", feedback: "use the session store" });
    expect([st(item).build, item.nodes.review!.attempts]).toEqual(["running", 0]);
    expect(item.nodes.build!.feedback).toContain("use the session store");
  });

  it("ignores reports from an older round", () => {
    const w = wf([
      { id: "build", name: "Build", type: "agent", writes: true, next: ["r1", "r2"] },
      { id: "r1", name: "R1", type: "agent", verdict: true, onFail: "build" },
      { id: "r2", name: "R2", type: "agent" },
    ]);
    let item = itemFor(w);
    [item] = run(item, { type: "start" });
    [item] = run(item, ended("build", report(), item));
    const staleRound = item.nodes.r2!.round;
    [item] = run(item, ended("r1", report("failed", "nope"), item)); // resets build, r1, r2
    [item] = run(item, { type: "turn_ended", step: "r2", agent: 0, round: staleRound, report: report(), question: null });
    expect(st(item)).toEqual({ build: "running", r1: "pending", r2: "pending" });
  });

  it("feeds a failing check back, and escalates when there is nowhere to go back to", () => {
    const w = wf([
      { id: "build", name: "Build", type: "agent", writes: true, next: ["test"] },
      { id: "test", name: "Tests", type: "check", command: "npm test", onFail: "build", maxAttempts: 1, next: ["lint"] },
      { id: "lint", name: "Lint", type: "check", command: "npm run lint" },
    ]);
    let item = itemFor(w);
    let fx: Effect[];
    [item] = run(item, { type: "start" });
    [item, fx] = run(item, ended("build", report(), item));
    expect(fx).toEqual([{ type: "check", step: "test" }]);
    [item] = run(item, { type: "check_result", step: "test", ok: false, output: "1 failing" });
    expect([st(item).build, item.nodes.build!.feedback]).toEqual(["running", "Tests failed:\n\n1 failing"]);
    [item] = run(item, ended("build", report(), item));
    [item, fx] = run(item, { type: "check_result", step: "test", ok: true, output: "ok" });
    expect(fx).toEqual([{ type: "check", step: "lint" }]);
    [item] = run(item, { type: "check_result", step: "lint", ok: false, output: "lint error" });
    expect([item.status, item.waitingKind]).toEqual(["waiting_on_human", "escalation"]);
    [item] = run(item, { type: "approve" });
    expect(item.status).toBe("done");
  });

  it("sends red CI back to its onFail step and ships again to the same PR", () => {
    let item = itemFor(DEFAULT_WORKFLOW);
    const done = (id: string) => ({ ...item.nodes[id]!, status: "done" as const, round: 1 });
    item = { ...item, prNumber: 7, nodes: { plan: done("plan"), build: done("build"), review: done("review"), ship: { ...item.nodes.ship!, status: "running", round: 1, phase: "ci" } } };
    let fx: Effect[];
    [item, fx] = run(item, { type: "ci_failing", log: "lint failed" });
    expect(st(item)).toEqual({ plan: "done", build: "running", review: "pending", ship: "pending" });
    expect(agentFx(fx)).toHaveLength(1);
    expect(item.nodes.ship!.attempts).toBe(1);
  });

  it("nudges an agent that stops without reporting, then asks a person", () => {
    let item = itemFor(DEFAULT_WORKFLOW);
    let fx: Effect[];
    [item] = run(item, { type: "start" });
    [item, fx] = run(item, ended("plan", null, item));
    expect(fx).toEqual([{ type: "agent", step: "plan", agent: 0, kind: "nudge" }]);
    [item] = run(item, ended("plan", null, item));
    [item] = run(item, ended("plan", null, item));
    expect([item.status, item.waitingKind]).toEqual(["waiting_on_human", "no_report"]);
    // The thread starts a turn again (someone talked to it): back to running.
    [item] = run(item, { type: "turn_started", step: "plan", agent: 0 });
    expect(item.status).toBe("agent");
  });

  it("parks on questions; approve does not skip them", () => {
    let item = itemFor(DEFAULT_WORKFLOW);
    [item] = run(item, { type: "start" });
    [item] = run(item, ended("plan", null, item, 0, "Question: which DB?"));
    expect([item.waitingKind, item.waitingReason]).toEqual(["question", "Plan: Question: which DB?"]);
    [item] = run(item, { type: "approve" });
    expect(item.waitingKind).toBe("question");
    [item] = run(item, { type: "turn_started", step: "plan", agent: 0 });
    [item] = run(item, ended("plan", { ...report("needs_input"), question: "Keep v1?" }, item));
    expect([item.waitingKind, item.waitingReason]).toEqual(["question", "Plan: Keep v1?"]);
  });

  it("retries infrastructure errors with backoff, then asks for help, then re-runs the effect", () => {
    const w = wf([
      { id: "build", name: "Build", type: "agent", writes: true, next: ["test"] },
      { id: "test", name: "Tests", type: "check", command: "npm test" },
    ]);
    let item = itemFor(w);
    let fx: Effect[];
    [item] = run(item, { type: "start" });
    [item] = run(item, ended("build", report(), item));
    const effect: Effect = { type: "check", step: "test" };
    for (let n = 1; n <= 3; n++) {
      [item] = run(item, { type: "effect_error", step: "test", effect, message: "deadline exceeded" });
      expect([item.status, item.nodes.test!.retry!.count]).toEqual(["retrying", n]);
      expect(Date.parse(item.nodes.test!.retry!.at!) - NOW.getTime()).toBe(n * n * 60_000);
      [item, fx] = run(item, { type: "retry_due", step: "test" });
      expect(fx).toEqual([effect]);
    }
    [item] = run(item, { type: "effect_error", step: "test", effect, message: "deadline exceeded" });
    expect([item.status, item.waitingKind]).toEqual(["waiting_on_human", "cos_error"]);
    expect(item.waitingReason).toContain("the agent is not asking anything");
    [item, fx] = run(item, { type: "retry" });
    expect([item.status, fx]).toEqual(["cos", [effect]]);
  });

  it("fails the item when the builder dies, and retry restarts the writer in a fresh thread", () => {
    let item = itemFor(DEFAULT_WORKFLOW, { status: "agent", threadId: "thr_1" });
    item = { ...item, nodes: { ...item.nodes, plan: { ...item.nodes.plan!, status: "done", round: 1 }, build: { ...item.nodes.build!, status: "running", round: 1 } } };
    [item] = run(item, { type: "thread_failed", step: null, agent: 0, error: "provider crashed" });
    expect(item.status).toBe("failed");
    let fx: Effect[];
    [item, fx] = run(item, { type: "retry" });
    expect(item.status).toBe("agent");
    expect(agentFx(fx)).toEqual([{ type: "agent", step: "build", agent: 0, kind: "start", fresh: true }]);
  });

  it("keeps watching an open PR when a ship escalation is approved, and merges when configured", () => {
    const w = wf([
      { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
      { id: "ship", name: "Ship", type: "ship", action: "merge", onFail: "build", maxAttempts: 0 },
    ]);
    let item = itemFor(w, { prNumber: 7 });
    item = { ...item, nodes: { build: { ...item.nodes.build!, status: "done", round: 1 }, ship: { ...item.nodes.ship!, status: "running", round: 1, phase: "ci" } } };
    let fx: Effect[];
    [item, fx] = run(item, { type: "ci_passing" });
    expect([item.status, fx]).toEqual(["cos", [{ type: "merge", step: "ship" }]]);
    [item] = run(item, { type: "merge_waiting", reason: "Waiting for an approving review" });
    expect([item.status, item.lastError]).toEqual(["ready", "Waiting for an approving review"]);
    [item] = run(item, { type: "ci_failing", log: "red" });
    expect(item.waitingKind).toBe("escalation");
    [item] = run(item, { type: "approve" });
    expect([item.status, item.nodes.ship!.phase]).toEqual(["ready", "ready"]);
  });

  it("re-runs a chosen step and everything after it", () => {
    let item = itemFor(DEFAULT_WORKFLOW);
    const done = (id: string) => ({ ...item.nodes[id]!, status: "done" as const, round: 1 });
    item = { ...item, nodes: { plan: done("plan"), build: done("build"), review: { ...item.nodes.review!, status: "running", round: 1 }, ship: item.nodes.ship! } };
    const [after, fx] = run(item, { type: "rerun", step: "build", feedback: "rename the flag" });
    expect(st(after)).toEqual({ plan: "done", build: "running", review: "pending", ship: "pending" });
    expect(after.nodes.build!.feedback).toContain("rename the flag");
    expect(agentFx(fx)).toHaveLength(1);
  });
});

describe("text step reports", () => {
  it("parses a trailing Step report block", () => {
    const text = "Did the thing.\n\n## Step report\nstep: build\noutcome: done\nsummary: Changed auth.ts\nand added a test";
    expect(parseTextReport(text, "t")).toEqual({ step: "build", outcome: "done", summary: "Changed auth.ts\nand added a test", question: null, at: "t", via: "text" });
  });

  it("accepts legacy and loose variants", () => {
    const text = "## Stage report\n```\n- **stage**: review\n- **outcome**: Changes requested\n- **summary**: 1. fix x\n```";
    expect(parseTextReport(text, "t")).toMatchObject({ step: "review", outcome: "failed", summary: "1. fix x" });
    expect(parseTextReport("All done!", "t")).toBeNull();
  });
});


describe("shipping completion boundary", () => {
  it.each(["pr", "merge"])("handles a confirmed open PR in %s mode", (action) => {
    const workflow = wf([
      { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
      { id: "ship", name: "Ship", type: "ship", action, next: ["follow"] },
      { id: "follow", name: "Follow", type: "agent" },
    ]);
    let item = itemFor(workflow);
    [item] = run(item, { type: "start" });
    [item] = run(item, ended("build", report(), item));
    let fx: Effect[];
    [item, fx] = run(item, { type: "pr_opened", step: "ship", prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" });
    expect(item.prUrl).toBe("https://github.com/acme/app/pull/7");
    expect(item.nodes.ship!.status).toBe(action === "pr" ? "done" : "running");
    expect(agentFx(fx).length).toBe(action === "pr" ? 1 : 0);
    if (action === "merge") {
      [item, fx] = run(item, { type: "pr_merged" });
      expect(item.nodes.ship!.status).toBe("done");
      expect(item.nodes.follow!.status).toBe("running");
      expect(agentFx(fx)).toHaveLength(1);
    }
    expect(item.finishedAt).toBeNull();
  });
});

describe("model steps", () => {
  const flow = wf([
    { id: "m1", name: "Opus", type: "model", providerId: "claude-code", model: "opus", next: ["plan"] },
    { id: "plan", name: "Plan", type: "agent", next: ["m2"] },
    { id: "m2", name: "Cheaper", type: "model", model: "haiku", reasoningLevel: "low", next: ["build"] },
    { id: "build", name: "Build", type: "agent", writes: true, next: ["m3"] },
    { id: "m3", name: "Back", type: "model", model: "opus", next: ["review"] },
    { id: "review", name: "Review", type: "agent", next: [] },
  ]);

  it("is valid without a code-writing step before it", () => {
    expect(validateWorkflow(flow)).toEqual([]);
  });

  it("requires something to set when fixed", () => {
    const empty = wf([{ id: "m", name: "Nothing", type: "model", mode: "fixed", next: ["a"] }, { id: "a", name: "A", type: "agent" }]);
    expect(validateWorkflow(empty)).toEqual(["Nothing: set a provider, a model or a reasoning level"]);
  });

  it("writes down the inferred mode of steps saved before modes existed when parsed", () => {
    const doc = { workflows: [{ id: "w", name: "W", steps: [
      { id: "fixed", name: "Fixed", type: "model", providerId: "claude-code", next: ["auto"] },
      { id: "auto", name: "Auto", type: "model", next: ["a"] },
      { id: "a", name: "A", type: "agent" },
    ] }], default: "w" };
    const parsed = parseWorkflows(JSON.stringify(doc));
    expect(parsed.ok && parsed.value.workflows[0]!.steps.map((s) => (s.type === "model" ? s.mode : null))).toEqual(["fixed", "auto", null]);
    const stored = normalizeWorkflow(doc.workflows[0] as unknown as Workflow);
    expect(stored.steps.map((s) => (s.type === "model" ? s.mode : null))).toEqual(["fixed", "auto", null]);
  });

  it("is fixed when it sets something and has no mode (saved before modes existed), automatic otherwise", () => {
    expect(modelMode(flow.steps[0] as ModelStep)).toBe("fixed");
    expect(modelMode(wf([{ id: "m", name: "M", type: "model" }]).steps[0] as ModelStep)).toBe("auto");
    expect(modelMode(wf([{ id: "m", name: "M", type: "model", mode: "auto", model: "opus" }]).steps[0] as ModelStep)).toBe("auto");
  });

  it("keeps the settings for every later step until another model step changes a field", () => {
    expect(settingsFor(flow, "plan")).toEqual({ providerId: "claude-code", model: "opus" });
    expect(settingsFor(flow, "build")).toEqual({ providerId: "claude-code", model: "haiku", reasoningLevel: "low" });
    expect(settingsFor(flow, "review")).toEqual({ providerId: "claude-code", model: "opus", reasoningLevel: "low" });
  });

  it("does not leak into steps that are not after it", () => {
    const parallel = wf([
      { id: "a", name: "A", type: "model", model: "opus", next: ["x"] },
      { id: "b", name: "B", type: "model", model: "haiku", next: ["y"] },
      { id: "x", name: "X", type: "agent" },
      { id: "y", name: "Y", type: "agent" },
    ]);
    expect(settingsFor(parallel, "x")).toEqual({ model: "opus" });
    expect(settingsFor(parallel, "y")).toEqual({ model: "haiku" });
    expect(settingsFor(parallel, "a")).toEqual({});
  });

  it("completes instantly and starts the next agent step in the same pass", () => {
    const [item, fx] = run(itemFor(flow), { type: "start" });
    expect(st(item)).toMatchObject({ m1: "done", plan: "running", m2: "pending" });
    expect(agentFx(fx)).toEqual([{ type: "agent", step: "plan", agent: 0, kind: "start" }]);
    const [after, fx2] = run(item, ended("plan", report(), item));
    expect(st(after)).toMatchObject({ m2: "done", build: "running" });
    expect(agentFx(fx2).map((e) => (e as { step: string }).step)).toEqual(["build"]);
  });
});

describe("an agent step that chooses the model", () => {
  const flow = wf([
    {
      id: "triage",
      name: "Triage",
      type: "agent",
      chooses: [
        { id: "small", when: "tiny change", model: "haiku" },
        { id: "hard", when: "risky or large change", providerId: "claude-code", model: "opus", reasoningLevel: "high" },
      ],
      next: ["plan"],
    },
    { id: "plan", name: "Plan", type: "agent", next: ["pin"] },
    { id: "pin", name: "Pin", type: "model", model: "sonnet", next: ["build"] },
    { id: "build", name: "Build", type: "agent", writes: true },
  ]);
  const pick = (choice: string | null): StepReport => ({ ...report("done", "picked"), choice });

  it("applies the picked choice to every later step, until a model step changes it", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const [after] = run(started, ended("triage", pick("hard"), started));
    expect(settingsFor(flow, "plan", after.nodes)).toEqual({ providerId: "claude-code", model: "opus", reasoningLevel: "high" });
    expect(settingsFor(flow, "build", after.nodes)).toEqual({ providerId: "claude-code", model: "sonnet", reasoningLevel: "high" });
  });

  it("has no effect before the agent has picked", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    expect(settingsFor(flow, "plan", started.nodes)).toEqual({});
  });

  it("asks a person when the report names no valid choice", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    for (const bad of [null, "nonsense"]) {
      const [after] = run(started, ended("triage", pick(bad), started));
      expect(after.nodes.triage!.status).toBe("waiting");
      expect(after.nodes.triage!.waiting?.kind).toBe("escalation");
      expect(after.nodes.plan!.status).toBe("pending");
    }
  });

  it("validates its choices", () => {
    const dup = wf([{ id: "t", name: "T", type: "agent", chooses: [{ id: "a", when: "x", model: "m" }, { id: "a", when: "y" }] }]);
    expect(validateWorkflow(dup)).toEqual(['T: two model choices have the id "a"', 'T: model choice "a" sets nothing']);
  });

  it("reads the choice from a text report", () => {
    const r = parseTextReport("## Step report\nstep: triage\noutcome: done\nchoice: hard\nsummary: big", NOW.toISOString());
    expect(r?.choice).toBe("hard");
  });

  it("tells the agent the options", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const prompt = stepPrompt(started, flow.steps[0] as AgentStep, 0);
    expect(prompt).toContain("`small`: tiny change");
    expect(prompt).toContain("choice: <id of the model you pick>");
  });
});

describe("an automatic model step", () => {
  const flow = wf([
    { id: "pick", name: "Pick model", type: "model", mode: "auto", instructions: "Choose the best model for the job.", next: ["build"] },
    { id: "build", name: "Build", type: "agent", writes: true, next: ["pin"] },
    { id: "pin", name: "Pin", type: "model", model: "sonnet", next: ["review"] },
    { id: "review", name: "Review", type: "agent" },
  ]);
  const picked = (pick: StepReport["pick"]): StepReport => ({ ...report("done", "Opus: risky change"), pick });

  it("is valid with nothing set and is the default for a new model step", () => {
    expect(validateWorkflow(flow)).toEqual([]);
    expect(blankStep("model", "m", "Model")).toMatchObject({ mode: "auto", instructions: DEFAULT_MODEL_INSTRUCTIONS });
  });

  it("runs one read-only agent instead of completing instantly", () => {
    const [started, fx] = run(itemFor(flow), { type: "start" });
    expect(st(started)).toMatchObject({ pick: "running", build: "pending" });
    expect(agentFx(fx)).toEqual([{ type: "agent", step: "pick", agent: 0, kind: "start" }]);
    expect(agentWork(flow.steps[0])).toMatchObject({ writes: false, agents: 1, picksModel: true });
    expect(agentWork(flow.steps[2])).toBeNull();
  });

  it("applies the agent's pick to later steps until a model step changes it", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const [after, fx] = run(started, ended("pick", picked({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }), started));
    expect(st(after)).toMatchObject({ pick: "done", build: "running" });
    expect(agentFx(fx).map((e) => (e as { step: string }).step)).toEqual(["build"]);
    expect(settingsFor(flow, "build", after.nodes)).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", complete: true });
    expect(settingsFor(flow, "review", after.nodes)).toEqual({ providerId: "claude-code", model: "sonnet", reasoningLevel: "high", complete: true });
  });

  it("replaces everything set before it as a whole: no reasoning level leaks from an earlier step", () => {
    const cheap = wf([
      { id: "cheap", name: "Cheap chooser", type: "model", providerId: "claude-code", model: "haiku", reasoningLevel: "low", next: ["pick"] },
      { id: "pick", name: "Pick", type: "model", mode: "auto", next: ["build"] },
      { id: "build", name: "Build", type: "agent", writes: true },
    ]);
    const [started] = run(itemFor(cheap), { type: "start" });
    expect(settingsFor(cheap, "pick", started.nodes)).toEqual({ providerId: "claude-code", model: "haiku", reasoningLevel: "low" });
    const [after] = run(started, ended("pick", picked({ providerId: "codex", model: "gpt-5" }), started));
    expect(settingsFor(cheap, "build", after.nodes)).toEqual({ providerId: "codex", model: "gpt-5", complete: true });
  });

  it("resolves a complete pick without the repository's or global values", () => {
    const repo = { providerId: "claude-code", model: "sonnet", reasoningLevel: "low" };
    const defaults = { providerId: "acp-cursor", model: "default-model" };
    expect(resolveAgent({ providerId: "codex", model: "gpt-5", complete: true }, repo, defaults)).toEqual({ providerId: "codex", model: "gpt-5", reasoningLevel: undefined });
    expect(resolveAgent({ model: "opus" }, repo, defaults)).toEqual({ providerId: "claude-code", model: "opus", reasoningLevel: "low" });
    expect(resolveAgent(undefined, {}, defaults)).toEqual({ providerId: "acp-cursor", model: "default-model", reasoningLevel: undefined });
  });

  it.each([
    ["nothing", null],
    ["only a reasoning level", { reasoningLevel: "high" }],
    ["only a provider", { providerId: "codex" }],
    ["only a model", { model: "gpt-5" }],
  ])("asks a person when the agent picks %s", (_, pick) => {
    const [started] = run(itemFor(flow), { type: "start" });
    const [after] = run(started, ended("pick", picked(pick), started));
    expect(after.nodes.pick!.status).toBe("waiting");
    expect(after.nodes.pick!.waiting?.kind).toBe("escalation");
    expect(settingsFor(flow, "build", after.nodes)).toEqual({});
  });

  it("tells the agent how to find the available models and how to report its pick", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const prompt = stepPrompt(started, agentWork(flow.steps[0])!, 0);
    expect(prompt).toContain("Choose the best model for the job.");
    expect(prompt).toContain("bb provider list --json");
    expect(prompt).toContain("bb provider models <providerId> --json");
    expect(prompt).toContain("`providerId`, `model` and `reasoningLevel`");
    expect(prompt).toContain("leave `reasoningLevel` out entirely");
    expect(prompt).not.toContain("or none if it lists none");
    expect(prompt).toContain("Report the provider's `id` as `providerId`");
    expect(prompt).toContain("providerId: <provider id>");
    expect(prompt).toContain("This step is read-only");
  });

  it("uses the default instructions when the step has none", () => {
    const bare = wf([{ id: "m", name: "M", type: "model", mode: "auto" }]);
    expect(agentWork(bare.steps[0])?.instructions).toBe(DEFAULT_MODEL_INSTRUCTIONS);
  });

  it("reads the pick from a text report", () => {
    const r = parseTextReport("## Step report\nstep: pick\noutcome: done\nprovider: codex\nmodel: gpt-5\nreasoning: high\nsummary: big", NOW.toISOString());
    expect(r?.pick).toEqual({ providerId: "codex", model: "gpt-5", reasoningLevel: "high" });
    expect(parseTextReport("## Step report\nstep: x\noutcome: done\nsummary: y", NOW.toISOString())?.pick).toBeUndefined();
    // The tool's parameter names work too.
    const named = parseTextReport("## Step report\nstep: pick\noutcome: done\nproviderId: codex\nmodel: gpt-5\nreasoningLevel: high\nsummary: big", NOW.toISOString());
    expect(named?.pick).toEqual({ providerId: "codex", model: "gpt-5", reasoningLevel: "high" });
    // Lines in the summary are prose, not a pick.
    const prose = parseTextReport("## Step report\nstep: pick\noutcome: done\nproviderId: codex\nsummary: Compared options.\n- **Model**: sonnet was considered\n- reasoning: high is overkill", NOW.toISOString());
    expect(prose?.pick).toEqual({ providerId: "codex", model: null, reasoningLevel: null });
  });
});

describe("per-agent delivery retries", () => {
  it.each([false, true])("preserves thread-failure precedence over a sibling's interrupted send (legacy=%s)", (legacy) => {
    let item = itemFor(wf([{ id: "review", name: "Review", type: "agent", agents: 2 }]));
    [item] = run(item, { type: "start" });
    [item] = run(item, { type: "thread_failed", step: "review", agent: 0, error: "thread deleted" });
    if (legacy) {
      delete item.nodes.review.retry!.cause;
      delete item.nodes.review.agentRetries;
    }
    const failure = structuredClone(item.nodes.review.retry);
    [item] = run(item, { type: "effect_error", step: "review", effect: { type: "agent", step: "review", agent: 1, kind: "start" }, message: "interrupted send", uncertain: true });
    expect(item.nodes.review.retry).toEqual(failure);
    expect(item.nodes.review.agentRetries?.[0]).toEqual(failure);
    expect(item.nodes.review.agentRetries?.[1]).toMatchObject({ cause: "prompt_delivery", uncertain: true });
    [item] = run(item, { type: "delivery_ack", step: "review", agent: 0, round: 1 });
    [item] = run(item, ended("review", report(), item, 0));
    expect(item.nodes.review).toMatchObject({ status: "waiting", retry: failure, reports: [null, null] });
  });

  it.each([false, true])("does not acknowledge a thread failure as delivery recovery (legacy=%s)", (legacy) => {
    let item = itemFor(wf([{ id: "review", name: "Review", type: "agent", agents: 2 }]));
    [item] = run(item, { type: "start" });
    [item] = run(item, { type: "effect_error", step: "review", effect: { type: "agent", step: "review", agent: 1, kind: "start" }, message: "response lost", uncertain: true });
    [item] = run(item, { type: "thread_failed", step: "review", agent: 0, error: "thread deleted" });
    if (legacy) {
      delete item.nodes.review.retry!.cause;
      delete item.nodes.review.agentRetries;
    }
    const before = structuredClone(item.nodes.review);
    for (const agent of [0, 1]) {
      [item] = run(item, { type: "delivery_ack", step: "review", agent, round: 1 });
      [item] = run(item, ended("review", report(), item, agent));
      expect(item.nodes.review).toEqual(before);
    }
  });

  it("drops downstream delivery attempts and retries when an earlier step is rerun", () => {
    let item = itemFor(wf([{ id: "build", name: "Build", type: "agent", writes: true, next: ["review"] }, { id: "review", name: "Review", type: "agent" }]));
    [item] = run(item, { type: "start" });
    [item] = run(item, ended("build", report(), item));
    item.nodes.review.deliveries = { 0: { id: "old", round: 1, threadId: "old", state: "sending", sentAt: 1 } };
    [item] = run(item, { type: "effect_error", step: "review", effect: { type: "agent", step: "review", agent: 0, kind: "start" }, message: "failed" });
    [item] = run(item, { type: "rerun", step: "build" });
    expect(item.nodes.review).toMatchObject({ status: "pending", deliveries: {}, agentRetries: {}, retry: null });
    const [, effects] = run(item, { type: "retry_due", step: "review" });
    expect(effects).toEqual([]);
  });

  it("keeps both uncertain deliveries until each matching agent acknowledges", () => {
    let item = itemFor(wf([{ id: "review", name: "Review", type: "agent", agents: 2 }]));
    [item] = run(item, { type: "start" });
    for (const agent of [0, 1]) [item] = run(item, { type: "effect_error", step: "review", effect: { type: "agent", step: "review", agent, kind: "start" }, message: "response lost", uncertain: true });
    expect(Object.keys(item.nodes.review.agentRetries!)).toEqual(["0", "1"]);
    const [retried, effects] = run(item, { type: "retry", step: "review" });
    expect(effects).toContainEqual({ type: "agent", step: "review", agent: 0, kind: "start" });
    expect(retried.nodes.review).toMatchObject({ status: "waiting", retry: { effect: { agent: 1 } } });
    [item] = run(item, { type: "delivery_ack", step: "review", agent: 0, round: 0 });
    expect(Object.keys(item.nodes.review.agentRetries!)).toHaveLength(2);
    [item] = run(item, { type: "delivery_ack", step: "review", agent: 0, round: 1 });
    [item] = run(item, ended("review", report(), item, 0));
    expect(item.nodes.review).toMatchObject({ status: "waiting", retry: { effect: { agent: 1 }, uncertain: true }, reports: [{ outcome: "done" }, null] });
    [item] = run(item, { type: "delivery_ack", step: "review", agent: 1, round: 1 });
    [item] = run(item, ended("review", report(), item, 1));
    expect(item.status).toBe("done");
  });
});
