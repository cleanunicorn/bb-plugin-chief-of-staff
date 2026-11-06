import { describe, expect, it } from "vitest";
import { actorOf, DEFAULT_POLICY, rosterStatus, transition, type MachineEvent, type Transition } from "../src/machine";
import { NEW_ITEM_STAGE_FIELDS, type StageReport, type WorkItem } from "../src/state";
import { activeStages, nextStage, parseWorkflow, resolveWorkflow, workflowSchema, type Workflow } from "../src/workflow";
import { parseTextReport } from "../src/report";

const base: WorkItem = {
  ...NEW_ITEM_STAGE_FIELDS,
  id: "w1",
  repo: "acme/app",
  issueNumber: 12,
  issueTitle: "Fix login",
  threadId: "thr_1",
  environmentId: "env_1",
  branch: "cos/issue-12-fix-login",
  prNumber: null,
  prUrl: null,
  status: "agent",
  stage: "build",
  providerId: "claude-code",
  model: null,
  fixAttempts: 0,
  retryCount: 0,
  lastError: null,
  checkOutput: null,
  source: "intake",
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  lastActivityAt: null,
  finishedAt: null,
};

const full: Workflow = workflowSchema.parse({ verify: { command: "npm test" } });
const minimal: Workflow = workflowSchema.parse({ plan: { enabled: false }, verify: { enabled: false }, review: { enabled: false } });

const report = (stage: StageReport["stage"], outcome: StageReport["outcome"] = "done", summary = `${stage} summary`): StageReport => ({ stage, outcome, summary, at: "2026-11-05T01:00:00.000Z", via: "tool" });
const ended = (r: StageReport | null, role: "builder" | "reviewer" = "builder", question: string | null = null): MachineEvent => ({ type: "turn_ended", role, report: r, question });

/** Apply a transition the way the dispatcher does. */
function apply(item: WorkItem, t: Transition): WorkItem {
  return { ...item, ...t.patch, status: t.status, stage: t.stage } as WorkItem;
}
function run(item: WorkItem, event: MachineEvent, workflow: Workflow = full): [WorkItem, Transition] {
  const t = transition(item, event, workflow, DEFAULT_POLICY);
  return [apply(item, t), t];
}

describe("workflow config", () => {
  it("defaults to the full pipeline with plan approval and an independent reviewer", () => {
    const wf = workflowSchema.parse({});
    expect(wf.plan).toMatchObject({ enabled: true, requireApproval: true });
    expect(wf.review).toMatchObject({ enabled: true, mode: "agent" });
    expect(wf.ship.action).toBe("pr");
    // Verify with neither a command nor instructions has nothing to do.
    expect(activeStages(wf)).toEqual(["plan", "build", "review", "ship"]);
  });

  it("merges repo overrides field by field", () => {
    const global = workflowSchema.parse({ review: { instructions: "be strict" }, verify: { command: "npm test" } });
    const wf = resolveWorkflow(global, { review: { enabled: false }, plan: { requireApproval: false } });
    expect(wf.review).toMatchObject({ enabled: false, instructions: "be strict" });
    expect(wf.plan).toMatchObject({ enabled: true, requireApproval: false });
    expect(wf.verify.command).toBe("npm test");
    expect(resolveWorkflow(global, { verify: { command: "make check" } }).verify.command).toBe("make check");
  });

  it("finds the next enabled stage, optionally skipping review", () => {
    expect(nextStage(full, "build")).toBe("verify");
    expect(nextStage(full, "verify")).toBe("review");
    expect(nextStage(full, "verify", { skipReview: true })).toBe("ship");
    expect(nextStage(minimal, "build")).toBe("ship");
    expect(nextStage(workflowSchema.parse({ ship: { enabled: false } }), "review")).toBe("done");
  });

  it("parses the stored setting and rejects bad values", () => {
    expect(parseWorkflow("").ok).toBe(true);
    const parsed = parseWorkflow(JSON.stringify({ workflow: { ship: { action: "merge" } } }));
    expect(parsed.ok && parsed.value.ship.action).toBe("merge");
    expect(parseWorkflow(JSON.stringify({ workflow: { ship: { action: "yolo" } } })).ok).toBe(false);
  });
});

