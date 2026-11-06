// Pure issue -> thread -> PR state machine. No I/O: given a work item and an
// event, return the next status plus the side effects the caller must run.
import type { WorkItem, WorkStatus } from "./state";

export type MachineEvent =
  | { type: "thread_spawned"; threadId: string; environmentId: string | null }
  | { type: "thread_active" }
  | { type: "thread_idle" }
  | { type: "thread_failed"; error: string }
  | { type: "thread_waiting_on_human"; reason?: string | null }
  | { type: "checks_passed" }
  | { type: "checks_failed"; output: string }
  | { type: "pr_opened"; prNumber: number; prUrl: string }
  | { type: "pr_open_failed"; error: string }
  | { type: "ci_passing" }
  | { type: "ci_failing"; log: string }
  | { type: "pr_merged" }
  | { type: "pr_closed" }
  | { type: "stalled" }
  | { type: "retry" }
  | { type: "human_resume" };

export type Effect =
  | { type: "run_checks" }
  | { type: "open_pr" }
  | { type: "send_fix_prompt"; log: string; reason: "checks" | "ci" }
  | { type: "notify"; title: string; body: string }
  | { type: "respawn" }
  | { type: "watch_ci" };

export interface Transition {
  status: WorkStatus;
  patch: Partial<WorkItem>;
  effects: Effect[];
}

export interface MachinePolicy {
  maxFixRetries: number;
  autoRetryStalled: boolean;
  maxAutoRetries: number;
}

export const DEFAULT_POLICY: MachinePolicy = { maxFixRetries: 1, autoRetryStalled: false, maxAutoRetries: 1 };

const label = (item: WorkItem) => (item.issueNumber ? `${item.repo}#${item.issueNumber}` : `${item.repo} (${item.id})`);

