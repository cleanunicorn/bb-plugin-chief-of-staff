import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, deriveStatus, initialNodes, transition, type Effect, type MachineEvent, type StepReport } from "../src/machine";
import type { WorkItem } from "../src/state";
import { DEFAULT_WORKFLOW, fromStages, parseWorkflows, validateWorkflow, workflowSchema, type Workflow } from "../src/workflow";
import { parseTextReport } from "../src/report";
import { pipelineLine } from "../src/prompts";

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
    [item, fx] = run(item, ended("plan", report("done", "again"), item, 1));
    expect(item.nodes.plan!.reports.filter(Boolean)).toHaveLength(1);
    [item, fx] = run(item, ended("plan", report("done", "plan B"), item, 0));
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
    [item, fx] = run(item, ended("docs", report(), item));
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
    [item, fx] = run(item, { type: "revise", feedback: "use the session store" });
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
