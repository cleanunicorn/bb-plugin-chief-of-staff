// Pure stage machine: given a work item, its repo's workflow and an event,
// return the next stage + status, a patch, and the side effects the caller
// runs. No I/O. Stages: plan → build → verify → review → ship → done, with
// disabled stages skipped and failures looping back to build on a budget.
import type { ReportOutcome, StageCounters, StageReport, WaitingKind, WorkItem, WorkStatus } from "./state";
import { ZERO_COUNTERS } from "./state";
import { firstStage, nextStage, STAGE_LABEL, type Stage, type StageOrDone, type Workflow } from "./workflow";

export type PromptKind =
  | "plan"
  | "plan_revise"
  | "build"
  | "fix_verify"
  | "fix_review"
  | "fix_ci"
  | "fix_human"
  | "verify"
  | "review"
  | "rereview"
  | "ship"
  | "nudge";

export type Effect =
  /** Send a stage prompt; spawns the builder (or reviewer) thread when it does not exist yet, or when `fresh`. */
  | { type: "prompt"; target: "builder" | "reviewer"; kind: PromptKind; detail?: string; fresh?: boolean }
  /** Run the verify command in the worktree (detached job). */
  | { type: "verify_command" }
  /** Commit leftovers, push, and open/update the PR per the ship action (detached job). */
  | { type: "ship" }
  /** Merge the open PR (detached job). */
  | { type: "merge" }
  | { type: "notify"; title: string; body: string };

export type ThreadRole = "builder" | "reviewer";

export type MachineEvent =
  | { type: "start" }
  | { type: "thread_spawned"; role: ThreadRole; threadId: string; environmentId: string | null }
  | { type: "turn_started"; role: ThreadRole }
  /** A turn ended. The observer has already looked for a stage report and a plain-text question. */
  | { type: "turn_ended"; role: ThreadRole; report: StageReport | null; question: string | null }
  | { type: "interaction_pending"; role: ThreadRole; reason: string | null }
  | { type: "thread_failed"; role: ThreadRole; error: string }
  | { type: "verify_passed"; output: string }
  | { type: "verify_failed"; output: string }
  | { type: "pushed" }
  | { type: "pr_opened"; prNumber: number; prUrl: string }
  /** Ship or merge could not proceed for a reason a human has to fix (not an outage). */
  | { type: "ship_refused"; reason: string }
  | { type: "ci_passing" }
  | { type: "ci_failing"; log: string }
  | { type: "pr_merged" }
  | { type: "pr_closed" }
  /** Merge is configured but not possible yet (e.g. no approving review); stay ready and try again on the next CI pass. */
  | { type: "merge_waiting"; reason: string }
  /** A Chief of Staff job is not running (plugin restart, or its result was lost); start it again. */
  | { type: "resume_job" }
  /** An effect threw (host timeout, network, GitHub 5xx). Retried with backoff. */
  | { type: "effect_error"; effect: Effect; message: string }
  | { type: "retry_due" }
  | { type: "stalled" }
  // Human decisions from the dashboard / CLI.
  | { type: "approve" }
  | { type: "revise"; feedback: string }
  | { type: "retry" }
  | { type: "rerun_verify" };

export interface Transition {
  stage: StageOrDone;
  status: WorkStatus;
  patch: Partial<WorkItem>;
  effects: Effect[];
}

export interface MachinePolicy {
  autoRetryStalled: boolean;
  maxAutoRetries: number;
  /** Nudges per stage when the agent stops without reporting. */
  maxNudges: number;
  /** Infrastructure retries before asking a human. */
  maxInfraRetries: number;
}

export const DEFAULT_POLICY: MachinePolicy = { autoRetryStalled: false, maxAutoRetries: 1, maxNudges: 2, maxInfraRetries: 3 };

/** Backoff before infrastructure retry n (1-based): 1, 4, 9 minutes. */
export function infraBackoffMs(attempt: number): number {
  return Math.max(1, attempt) ** 2 * 60_000;
}