export function transition(item: WorkItem, event: MachineEvent, policy: MachinePolicy = DEFAULT_POLICY): Transition {
  const stay = (effects: Effect[] = [], patch: Partial<WorkItem> = {}): Transition => ({ status: item.status, patch, effects });
  switch (event.type) {
    case "thread_spawned":
      return { status: "running", patch: { threadId: event.threadId, environmentId: event.environmentId, lastError: null }, effects: [] };
    case "thread_active":
      // The thread started a turn. Either we started it (spawn, fix prompt) or
      // a human answered / resumed it in BB. Either way it is working again.
      switch (item.status) {
        case "queued":
          return { status: "running", patch: {}, effects: [] };
        case "waiting_on_human":
        case "blocked":
        case "failed":
          // Human resume: fresh fix budget, clear the stale error.
          return { status: "running", patch: { fixAttempts: 0, lastError: null, finishedAt: null }, effects: [] };
        case "pr_open":
        case "ci_failed":
          // Someone is pushing more work onto an open PR; the next idle re-runs
          // checks and pushes the new commits to the same branch.
          return { status: "running", patch: {}, effects: [] };
        default:
          return stay();
      }
    case "thread_waiting_on_human": {
      if (["done", "failed"].includes(item.status)) return stay();
      const reason = event.reason?.trim() || null;
      if (item.status === "waiting_on_human" && (reason === null || reason === item.waitingReason)) return stay();
      return {
        status: "waiting_on_human",
        patch: { waitingReason: reason ?? item.waitingReason ?? null },
        effects: [{ type: "notify", title: `Agent needs input: ${label(item)}`, body: reason ? reason.slice(0, 500) : "The thread is waiting for a human decision." }],
      };
    }
    case "thread_idle": {
      // The agent finished a turn. From running/fixing we move to checking.
      if (item.status === "running" || item.status === "fixing") {
        return { status: "checking", patch: {}, effects: [{ type: "run_checks" }] };
      }
      return stay();
    }
    case "thread_failed":
      if (["done"].includes(item.status)) return stay();
      if (policy.autoRetryStalled && item.retryCount < policy.maxAutoRetries && item.status === "running") {
        return { status: "queued", patch: { retryCount: item.retryCount + 1, lastError: event.error }, effects: [{ type: "respawn" }] };
      }
      return { status: "failed", patch: { lastError: event.error, finishedAt: "now" }, effects: [{ type: "notify", title: `Agent failed: ${label(item)}`, body: event.error.slice(0, 500) }] };
    case "checks_passed":
      if (item.status !== "checking") return stay();
      if (item.prNumber) return { status: "pr_open", patch: { checkOutput: null }, effects: [{ type: "watch_ci" }] };
      return { status: "checking", patch: { checkOutput: null }, effects: [{ type: "open_pr" }] };
    case "checks_failed":
      if (item.status !== "checking") return stay();
      if (item.fixAttempts < policy.maxFixRetries) {
        return { status: "fixing", patch: { fixAttempts: item.fixAttempts + 1, checkOutput: event.output }, effects: [{ type: "send_fix_prompt", log: event.output, reason: "checks" }] };
      }
      return {
        status: "waiting_on_human",
        patch: { checkOutput: event.output },
        effects: [{ type: "notify", title: `Checks keep failing: ${label(item)}`, body: `Exceeded ${policy.maxFixRetries} fix attempt(s). A human needs to look.` }],
      };
    case "pr_opened":
      return { status: "pr_open", patch: { prNumber: event.prNumber, prUrl: event.prUrl }, effects: [{ type: "watch_ci" }] };
    case "pr_open_failed":
      return { status: "waiting_on_human", patch: { lastError: event.error }, effects: [{ type: "notify", title: `Could not open PR: ${label(item)}`, body: event.error.slice(0, 500) }] };
    case "ci_passing":
      if (item.status !== "pr_open" && item.status !== "ci_failed") return stay();
      return { status: "pr_open", patch: { lastError: null }, effects: [] };
    case "ci_failing":
      if (item.status !== "pr_open") return stay();
      if (item.fixAttempts < policy.maxFixRetries) {
        return { status: "fixing", patch: { fixAttempts: item.fixAttempts + 1, checkOutput: event.log }, effects: [{ type: "send_fix_prompt", log: event.log, reason: "ci" }] };
      }
      return {
        status: "waiting_on_human",
        patch: { checkOutput: event.log },
        effects: [{ type: "notify", title: `CI failing: ${label(item)}`, body: `PR #${item.prNumber} is red after ${policy.maxFixRetries} fix attempt(s).` }],
      };
    case "pr_merged":
      return { status: "done", patch: { finishedAt: "now" }, effects: [] };
    case "pr_closed":
      if (item.status === "done") return stay();
      return { status: "done", patch: { finishedAt: "now", lastError: "PR closed without merge" }, effects: [] };
    case "stalled":
      if (!["running", "fixing"].includes(item.status)) return stay();
      if (policy.autoRetryStalled && item.retryCount < policy.maxAutoRetries) {
        return { status: "queued", patch: { retryCount: item.retryCount + 1, lastError: "stalled" }, effects: [{ type: "respawn" }, { type: "notify", title: `Agent stalled, retrying: ${label(item)}`, body: "No activity past the stall threshold; respawning once." }] };
      }
      return { status: "blocked", patch: { lastError: "stalled" }, effects: [{ type: "notify", title: `Agent stalled: ${label(item)}`, body: "No activity past the stall threshold." }] };
    case "retry":
      if (["done"].includes(item.status)) return stay();
      return { status: "queued", patch: { retryCount: item.retryCount + 1, fixAttempts: 0, lastError: null }, effects: [{ type: "respawn" }] };
    case "human_resume":
      if (item.prNumber) return { status: "pr_open", patch: { fixAttempts: 0, lastError: null }, effects: [{ type: "watch_ci" }] };
      return { status: "running", patch: { fixAttempts: 0, lastError: null }, effects: [] };
    default:
      return stay();
  }
}

/** Map a BB thread runtime status to the roster's human-facing status. */
export function rosterStatus(item: WorkItem): "queued" | "running" | "waiting on human" | "blocked" | "done" | "failed" {
  switch (item.status) {
    case "queued":
      return "queued";
    case "running":
    case "checking":
    case "pr_open":
    case "ci_failed":
    case "fixing":
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