describe("stage machine", () => {
  it("walks plan → approval → build → verify → review → ship → CI → merged", () => {
    let item: WorkItem = { ...base, status: "queued", stage: "build", threadId: null, environmentId: null };
    let t: Transition;

    [item, t] = run(item, { type: "start" });
    expect([item.stage, item.status]).toEqual(["plan", "agent"]);
    expect(t.effects).toEqual([{ type: "prompt", target: "builder", kind: "plan", detail: undefined }]);
    item = { ...item, threadId: "thr_1", environmentId: "env_1" };

    [item, t] = run(item, ended(report("plan", "done", "1. change auth.ts")));
    expect([item.stage, item.status, item.waitingKind]).toEqual(["plan", "waiting_on_human", "plan_approval"]);
    expect(item.reports.plan?.summary).toBe("1. change auth.ts");
    expect(t.effects[0]).toMatchObject({ type: "notify" });

    [item, t] = run(item, { type: "approve" });
    expect([item.stage, item.status, item.waitingKind]).toEqual(["build", "agent", null]);
    expect(t.effects).toEqual([{ type: "prompt", target: "builder", kind: "build", detail: undefined }]);

    [item, t] = run(item, ended(report("build")));
    expect([item.stage, item.status]).toEqual(["verify", "cos"]);
    expect(item.jobStartedAt).toBe("now");
    expect(t.effects).toEqual([{ type: "verify_command" }]);

    [item, t] = run(item, { type: "verify_passed", output: "all green" });
    expect([item.stage, item.status]).toEqual(["review", "agent"]);
    expect(t.effects).toEqual([{ type: "prompt", target: "reviewer", kind: "review" }]);

    // The builder idling during an independent review is not the stage's signal.
    expect(transition(item, ended(null), full).effects).toEqual([]);

    [item, t] = run(item, ended(report("review", "done", "LGTM"), "reviewer"));
    expect([item.stage, item.status]).toEqual(["ship", "cos"]);
    expect(t.effects).toEqual([{ type: "ship" }]);

    [item] = run(item, { type: "pr_opened", prNumber: 7, prUrl: "https://github.com/acme/app/pull/7" });
    expect([item.stage, item.status, item.prNumber]).toEqual(["ship", "ci", 7]);

    [item, t] = run(item, { type: "ci_passing" });
    expect([item.stage, item.status]).toEqual(["ship", "ready"]);
    expect(t.effects[0]).toMatchObject({ type: "notify" });

    [item] = run(item, { type: "pr_merged" });
    expect([item.stage, item.status]).toEqual(["done", "done"]);
    expect(rosterStatus(item)).toBe("done");
  });

  it("skips disabled stages: build straight to ship", () => {
    let item: WorkItem = { ...base, status: "queued", threadId: null };
    let t: Transition;
    [item, t] = run(item, { type: "start" }, minimal);
    expect([item.stage, t.effects[0]]).toEqual(["build", { type: "prompt", target: "builder", kind: "build", detail: undefined }]);
    [item, t] = run(item, ended(report("build")), minimal);
    expect([item.stage, item.status, t.effects]).toEqual(["ship", "cos", [{ type: "ship" }]]);
  });

  it("continues without a human when plan approval is off", () => {
    const wf = workflowSchema.parse({ plan: { requireApproval: false }, verify: { enabled: false }, review: { enabled: false } });
    const [item] = run({ ...base, stage: "plan" }, ended(report("plan")), wf);
    expect([item.stage, item.status]).toEqual(["build", "agent"]);
  });

  it("sends the plan back with feedback", () => {
    const waiting = { ...base, stage: "plan" as const, status: "waiting_on_human" as const, waitingKind: "plan_approval" as const };
    const [item, t] = run(waiting, { type: "revise", feedback: "use the existing session store" });
    expect([item.stage, item.status]).toEqual(["plan", "agent"]);
    expect(t.effects).toEqual([{ type: "prompt", target: "builder", kind: "plan_revise", detail: "use the existing session store" }]);
  });

  it("nudges an agent that stops without reporting, then asks a human", () => {
    let item: WorkItem = { ...base };
    let t: Transition;
    [item, t] = run(item, ended(null));
    expect(t.effects).toEqual([{ type: "prompt", target: "builder", kind: "nudge" }]);
    expect(item.counters.nudges).toBe(1);
    [item] = run(item, ended(null));
    [item, t] = run(item, ended(null));
    expect([item.status, item.waitingKind]).toEqual(["waiting_on_human", "no_report"]);
    // The human vouches for the stage: move on.
    [item] = run(item, { type: "approve" });
    expect([item.stage, item.status, item.counters.nudges]).toEqual(["verify", "cos", 0]);
  });

  it("does not let approve skip an open question or Chief of Staff's own failure", () => {
    for (const waitingKind of ["question", "cos_error"] as const) {
      const t = transition({ ...base, status: "waiting_on_human", waitingKind }, { type: "approve" }, full);
      expect([t.stage, t.status]).toEqual(["build", "waiting_on_human"]);
    }
  });

  it("keeps watching an open PR when a ship escalation is approved", () => {
    const t = transition({ ...base, stage: "ship", status: "waiting_on_human", waitingKind: "escalation", prNumber: 7 }, { type: "approve" }, full);
    expect([t.stage, t.status]).toEqual(["ship", "ready"]);
  });

  it("says finished, not shipped, when shipping is off", () => {
    const wf = workflowSchema.parse({ plan: { enabled: false }, verify: { enabled: false }, review: { enabled: false }, ship: { enabled: false } });
    const t = transition(base, ended(report("build")), wf);
    expect([t.stage, t.effects[0]]).toEqual(["done", expect.objectContaining({ title: expect.stringContaining("Finished") })]);
  });

  it("treats a report for another stage as no report", () => {
    const [, t] = run({ ...base, stage: "build" }, ended(report("plan")));
    expect(t.effects).toEqual([{ type: "prompt", target: "builder", kind: "nudge" }]);
  });

  it("parks on a plain-text question and resumes when the thread starts a turn", () => {
    let [item] = run(base, ended(null, "builder", "Question: which DB?"));
    expect([item.status, item.waitingKind, item.waitingReason]).toEqual(["waiting_on_human", "question", "Question: which DB?"]);
    [item] = run(item, { type: "turn_started", role: "builder" });
    expect([item.stage, item.status]).toEqual(["build", "agent"]);
  });

  it("asks a human when the agent reports needs_input", () => {
    const [item] = run(base, ended({ ...report("build", "needs_input"), question: "Keep the v1 API?" }));
    expect([item.status, item.waitingKind, item.waitingReason]).toEqual(["waiting_on_human", "question", "Keep the v1 API?"]);
  });

  it("loops review findings back to build, then re-reviews, then escalates", () => {
    let item: WorkItem = { ...base, stage: "review", reviewThreadId: "thr_r" };
    let t: Transition;
    [item, t] = run(item, ended(report("review", "changes_requested", "1. missing test"), "reviewer"));
    expect([item.stage, item.counters.reviewRounds, t.effects]).toEqual(["build", 1, [{ type: "prompt", target: "builder", kind: "fix_review", detail: "1. missing test" }]]);
    [item] = run(item, ended(report("build")));
    [item, t] = run(item, { type: "verify_passed", output: "ok" });
    expect(t.effects).toEqual([{ type: "prompt", target: "reviewer", kind: "rereview" }]);
    [item] = run(item, ended(report("review", "changes_requested"), "reviewer"));
    [item] = run(item, ended(report("build")));
    [item] = run(item, { type: "verify_passed", output: "ok" });
    [item, t] = run(item, ended(report("review", "changes_requested"), "reviewer"));
    expect([item.stage, item.status, item.waitingKind]).toEqual(["review", "waiting_on_human", "escalation"]);
    // Approving ships anyway.
    [item] = run(item, { type: "approve" });
    expect(item.stage).toBe("ship");
  });

  it("uses the builder thread for self-review", () => {
    const wf = workflowSchema.parse({ review: { mode: "self" } });
    const [, t] = run({ ...base, stage: "verify", status: "agent" }, ended(report("verify")), wf);
    expect(t.effects).toEqual([{ type: "prompt", target: "builder", kind: "review" }]);
  });

  it("feeds verify failures back on a budget", () => {
    let item: WorkItem = { ...base, stage: "verify", status: "cos" };
    let t: Transition;
    [item, t] = run(item, { type: "verify_failed", output: "1 failing" });
    expect([item.stage, item.status, item.fixAttempts]).toEqual(["build", "agent", 1]);
    expect(t.effects).toEqual([{ type: "prompt", target: "builder", kind: "fix_verify", detail: "1 failing" }]);
    [item] = run({ ...item, stage: "verify", status: "cos" }, { type: "verify_failed", output: "1 failing" });
    [item] = run({ ...item, stage: "verify", status: "cos" }, { type: "verify_failed", output: "still" });
    expect([item.status, item.waitingKind]).toEqual(["waiting_on_human", "escalation"]);
  });

  it("an agent-run verification can fail the stage", () => {
    const wf = workflowSchema.parse({ verify: { instructions: "click through login" } });
    const [item, t] = run({ ...base, stage: "verify", status: "agent" }, ended(report("verify", "failed", "login button dead")), wf);
    expect(item.stage).toBe("build");
    expect(t.effects[0]).toMatchObject({ kind: "fix_verify", detail: "login button dead" });
  });

  it("fixes red CI through build and verify, skipping a second review", () => {
    let item: WorkItem = { ...base, stage: "ship", status: "ci", prNumber: 7 };
    let t: Transition;
    [item, t] = run(item, { type: "ci_failing", log: "lint failed" });
    expect([item.stage, item.returnTo, t.effects[0]]).toEqual(["build", "ship", { type: "prompt", target: "builder", kind: "fix_ci", detail: "lint failed" }]);
    [item] = run(item, ended(report("build")));
    expect(item.stage).toBe("verify");
    [item, t] = run(item, { type: "verify_passed", output: "ok" });
    expect([item.stage, item.status, item.returnTo, t.effects]).toEqual(["ship", "cos", null, [{ type: "ship" }]]);
  });

  it("merges when the ship action is merge, and waits for approval when needed", () => {
    const wf = workflowSchema.parse({ ship: { action: "merge" } });
    let item: WorkItem = { ...base, stage: "ship", status: "ci", prNumber: 7 };
    let t: Transition;
    [item, t] = run(item, { type: "ci_passing" }, wf);
    expect([item.status, t.effects]).toEqual(["cos", [{ type: "merge" }]]);
    [item] = run(item, { type: "merge_waiting", reason: "Waiting for an approving review" }, wf);
    expect([item.status, item.lastError]).toEqual(["ready", "Waiting for an approving review"]);
    [item, t] = run(item, { type: "ci_passing" }, wf);
    expect(t.effects).toEqual([{ type: "merge" }]);
  });

  it("asks the agent for the PR description when ship has instructions", () => {
    const wf = workflowSchema.parse({ plan: { enabled: false }, verify: { enabled: false }, review: { enabled: false }, ship: { instructions: "Use the PR template" } });
    let [item, t] = run(base, ended(report("build")), wf);
    expect([item.stage, item.status, t.effects]).toEqual(["ship", "agent", [{ type: "prompt", target: "builder", kind: "ship" }]]);
    [item, t] = run(item, ended(report("ship", "done", "Title: Fix login\n\nBody")), wf);
    expect([item.status, t.effects]).toEqual(["cos", [{ type: "ship" }]]);
  });

  it("retries infrastructure errors with backoff, then asks for help, then re-runs the failed effect", () => {
    let item: WorkItem = { ...base, stage: "verify", status: "cos" };
    const effect = { type: "verify_command" } as const;
    for (let n = 1; n <= 3; n++) {
      [item] = run(item, { type: "effect_error", effect, message: "host call exceeded its deadline" });
      expect([item.status, item.counters.infraRetries, item.retryAt]).toEqual(["retrying", n, `+${n * n * 60_000}`]);
      let t: Transition;
      [item, t] = run(item, { type: "retry_due" });
      expect([item.status, t.effects]).toEqual(["cos", [effect]]);
    }
    [item] = run(item, { type: "effect_error", effect, message: "host call exceeded its deadline" });
    expect([item.status, item.waitingKind, actorOf(item)]).toEqual(["waiting_on_human", "cos_error", "human"]);
    expect(item.waitingReason).toContain("the agent is not asking anything");
    const [after, t] = run(item, { type: "retry" });
    expect([after.status, t.effects]).toEqual(["cos", [effect]]);
  });

  it("restarts a lost job for its stage", () => {
    expect(transition({ ...base, stage: "verify", status: "cos" }, { type: "resume_job" }, full).effects).toEqual([{ type: "verify_command" }]);
    expect(transition({ ...base, stage: "ship", status: "cos" }, { type: "resume_job" }, full).effects).toEqual([{ type: "ship" }]);
  });

  it("brings a failed reviewer back through a human retry", () => {
    let [item] = run({ ...base, stage: "review", reviewThreadId: "thr_r" }, { type: "thread_failed", role: "reviewer", error: "boom" });
    expect([item.status, item.waitingKind, item.reviewThreadId]).toEqual(["waiting_on_human", "cos_error", null]);
    let t: Transition;
    [item, t] = run(item, { type: "retry" });
    expect([item.status, t.effects]).toEqual(["agent", [{ type: "prompt", target: "reviewer", kind: "review" }]]);
  });

  it("marks stalls blocked, and resumes when a human restarts the thread", () => {
    let [item] = run(base, { type: "stalled" });
    expect(item.status).toBe("blocked");
    [item] = run(item, { type: "turn_started", role: "builder" });
    expect(item.status).toBe("agent");
  });

  it("takes extra work on an open PR back through build", () => {
    const [item] = run({ ...base, stage: "ship", status: "ready", prNumber: 7 }, { type: "turn_started", role: "builder" });
    expect([item.stage, item.status, item.returnTo]).toEqual(["build", "agent", "ship"]);
  });

  it("finishes routine agents when their turn ends", () => {
    const [item] = run({ ...base, source: "routine:Nightly" }, ended(null));
    expect([item.stage, item.status]).toEqual(["done", "done"]);
  });
});

describe("text stage reports", () => {
  it("parses a trailing Stage report block", () => {
    const text = "Did the thing.\n\n## Stage report\nstage: build\noutcome: done\nsummary: Changed auth.ts\nand added a test";
    expect(parseTextReport(text, "t")).toEqual({ stage: "build", outcome: "done", summary: "Changed auth.ts\nand added a test", question: null, at: "t", via: "text" });
  });

  it("accepts fenced, bulleted and bold variants and normalises the outcome", () => {
    const text = "## Stage report\n```\n- **stage**: review\n- **outcome**: Changes requested\n- **summary**: 1. fix x\n```";
    expect(parseTextReport(text, "t")).toMatchObject({ stage: "review", outcome: "changes_requested", summary: "1. fix x" });
  });

  it("ignores messages without a valid block", () => {
    expect(parseTextReport("All done!", "t")).toBeNull();
    expect(parseTextReport("## Stage report\nstage: deploy\noutcome: done", "t")).toBeNull();
  });
});