const label = (item: WorkItem) => (item.issueNumber ? `${item.repo}#${item.issueNumber}` : `${item.repo}: ${item.issueTitle || item.id.slice(0, 8)}`);
const JOB_EFFECTS = new Set<Effect["type"]>(["verify_command", "ship", "merge"]);

export function transition(item: WorkItem, event: MachineEvent, workflow: Workflow, policy: MachinePolicy = DEFAULT_POLICY): Transition {
  const stay = (effects: Effect[] = [], patch: Partial<WorkItem> = {}): Transition => ({ stage: item.stage, status: item.status, patch, effects });
  const counters = (delta: Partial<StageCounters>): StageCounters => ({ ...item.counters, ...delta });
  const skipReview = item.returnTo === "ship";

  /** Enter a stage: reset per-stage counters and emit what starts it. */
  const enter = (stage: StageOrDone, kind?: PromptKind, detail?: string, patch: Partial<WorkItem> = {}): Transition => {
    const base: Partial<WorkItem> = {
      waitingKind: null,
      waitingReason: null,
      pendingReport: null,
      pendingEffect: null,
      retryAt: null,
      lastError: null,
      ...patch,
      counters: { ...(patch.counters ?? item.counters), nudges: 0, infraRetries: 0 },
    };
    switch (stage) {
      case "done":
        return {
          stage: "done",
          status: "done",
          patch: { ...base, finishedAt: "now", returnTo: null },
          effects: [
            item.stage === "ship" || item.prUrl
              ? { type: "notify", title: `Shipped: ${label(item)}`, body: item.prUrl ? `Merged ${item.prUrl}` : "The branch is pushed." }
              : { type: "notify", title: `Finished: ${label(item)}`, body: "All enabled workflow stages are done (shipping is off for this repository)." },
          ],
        };
      case "plan":
        return { stage, status: "agent", patch: base, effects: [{ type: "prompt", target: "builder", kind: kind ?? "plan", detail }] };
      case "build":
        return { stage, status: "agent", patch: base, effects: [{ type: "prompt", target: "builder", kind: kind ?? "build", detail }] };
      case "verify":
        if (workflow.verify.command.trim()) return { stage, status: "cos", patch: { ...base, jobStartedAt: "now" }, effects: [{ type: "verify_command" }] };
        return { stage, status: "agent", patch: base, effects: [{ type: "prompt", target: "builder", kind: "verify" }] };
      case "review": {
        const target = workflow.review.mode === "agent" ? "reviewer" : "builder";
        return { stage, status: "agent", patch: base, effects: [{ type: "prompt", target, kind: (patch.counters ?? item.counters).reviewRounds > 0 ? "rereview" : "review" }] };
      }
      case "ship": {
        const shipPatch = { ...base, returnTo: null };
        // The agent writes the PR description when the ship stage has instructions and no PR exists yet.
        if (workflow.ship.action !== "push" && workflow.ship.instructions.trim() && !item.prNumber && !item.reports.ship) {
          return { stage, status: "agent", patch: shipPatch, effects: [{ type: "prompt", target: "builder", kind: "ship" }] };
        }
        return { stage, status: "cos", patch: { ...shipPatch, jobStartedAt: "now" }, effects: [{ type: "ship" }] };
      }
    }
  };

  const advance = (from: Stage, patch: Partial<WorkItem> = {}): Transition => enter(nextStage(workflow, from, { skipReview }), undefined, undefined, patch);

  const waitHuman = (kind: WaitingKind, reason: string, title: string, patch: Partial<WorkItem> = {}): Transition => ({
    stage: item.stage,
    status: "waiting_on_human",
    patch: { ...patch, waitingKind: kind, waitingReason: reason.slice(0, 600) },
    effects: [{ type: "notify", title: `${title}: ${label(item)}`, body: reason.slice(0, 500) }],
  });

  /** Verify (command or agent) failed: back to build on budget, else escalate. */
  const verifyFailed = (output: string): Transition => {
    const failures = item.counters.verifyFailures + 1;
    const patch = { checkOutput: output, counters: counters({ verifyFailures: failures }), fixAttempts: item.fixAttempts + 1 };
    if (failures <= workflow.verify.maxAttempts) return enter("build", "fix_verify", output, patch);
    return waitHuman("escalation", `Verify still failing after ${workflow.verify.maxAttempts} fix attempt(s). Approve to continue anyway, or send instructions back to the agent.`, "Verify keeps failing", { checkOutput: output, counters: counters({ verifyFailures: failures }) });
  };

  /** The role whose turns drive the current stage. */
  const drivingRole: ThreadRole = item.stage === "review" && workflow.review.mode === "agent" ? "reviewer" : "builder";

  switch (event.type) {
    case "start":
      if (item.status !== "queued") return stay();
      return enter(item.threadId ? (item.stage === "done" ? "build" : (item.stage as Stage)) : firstStage(workflow));

    case "thread_spawned":
      return stay([], event.role === "builder" ? { threadId: event.threadId, environmentId: event.environmentId } : { reviewThreadId: event.threadId });

    case "turn_started": {
      if (event.role !== drivingRole && !(event.role === "builder" && ["ci", "ready"].includes(item.status))) return stay();
      switch (item.status) {
        case "waiting_on_human":
          // A human answered or resumed the thread. A plan awaiting approval
          // that gets discussed in the thread goes back to planning.
          return { stage: item.stage, status: "agent", patch: { waitingKind: null, waitingReason: null, lastError: null, finishedAt: null, counters: counters({ nudges: 0 }) }, effects: [] };
        case "blocked":
        case "failed":
        case "retrying":
          return { stage: item.stage === "done" ? "build" : item.stage, status: "agent", patch: { waitingKind: null, waitingReason: null, lastError: null, finishedAt: null, retryAt: null, pendingEffect: null }, effects: [] };
        case "ci":
        case "ready":
          // Someone is pushing more work onto the open PR from the thread.
          return { stage: "build", status: "agent", patch: { returnTo: "ship" }, effects: [] };
        default:
          return stay();
      }
    }

    case "turn_ended": {
      if (item.status !== "agent" || event.role !== drivingRole) return stay();
      // Routine agents are free-form tasks, not workflow items: a finished turn finishes them.
      if (item.source.startsWith("routine:")) {
        if (event.question) return waitHuman("question", event.question, "Agent needs input");
        return { stage: "done", status: "done", patch: { finishedAt: "now" }, effects: [] };
      }
      const report = event.report && event.report.stage === item.stage ? event.report : null;
      if (!report) {
        if (event.question) return waitHuman("question", event.question, "Agent needs input", { pendingReport: null });
        if (item.counters.nudges < policy.maxNudges) {
          return { stage: item.stage, status: "agent", patch: { counters: counters({ nudges: item.counters.nudges + 1 }) }, effects: [{ type: "prompt", target: drivingRole, kind: "nudge" }] };
        }
        return waitHuman("no_report", `The agent stopped ${policy.maxNudges + 1} times without reporting the ${STAGE_LABEL[item.stage]} stage. Approve to treat the stage as done, or send it instructions.`, "Agent stopped without reporting");
      }
      return onReport(report);
    }

    case "interaction_pending":
      if (["done", "failed"].includes(item.status)) return stay();
      if (item.status === "waiting_on_human" && item.waitingKind === "question" && (!event.reason || event.reason === item.waitingReason)) return stay();
      return waitHuman("question", event.reason ?? "The agent is waiting for a human decision.", "Agent needs input");

    case "thread_failed":
      if (["done", "failed"].includes(item.status)) return stay();
      if (event.role === "reviewer") {
        return waitHuman("cos_error", `The reviewer thread failed: ${event.error}. Retry to start a new reviewer.`, "Reviewer failed", {
          reviewThreadId: null,
          pendingEffect: JSON.stringify({ type: "prompt", target: "reviewer", kind: "review" } satisfies Effect),
        });
      }
      if (policy.autoRetryStalled && item.retryCount < policy.maxAutoRetries && item.status === "agent") {
        return { stage: item.stage, status: "agent", patch: { retryCount: item.retryCount + 1, lastError: event.error }, effects: [{ type: "prompt", target: "builder", kind: stagePromptKind(item.stage), fresh: true }] };
      }
      return { stage: item.stage, status: "failed", patch: { lastError: event.error, finishedAt: "now" }, effects: [{ type: "notify", title: `Agent failed: ${label(item)}`, body: event.error.slice(0, 500) }] };

    case "verify_passed":
      if (item.stage !== "verify" || item.status !== "cos") return stay();
      if (workflow.verify.instructions.trim()) return { stage: "verify", status: "agent", patch: { checkOutput: event.output, jobStartedAt: null }, effects: [{ type: "prompt", target: "builder", kind: "verify" }] };
      return advance("verify", { checkOutput: event.output, jobStartedAt: null });

    case "verify_failed":
      if (item.stage !== "verify" || item.status !== "cos") return stay();
      return verifyFailed(event.output);

    case "pushed":
      if (item.stage !== "ship") return stay();
      return enter("done", undefined, undefined, { jobStartedAt: null });

    case "pr_opened":
      if (item.stage !== "ship") return stay([], { prNumber: event.prNumber, prUrl: event.prUrl });
      return { stage: "ship", status: "ci", patch: { prNumber: event.prNumber, prUrl: event.prUrl, jobStartedAt: null, lastError: null }, effects: [] };

    case "ship_refused":
      return waitHuman("escalation", event.reason, "Cannot ship", { jobStartedAt: null });

    case "ci_passing":
      if (item.stage !== "ship" || (item.status !== "ci" && item.status !== "ready")) return stay();
      if (workflow.ship.action === "merge") return { stage: "ship", status: "cos", patch: { jobStartedAt: "now", lastError: null }, effects: [{ type: "merge" }] };
      return { stage: "ship", status: "ready", patch: { lastError: null }, effects: item.status === "ready" ? [] : [{ type: "notify", title: `PR ready to merge: ${label(item)}`, body: item.prUrl ?? "" }] };

    case "ci_failing": {
      if (item.stage !== "ship" || (item.status !== "ci" && item.status !== "ready")) return stay();
      const fixes = item.counters.ciFixes + 1;
      if (fixes <= workflow.ship.maxCiFixes) return enter("build", "fix_ci", event.log, { checkOutput: event.log, counters: counters({ ciFixes: fixes }), fixAttempts: item.fixAttempts + 1, returnTo: "ship" });
      return waitHuman("escalation", `CI is red on PR #${item.prNumber} after ${workflow.ship.maxCiFixes} fix attempt(s). Send instructions back to the agent, or fix it by hand.`, "CI failing", { checkOutput: event.log, counters: counters({ ciFixes: fixes }) });
    }

    case "pr_merged":
      if (item.status === "done") return stay();
      return enter("done", undefined, undefined, { jobStartedAt: null });

    case "merge_waiting":
      if (item.stage !== "ship") return stay();
      return { stage: "ship", status: "ready", patch: { jobStartedAt: null, lastError: event.reason.slice(0, 500) }, effects: [] };

    case "resume_job": {
      if (item.status !== "cos") return stay();
      const effect: Effect | null = item.stage === "verify" ? { type: "verify_command" } : item.stage === "ship" ? (item.prNumber && workflow.ship.action === "merge" ? { type: "merge" } : { type: "ship" }) : null;
      if (!effect) return enter(item.stage === "done" ? "build" : item.stage);
      return { stage: item.stage, status: "cos", patch: { jobStartedAt: "now" }, effects: [effect] };
    }

    case "pr_closed":
      if (item.status === "done") return stay();
      return { stage: "done", status: "done", patch: { finishedAt: "now", lastError: "PR closed without merge", jobStartedAt: null }, effects: [] };

    case "effect_error": {
      if (["done", "failed"].includes(item.status)) return stay();
      const attempt = item.counters.infraRetries + 1;
      const pendingEffect = JSON.stringify(event.effect);
      if (attempt <= policy.maxInfraRetries) {
        return { stage: item.stage, status: "retrying", patch: { pendingEffect, retryAt: `+${infraBackoffMs(attempt)}`, lastError: event.message.slice(0, 1000), counters: counters({ infraRetries: attempt }), jobStartedAt: null }, effects: [] };
      }
      return waitHuman(
        "cos_error",
        `Chief of Staff could not ${EFFECT_LABEL[event.effect.type]} after ${policy.maxInfraRetries} retries (the agent is not asking anything): ${event.message}`,
        "Chief of Staff needs help",
        { pendingEffect, lastError: event.message.slice(0, 1000), jobStartedAt: null },
      );
    }

    case "retry_due": {
      if (item.status !== "retrying" || !item.pendingEffect) return stay();
      return rerunPending(item.pendingEffect);
    }

    case "stalled":
      if (item.status !== "agent") return stay();
      if (policy.autoRetryStalled && item.retryCount < policy.maxAutoRetries) {
        return { stage: item.stage, status: "agent", patch: { retryCount: item.retryCount + 1, lastError: "stalled" }, effects: [{ type: "prompt", target: drivingRole, kind: stagePromptKind(item.stage), fresh: true }, { type: "notify", title: `Agent stalled, retrying: ${label(item)}`, body: "No activity past the stall threshold; starting a fresh thread." }] };
      }
      return { stage: item.stage, status: "blocked", patch: { lastError: "stalled" }, effects: [{ type: "notify", title: `Agent stalled: ${label(item)}`, body: "No activity past the stall threshold." }] };

    case "approve":
      if (item.status !== "waiting_on_human" && item.status !== "blocked") return stay();
      if (item.stage === "done") return stay();
      // An open question is answered, not approved; Chief of Staff's own failure is retried.
      if (item.status === "waiting_on_human" && (item.waitingKind === "question" || item.waitingKind === "cos_error")) return stay();
      // Plan approved, or the human vouches for a stage that is stuck: move on.
      return advance(item.stage);

    case "revise": {
      if (item.status !== "waiting_on_human" && item.status !== "blocked") return stay();
      const feedback = event.feedback.trim();
      if (item.stage === "plan") return enter("plan", "plan_revise", feedback);
      return enter("build", "fix_human", feedback, { fixAttempts: item.fixAttempts + 1, returnTo: item.stage === "ship" ? "ship" : item.returnTo });
    }

    case "retry":
      if (item.status === "done") return stay();
      if (item.pendingEffect) return rerunPending(item.pendingEffect, { retryCount: item.retryCount + 1 });
      if (item.status === "queued") return enter(item.threadId ? (item.stage as Stage) : firstStage(workflow));
      // Re-enter the current stage; a failed item gets a fresh thread.
      {
        const stage = item.stage === "done" ? "build" : item.stage;
        const t = enter(stage, undefined, undefined, { retryCount: item.retryCount + 1, finishedAt: null });
        if (item.status === "failed") t.effects = t.effects.map((e) => (e.type === "prompt" && e.target === "builder" ? { ...e, fresh: true } : e));
        return t;
      }

    case "rerun_verify":
      if (["done"].includes(item.status)) return stay();
      return enter("verify", undefined, undefined, { finishedAt: null });

    default:
      return stay();
  }

  function onReport(report: StageReport): Transition {
    const reports = { ...item.reports, [report.stage]: report };
    const outcome: ReportOutcome = report.outcome;
    if (outcome === "needs_input") return waitHuman("question", report.question || report.summary, "Agent needs input", { pendingReport: null, reports });
    switch (report.stage) {
      case "plan":
        if (outcome !== "done") break;
        if (workflow.plan.requireApproval) return waitHuman("plan_approval", "Plan ready for your approval.", "Plan ready", { reports, pendingReport: null });
        return advance("plan", { reports });
      case "build":
        if (outcome !== "done") break;
        return advance("build", { reports });
      case "verify":
        if (outcome === "failed") return verifyFailed(report.summary);
        if (outcome !== "done") break;
        return advance("verify", { reports });
      case "review": {
        if (outcome === "done") return advance("review", { reports });
        if (outcome !== "changes_requested") break;
        const rounds = item.counters.reviewRounds + 1;
        if (rounds <= workflow.review.maxRounds) return enter("build", "fix_review", report.summary, { reports, counters: counters({ reviewRounds: rounds }), fixAttempts: item.fixAttempts + 1 });
        return waitHuman("escalation", `Review still requests changes after ${workflow.review.maxRounds} round(s). Approve to ship anyway, or send instructions back to the agent.`, "Review keeps requesting changes", { reports, counters: counters({ reviewRounds: rounds }) });
      }
      case "ship":
        if (outcome !== "done") break;
        return { stage: "ship", status: "cos", patch: { reports, pendingReport: null, jobStartedAt: "now" }, effects: [{ type: "ship" }] };
    }
    return waitHuman("escalation", `The agent reported "${outcome}" for ${STAGE_LABEL[report.stage]}: ${report.summary}`, "Agent is stuck", { reports, pendingReport: null });
  }

  function rerunPending(raw: string, extra: Partial<WorkItem> = {}): Transition {
    let effect: Effect;
    try {
      effect = JSON.parse(raw) as Effect;
    } catch {
      return enter(item.stage === "done" ? "build" : item.stage, undefined, undefined, extra);
    }
    const status: WorkStatus = JOB_EFFECTS.has(effect.type) ? "cos" : "agent";
    return {
      stage: item.stage,
      status,
      patch: { ...extra, pendingEffect: null, retryAt: null, waitingKind: null, waitingReason: null, finishedAt: null, ...(status === "cos" ? { jobStartedAt: "now" } : {}) },
      effects: [effect],
    };
  }
}

export const EFFECT_LABEL: Record<Effect["type"], string> = {
  prompt: "send the agent its next prompt",
  verify_command: "run the verify command",
  ship: "push the branch and open the pull request",
  merge: "merge the pull request",
  notify: "send a notification",
};

/** The prompt that (re)starts a stage from scratch. */
export function stagePromptKind(stage: StageOrDone): PromptKind {
  switch (stage) {
    case "plan":
      return "plan";
    case "verify":
      return "verify";
    case "review":
      return "review";
    case "ship":
      return "ship";
    default:
      return "build";
  }
}

export type Actor = "agent" | "cos" | "human" | "system" | "none";

/** Who holds the ball right now, for the dashboard. */
export function actorOf(item: Pick<WorkItem, "status">): Actor {
  switch (item.status) {
    case "agent":
      return "agent";
    case "cos":
    case "ci":
      return "cos";
    case "waiting_on_human":
    case "blocked":
    case "ready":
      return "human";
    case "retrying":
    case "queued":
      return "system";
    default:
      return "none";
  }
}

/** Map an item to the roster's coarse, human-facing status. */
export function rosterStatus(item: WorkItem): "queued" | "running" | "waiting on human" | "blocked" | "done" | "failed" {
  switch (item.status) {
    case "queued":
      return "queued";
    case "agent":
    case "cos":
    case "ci":
    case "ready":
    case "retrying":
      return "running";
    case "waiting_on_human":
      return "waiting on human";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

export { ZERO_COUNTERS };
