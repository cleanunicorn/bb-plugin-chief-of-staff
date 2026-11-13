// Pure workflow engine. Given a work item (its workflow snapshot and the state
// of each step) and an event, return the new step states, an item patch and
// the side effects to run. No I/O.
//
// Scheduling: a pending step starts when every step pointing at it is done.
// Several ready steps start together (parallel); a step with several inputs
// waits for all of them (join). A failing verdict, check or CI resets the
// step's `onFail` target and everything downstream of it, and the work re-runs
// from there with the failure as feedback, up to the step's limit, then waits
// on a person. The item is done when every final step is done.
import type { WaitingKind, WorkItem } from "./state";
import { agentWork, chosenModel, descendants, finalSteps, isWriter, pickedModel, predecessors, stepById, topoOrder, type ModelPick, type Step, type Workflow } from "./workflow";

export type ReportOutcome = "done" | "failed" | "needs_input";

export interface StepReport {
  delivery?: string;
  outcome: ReportOutcome;
  summary: string;
  question?: string | null;
  /** On a step with model choices: the id of the one the agent picked. */
  choice?: string | null;
  /** On an automatic model step: the provider, model and reasoning level the agent picked. */
  pick?: ModelPick | null;
  at: string;
  via: "tool" | "text";
}

export type NodeStatus = "pending" | "running" | "waiting" | "done";
export type ShipPhase = "pushing" | "ci" | "ready" | "merging";

export interface AgentDelivery {
  id: string;
  round: number;
  threadId: string | null;
  state: "sending" | "accepted" | "uncertain";
  sentAt: number;
}

export interface InfraRetry {
  cause?: "prompt_delivery" | "thread_failure";
  effect: Effect;
  at: string | null;
  count: number;
  uncertain?: boolean;
  /** Times the effect was put off for a rate limit (these do not count as retries). */
  deferrals?: number;
}

/** Old thread-failure retries are distinguished by fresh:true; they predate cause. */
export function isPromptDeliveryRetry(retry: InfraRetry | null | undefined): boolean {
  return retry?.effect.type === "agent" && (retry.cause === "prompt_delivery" || (retry.cause === undefined && !retry.effect.fresh));
}

export interface NodeState {
  agentRetries?: Record<number, InfraRetry>;
  deliveries?: Record<number, AgentDelivery>;
  status: NodeStatus;
  /** Incremented every time the step starts; work from an older round is ignored. */
  round: number;
  /** Failures charged to this step (verdict, check or CI) across rounds. */
  attempts: number;
  /** One slot per agent working on the step, for the current round. */
  reports: (StepReport | null)[];
  nudges: number[];
  waiting: { kind: WaitingKind; reason: string; agent?: number } | null;
  /** Why the step is running again (failure output, review findings, operator feedback). */
  feedback: string | null;
  /** Ship only. */
  phase: ShipPhase | null;
  /** Check output or CI log of the latest run. */
  output: string | null;
  /** Infrastructure retry of the step's last effect. */
  retry: InfraRetry | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type Nodes = Record<string, NodeState>;

export type Effect =
  /** Send an agent working on `step` its prompt (spawning its thread when needed). */
  | { type: "agent"; step: string; agent: number; kind: "start" | "nudge"; fresh?: boolean }
  /** Run a check step's command in the worktree (detached job). */
  | { type: "check"; step: string }
  /** Commit leftovers, push, open/find the PR (detached job). */
  | { type: "ship"; step: string }
  /** Merge the PR (detached job). */
  | { type: "merge"; step: string }
  | { type: "notify"; title: string; body: string };

export type MachineEvent =
  | { type: "start" }
  | { type: "turn_started"; step: string; agent: number }
  | { type: "turn_ended"; step: string; agent: number; round: number; report: StepReport | null; question: string | null }
  | { type: "interaction_pending"; step: string; agent: number; reason: string | null }
  /** `step` null: the builder thread itself is gone. */
  | { type: "thread_failed"; step: string | null; agent: number; error: string }
  | { type: "check_result"; step: string; ok: boolean; output: string }
  | { type: "pushed"; step: string }
  | { type: "pr_opened"; step: string; prNumber: number; prUrl: string }
  | { type: "ship_refused"; step: string; reason: string }
  | { type: "ci_passing" }
  | { type: "ci_failing"; log: string }
  | { type: "merge_waiting"; reason: string }
  | { type: "pr_merged" }
  | { type: "pr_closed" }
  /** `retryAt`: the effect was refused for a rate limit; run it again then, without counting a retry. */
  | { type: "effect_error"; step: string; effect: Effect; message: string; uncertain?: boolean; retryAt?: string }
  | { type: "delivery_ack"; step: string; agent: number; round: number }
  | { type: "retry_due"; step: string }
  /** Jobs this process is not running (restart): start them again. */
  | { type: "resume_job" }
  /** `reason`: why it counts as stalled (default: no activity past the threshold). */
  | { type: "stalled"; step: string; agent: number; reason?: string }
  // Operator decisions. `step` defaults to the step waiting on them.
  | { type: "approve"; step?: string }
  | { type: "revise"; step?: string; feedback: string }
  | { type: "retry"; step?: string }
  /** A failed item's builder thread was resumed in BB: un-fail it, no new prompts. */
  | { type: "revive" }
  /** Run a step again from scratch (and everything after it). */
  | { type: "rerun"; step: string; feedback?: string };

export interface MachinePolicy {
  maxNudges: number;
  maxInfraRetries: number;
}

export const DEFAULT_POLICY: MachinePolicy = { maxNudges: 2, maxInfraRetries: 3 };

export type JournalKind = "started" | "reported" | "passed" | "failed" | "waiting" | "revised" | "rerun" | "interrupted" | "stopped";

/** One thing that happened to a step, kept after the step's state is reset (see the step_journal table). */
export interface JournalEntry {
  kind: JournalKind;
  step: string;
  round: number;
  /** "reported": which agent. */
  agent?: number;
  /** The step that sent work back ("failed", "revised"), or whose loop-back cut this run short ("interrupted"). */
  from?: string;
  /** Where the work goes back to ("failed" within budget, "revised", "rerun"). */
  to?: string;
  /** Feedback, report summary, output or reason, clipped. */
  detail: string | null;
}

export const JOURNAL_DETAIL_MAX = 4_000;
/** Failures and check output keep their end (where the error is); the rest keeps its start. */
const clipDetail = (text: string | null | undefined, keepEnd: boolean) => {
  if (!text || text.length <= JOURNAL_DETAIL_MAX) return text || null;
  return keepEnd ? `…${text.slice(-JOURNAL_DETAIL_MAX)}` : `${text.slice(0, JOURNAL_DETAIL_MAX)}…`;
};

export interface Transition {
  nodes: Nodes;
  patch: Partial<WorkItem>;
  effects: Effect[];
  /** What happened, for the task's history. */
  journal: JournalEntry[];
}

/**
 * Rate-limit deferrals of one step's effect (until it succeeds) before they
 * count as ordinary retries, so an effect that keeps drawing a limit ends up
 * in front of a person.
 */
export const MAX_RATE_LIMIT_DEFERRALS = 10;

/** Backoff before infrastructure retry n (1-based): 1, 4, 9 minutes. */
export function infraBackoffMs(attempt: number): number {
  return Math.max(1, attempt) ** 2 * 60_000;
}

export function freshNode(): NodeState {
  return { agentRetries: {}, deliveries: {}, status: "pending", round: 0, attempts: 0, reports: [], nudges: [], waiting: null, feedback: null, phase: null, output: null, retry: null, startedAt: null, finishedAt: null };
}

export function initialNodes(wf: Workflow): Nodes {
  return Object.fromEntries(wf.steps.map((s) => [s.id, freshNode()]));
}

const agentsOf = (step: Step) => agentWork(step)?.agents ?? 1;
const limitOf = (step: Step) => agentWork(step)?.maxRounds ?? (step.type === "check" || step.type === "ship" ? step.maxAttempts : 0);
/** How notifications and warnings name a task: `owner/repo#N`, or `owner/repo: title`. */
export const label = (item: Pick<WorkItem, "repo" | "issueNumber" | "issueTitle" | "id">) => (item.issueNumber ? `${item.repo}#${item.issueNumber}` : `${item.repo}: ${item.issueTitle || item.id.slice(0, 8)}`);

const WAIT_TITLE: Record<WaitingKind, string> = {
  question: "Agent needs input",
  approval: "Ready for your approval",
  escalation: "Needs your decision",
  no_report: "Agent stopped without reporting",
  cos_error: "Chief of Staff needs help",
  stalled: "Agent stalled",
};

export function transition(item: WorkItem, event: MachineEvent, policy: MachinePolicy = DEFAULT_POLICY, now: Date = new Date()): Transition {
  const wf = item.workflow;
  const nodes: Nodes = Object.fromEntries(Object.entries(item.nodes).map(([k, v]) => [k, { ...v, reports: [...v.reports], nudges: [...v.nudges] }]));
  for (const s of wf.steps) if (!nodes[s.id]) nodes[s.id] = freshNode();
  const effects: Effect[] = [];
  const journal: JournalEntry[] = [];
  const patch: Partial<WorkItem> = {};
  const iso = now.toISOString();
  const step = (id: string) => stepById(wf, id);
  const node = (id: string) => nodes[id];
  const note = (kind: JournalKind, id: string, detail: string | null | undefined, extra: Partial<Pick<JournalEntry, "agent" | "from" | "to">> = {}) =>
    journal.push({ kind, step: id, round: node(id)?.round ?? 0, ...extra, detail: clipDetail(detail, kind === "failed" || kind === "passed") });

  // ---- primitives ----

  const start = (id: string) => {
    const s = step(id);
    const n = node(id);
    if (!s || !n) return;
    const count = agentsOf(s);
    Object.assign(n, { agentRetries: {}, deliveries: {}, status: "running", round: n.round + 1, reports: Array(count).fill(null), nudges: Array(count).fill(0), waiting: null, phase: null, retry: null, startedAt: iso, finishedAt: null });
    note("started", id, n.feedback);
    if (agentWork(s)) for (let i = 0; i < count; i++) effects.push({ type: "agent", step: id, agent: i, kind: "start" });
    else if (s.type === "model") {
      // Fixed: nothing to run; agent steps after it read its settings when they spawn.
      Object.assign(n, { status: "done", finishedAt: iso });
      note("passed", id, null);
    } else if (s.type === "check") {
      patch.jobStartedAt = iso;
      effects.push({ type: "check", step: id });
    } else {
      n.phase = "pushing";
      patch.jobStartedAt = iso;
      effects.push({ type: "ship", step: id });
    }
  };

  const complete = (id: string, how: string | null = null) => {
    const n = node(id);
    if (!n) return;
    note("passed", id, how ?? (step(id)?.type === "check" ? n.output : null));
    Object.assign(n, { status: "done", waiting: null, feedback: null, phase: null, retry: null, agentRetries: {}, finishedAt: iso });
  };

  const wait = (id: string, kind: WaitingKind, reason: string, agent?: number) => {
    const n = node(id);
    if (!n) return;
    n.status = "waiting";
    n.waiting = { kind, reason: reason.slice(0, 600), ...(agent !== undefined ? { agent } : {}) };
    note("waiting", id, reason);
    effects.push({ type: "notify", title: `${WAIT_TITLE[kind]}: ${label(item)}`, body: `${step(id)?.name ?? id}: ${reason}`.slice(0, 500) });
  };

  /** Reset `target` and everything after it; `target` re-runs with `feedback`. */
  /** `by`: the step whose failure or revision caused the reset; null when you re-ran it. */
  const resetFrom = (target: string, feedback: string | null, by: string | null) => {
    for (const d of descendants(wf, target)) {
      const n = node(d);
      if (!n) continue;
      // Work in progress downstream is thrown away: say so. The target re-runs and the step that caused the reset has its own entry.
      if ((n.status === "running" || n.status === "waiting") && d !== by && d !== target) note("interrupted", d, null, { ...(by ? { from: by } : {}), to: target });
      Object.assign(n, { ...freshNode(), round: n.round, attempts: n.attempts, output: n.output });
    }
    const t = node(target);
    if (t) t.feedback = feedback;
  };

  /** A step failed (verdict, check, CI): loop back on budget, else ask a person. */
  const fail = (id: string, detail: string) => {
    const s = step(id);
    const n = node(id);
    if (!s || !n) return;
    n.attempts += 1;
    n.output = detail.slice(-12_000);
    const loops = Boolean(s.onFail && n.attempts <= limitOf(s));
    note("failed", id, detail, loops ? { from: id, to: s.onFail } : {});
    if (s.onFail && loops) {
      resetFrom(s.onFail, `${s.name} failed:\n\n${detail}`.slice(-12_000), id);
      return;
    }
    const why = s.onFail ? `failed ${n.attempts} time(s), past its limit of ${limitOf(s)}` : "failed";
    wait(id, "escalation", `${s.name} ${why}. Approve to continue anyway, or send instructions back.`);
  };

  /** Every agent on an agent step has reported: pass it on, gate it, or fail it. */
  const agentStepFinished = (id: string) => {
    const s = agentWork(step(id));
    const n = node(id);
    if (!s || !n) return;
    const failed = n.reports.filter((r) => r?.outcome === "failed");
    if (failed.length) {
      if (s.verdict) return fail(id, failed.map((r) => r!.summary).join("\n\n---\n\n"));
      return wait(id, "escalation", `The agent reported it could not finish: ${failed[0]!.summary}`);
    }
    if (s.picksModel && !pickedModel(n)) return wait(id, "escalation", "The agent did not pick a model. Approve to continue with the current model, or send it instructions.");
    if (s.chooses.length && !chosenModel(s, n)) return wait(id, "escalation", `The agent did not pick one of the model choices (${s.chooses.map((c) => c.id).join(", ")}). Approve to continue with the current model, or send it instructions.`);
    if (s.approval) return wait(id, "approval", `${s.name} is ready for your approval.`);
    complete(id);
  };

  /** The waiting (or targeted) step for an operator decision. */
  const target = (id?: string) => (id ? (node(id) ? id : undefined) : topoOrder(wf).find((sid) => node(sid)?.status === "waiting"));

  /** The ship step currently tracking a PR. */
  const shipNode = () => wf.steps.find((s) => s.type === "ship" && node(s.id)?.status === "running" && node(s.id)?.phase && node(s.id)!.phase !== "pushing")?.id;

  const selectAgentRetry = (n: NodeState) => {
    const retries = Object.values(n.agentRetries ?? {});
    const parked = retries.find((r) => !isPromptDeliveryRetry(r)) ?? retries.find((r) => r.uncertain || r.count > policy.maxInfraRetries);
    n.retry = parked ?? retries.sort((a, b) => (a.at ?? "~").localeCompare(b.at ?? "~"))[0] ?? null;
    if (parked && n.status === "running") {
      n.status = "waiting";
      n.waiting = { kind: "cos_error", reason: "Another agent's prompt delivery still needs reconciliation.", ...(parked.effect.type === "agent" ? { agent: parked.effect.agent } : {}) };
    }
    if (n.status === "waiting" && n.waiting?.kind === "cos_error") {
      if (!parked) { n.status = "running"; n.waiting = null; }
      else if (parked.effect.type === "agent") n.waiting = { ...n.waiting, agent: parked.effect.agent };
    }
  };

  // ---- events ----

  switch (event.type) {
    case "start":
      break; // scheduling below starts the entry steps

    case "turn_started": {
      const n = node(event.step);
      if (!n || n.status !== "waiting" || !n.waiting) break;
      if (["question", "no_report", "stalled"].includes(n.waiting.kind)) {
        n.status = "running";
        n.waiting = null;
        n.nudges = n.nudges.map(() => 0);
      }
      break;
    }

    case "turn_ended": {
      const s = agentWork(step(event.step));
      const n = node(event.step);
      if (!s || !n || (n.status !== "running" && !(event.report && n.status === "waiting" && n.waiting?.kind === "cos_error" && isPromptDeliveryRetry(n.retry))) || event.round !== n.round) break;
      if (n.reports[event.agent]) break; // this agent already reported
      const report = event.report;
      if (report?.outcome === "needs_input") {
        wait(event.step, "question", report.question || report.summary, event.agent);
        break;
      }
      if (report) {
        n.reports[event.agent] = report;
        note("reported", event.step, report.summary, { agent: event.agent });
        if (n.agentRetries && Object.keys(n.agentRetries).length) {
          n.agentRetries = { ...n.agentRetries };
          delete n.agentRetries[event.agent];
          selectAgentRetry(n);
        } else if (n.retry?.effect.type === "agent" && n.retry.effect.agent === event.agent) n.retry = null;
        if (n.reports.every(Boolean)) agentStepFinished(event.step);
        break;
      }
      if (event.question) {
        wait(event.step, "question", event.question, event.agent);
        break;
      }
      const nudged = n.nudges[event.agent] ?? 0;
      if (nudged < policy.maxNudges) {
        n.nudges[event.agent] = nudged + 1;
        effects.push({ type: "agent", step: event.step, agent: event.agent, kind: "nudge" });
      } else {
        wait(event.step, "no_report", `The agent stopped ${policy.maxNudges + 1} times without reporting ${s.name}. Approve to treat it as done, or send it instructions.`, event.agent);
      }
      break;
    }

    case "interaction_pending": {
      const n = node(event.step);
      if (!n || (n.status !== "running" && !(n.status === "waiting" && n.waiting?.kind === "question"))) break;
      const reason = event.reason ?? "The agent is waiting for a human decision.";
      if (n.waiting?.kind === "question" && n.waiting.reason === reason.slice(0, 600)) break;
      wait(event.step, "question", reason, event.agent);
      break;
    }

    case "thread_failed": {
      if (event.step === null) {
        const writer = wf.steps.find((s) => agentWork(s)?.writes && (node(s.id)?.status === "running" || node(s.id)?.status === "waiting"));
        if (writer) note("stopped", writer.id, `The builder thread failed: ${event.error}`);
        patch.status = "failed";
        patch.lastError = event.error;
        patch.finishedAt = iso;
        effects.push({ type: "notify", title: `Agent failed: ${label(item)}`, body: event.error.slice(0, 500) });
        return { nodes, patch, effects, journal };
      }
      const n = node(event.step);
      if (!n || n.status === "done" || n.status === "pending") break;
      n.retry = { cause: "thread_failure", effect: { type: "agent", step: event.step, agent: event.agent, kind: "start", fresh: true }, at: null, count: 0 };
      n.agentRetries = { ...n.agentRetries, [event.agent]: n.retry };
      wait(event.step, "cos_error", `The agent's thread failed (${event.error}). Retry starts a new one.`, event.agent);
      break;
    }

    case "check_result": {
      const n = node(event.step);
      if (!n || n.status !== "running" || step(event.step)?.type !== "check") break;
      patch.jobStartedAt = null;
      n.output = event.output.slice(-12_000);
      if (event.ok) complete(event.step);
      else fail(event.step, event.output);
      break;
    }

    case "pushed": {
      if (node(event.step)?.status !== "running") break;
      patch.jobStartedAt = null;
      complete(event.step, "Branch pushed");
      break;
    }

    case "pr_opened": {
      const n = node(event.step);
      patch.prNumber = event.prNumber;
      patch.prUrl = event.prUrl;
      if (!n || n.status !== "running") break;
      patch.jobStartedAt = null;
      n.retry = null;
      const s = step(event.step);
      if (s?.type === "ship" && s.action === "pr") complete(event.step, `Opened pull request #${event.prNumber}`);
      else n.phase = "ci";
      break;
    }

    case "ship_refused": {
      if (node(event.step)?.status !== "running") break;
      patch.jobStartedAt = null;
      wait(event.step, "escalation", event.reason);
      break;
    }

    case "ci_passing": {
      const id = shipNode();
      const s = id ? step(id) : undefined;
      const n = id ? node(id) : undefined;
      if (!id || !s || s.type !== "ship" || !n || (n.phase !== "ci" && n.phase !== "ready")) break;
      if (s.action === "merge") {
        n.phase = "merging";
        patch.jobStartedAt = iso;
        effects.push({ type: "merge", step: id });
      } else if (n.phase === "ci") {
        n.phase = "ready";
        effects.push({ type: "notify", title: `PR ready to merge: ${label(item)}`, body: item.prUrl ?? "" });
      }
      break;
    }

    case "ci_failing": {
      const id = shipNode();
      const n = id ? node(id) : undefined;
      if (!id || !n || (n.phase !== "ci" && n.phase !== "ready")) break;
      fail(id, event.log);
      break;
    }

    case "merge_waiting": {
      const id = wf.steps.find((s) => node(s.id)?.phase === "merging")?.id;
      if (!id) break;
      node(id)!.phase = "ready";
      patch.jobStartedAt = null;
      patch.lastError = event.reason.slice(0, 500);
      break;
    }

    case "pr_merged": {
      // Confirm delivery and its prerequisites, then schedule successors normally.
      const ship = topoOrder(wf).find((id) => step(id)?.type === "ship" && node(id)?.status !== "done");
      if (!ship) break;
      patch.jobStartedAt = null;
      for (const s of wf.steps) {
        if (node(s.id)?.status !== "done" && (s.id === ship || descendants(wf, s.id).has(ship))) complete(s.id, s.id === ship ? "Pull request merged" : "Completed by the merge");
      }
      break;
    }

    case "pr_closed": {
      if (item.status === "done" || item.status === "failed") break;
      const ship = shipNode() ?? topoOrder(wf).find((id) => step(id)?.type === "ship" && node(id)?.status !== "done");
      if (ship) note("stopped", ship, `Pull request${item.prNumber ? ` #${item.prNumber}` : ""} was closed without merging`);
      patch.lastError = "PR closed without merge";
      patch.jobStartedAt = null;
      patch.status = "failed";
      patch.finishedAt = iso;
      return { nodes, patch, effects, journal };
    }

    case "delivery_ack": {
      const n = node(event.step);
      if (!n || n.round !== event.round) break;
      if (n.status === "waiting" && n.waiting?.kind === "cos_error" && !isPromptDeliveryRetry(n.retry)) break;
      if (n.agentRetries && Object.keys(n.agentRetries).length) {
        n.agentRetries = { ...n.agentRetries };
        if (!isPromptDeliveryRetry(n.agentRetries[event.agent])) break;
        delete n.agentRetries[event.agent];
        selectAgentRetry(n);
        break;
      }
      const retry = n.retry?.effect;
      if (!isPromptDeliveryRetry(n.retry) || retry?.type !== "agent" || retry.agent !== event.agent || retry.step !== event.step) break;
      n.retry = null;
      if (n.status === "waiting" && n.waiting?.kind === "cos_error") {
        n.status = "running";
        n.waiting = null;
      }
      break;
    }

    case "effect_error": {
      const n = node(event.step);
      if (!n || n.status === "done" || n.status === "pending") break;
      // Carry legacy node-level retries into the per-agent map before adding
      // a sibling's error, so its failed-thread wait cannot be overwritten.
      const agentRetries = { ...(n.retry?.effect.type === "agent" ? { [n.retry.effect.agent]: n.retry } : {}), ...n.agentRetries };
      const previous = event.effect.type === "agent" ? agentRetries[event.effect.agent] : n.retry;
      // An interrupted send must not reclassify a known dead thread as a
      // recoverable prompt error. Only an explicit retry replaces that thread.
      if (event.effect.type === "agent" && previous && !isPromptDeliveryRetry(previous)) break;
      const count = (previous?.count ?? 0) + 1;
      const deferrals = previous?.deferrals ?? 0;
      if (event.effect.type !== "agent") patch.jobStartedAt = null;
      patch.lastError = event.message.slice(0, 1000);
      if (event.uncertain) {
        if (event.effect.type === "agent" && n.deliveries?.[event.effect.agent]) {
          n.deliveries = { ...n.deliveries, [event.effect.agent]: { ...n.deliveries[event.effect.agent], state: "uncertain" } };
        }
        n.retry = { effect: event.effect, at: null, count, uncertain: true };
        wait(event.step, "cos_error", `Prompt delivery is uncertain; automatic resend is disabled. A matching agent report can recover it. ${event.message}`, event.effect.type === "agent" ? event.effect.agent : undefined);
      } else if (event.retryAt && deferrals < MAX_RATE_LIMIT_DEFERRALS) {
        // Waiting out a rate limit is not a failure: run again at the reset.
        n.retry = { effect: event.effect, at: event.retryAt, count: previous?.count ?? 0, uncertain: false, deferrals: deferrals + 1 };
      } else if (count <= policy.maxInfraRetries) {
        n.retry = { effect: event.effect, at: new Date(now.getTime() + infraBackoffMs(count)).toISOString(), count, uncertain: false, ...(deferrals ? { deferrals } : {}) };
      } else {
        n.retry = { effect: event.effect, at: null, count, uncertain: false, ...(deferrals ? { deferrals } : {}) };
        wait(event.step, "cos_error", `Chief of Staff could not ${EFFECT_LABEL[event.effect.type]} after ${policy.maxInfraRetries} retries (the agent is not asking anything): ${event.message}`);
      }
      if (event.effect.type === "agent" && n.retry) {
        n.retry.cause = "prompt_delivery";
        n.agentRetries = { ...agentRetries, [event.effect.agent]: n.retry };
        selectAgentRetry(n);
      }
      break;
    }

    case "retry_due": {
      const n = node(event.step);
      if (!n || n.status === "pending" || n.status === "done" || (n.status === "waiting" && n.waiting?.kind !== "cos_error")) break;
      if (n?.agentRetries && Object.keys(n.agentRetries).length) {
        n.agentRetries = { ...n.agentRetries };
        for (const [agent, retry] of Object.entries(n.agentRetries)) {
          if (!retry.at || Date.parse(retry.at) > now.getTime() || retry.uncertain) continue;
          n.agentRetries[Number(agent)] = { ...retry, at: null };
          effects.push(retry.effect);
        }
        selectAgentRetry(n);
        break;
      }
      if (!n?.retry?.at || n.status === "waiting") break;
      const effect = n.retry.effect;
      n.retry = { ...n.retry, at: null };
      if (effect.type !== "agent" && effect.type !== "notify") patch.jobStartedAt = iso;
      effects.push(effect);
      break;
    }

    case "resume_job": {
      for (const s of wf.steps) {
        const n = node(s.id);
        if (n?.status !== "running" || n.retry?.at) continue;
        if (s.type === "check") effects.push({ type: "check", step: s.id });
        else if (s.type === "ship" && n.phase === "pushing") effects.push({ type: "ship", step: s.id });
        else if (s.type === "ship" && n.phase === "merging") effects.push({ type: "merge", step: s.id });
        else continue;
        patch.jobStartedAt = iso;
      }
      break;
    }

    case "stalled": {
      const n = node(event.step);
      if (n?.status !== "running" || !agentWork(step(event.step))) break;
      wait(event.step, "stalled", event.reason ?? "No activity past the stall threshold.", event.agent);
      break;
    }

    case "approve": {
      const id = target(event.step);
      const n = id ? node(id) : undefined;
      const s = id ? step(id) : undefined;
      if (!id || !n || !s || n.status !== "waiting" || !n.waiting) break;
      // An open question is answered, not approved; Chief of Staff's own failure is retried.
      if (n.waiting.kind === "question" || n.waiting.kind === "cos_error") break;
      if (s.type === "ship" && item.prNumber) {
        // Shipping is not over while the PR is open: keep watching it.
        n.status = "running";
        n.waiting = null;
        n.phase = "ready";
        break;
      }
      complete(id, n.waiting.kind === "approval" ? "Approved" : "Approved to continue");
      break;
    }

    case "revise": {
      const id = target(event.step);
      const n = id ? node(id) : undefined;
      const s = id ? step(id) : undefined;
      const feedback = event.feedback.trim();
      if (!id || !n || !s || n.status !== "waiting" || !n.waiting || !feedback) break;
      if (n.waiting.kind === "question" || n.waiting.kind === "cos_error") break;
      const message = `Feedback from the operator:\n\n${feedback}`;
      const to = n.waiting.kind === "escalation" ? (s.onFail ?? id) : id;
      note("revised", id, feedback, { from: id, to });
      if (n.waiting.kind === "escalation") n.attempts = 0;
      resetFrom(to, message, id);
      break;
    }

    case "retry": {
      if (item.status === "failed") {
        // The builder died: restart the writing step that was running with a fresh thread.
        patch.status = undefined;
        patch.lastError = null;
        patch.finishedAt = null;
        const writer = wf.steps.find((s) => isWriter(s) && node(s.id)?.status !== "done" && node(s.id)?.status !== "pending");
        if (writer) {
          start(writer.id);
          for (const e of effects) if (e.type === "agent" && e.step === writer.id) e.fresh = true;
        }
        break;
      }
      const id = target(event.step);
      const n = id ? node(id) : undefined;
      if (!id || !n) break;
      if (n.retry) {
        const effect = n.retry.effect;
        if (effect.type === "agent" && n.agentRetries) {
          n.agentRetries = { ...n.agentRetries };
          delete n.agentRetries[effect.agent];
        }
        n.retry = null;
        if (n.status === "waiting") {
          n.status = "running";
          n.waiting = null;
        }
        if (effect.type === "agent" && n.agentRetries) selectAgentRetry(n);
        if (effect.type !== "agent" && effect.type !== "notify") patch.jobStartedAt = iso;
        effects.push(effect);
      } else if (n.status !== "pending") {
        note("rerun", id, null, { to: id });
        resetFrom(id, n.feedback, null);
      }
      break;
    }

    case "revive": {
      if (item.status !== "failed") break;
      patch.status = undefined;
      patch.lastError = null;
      patch.finishedAt = null;
      break;
    }

    case "rerun": {
      if (!node(event.step)) break;
      note("rerun", event.step, event.feedback?.trim() || null, { to: event.step });
      resetFrom(event.step, event.feedback?.trim() ? `Feedback from the operator:\n\n${event.feedback.trim()}` : null, null);
      if (item.status === "failed") {
        patch.status = undefined;
        patch.lastError = null;
        patch.finishedAt = null;
      }
      break;
    }
  }

  // ---- schedule: start every pending step whose inputs are all done ----
  const failed = ("status" in patch ? patch.status : item.status) === "failed";
  if (!failed) {
    for (const id of topoOrder(wf)) {
      const n = node(id);
      if (n?.status !== "pending") continue;
      if (predecessors(wf, id).every((p) => node(p)?.status === "done")) start(id);
    }
  }

  // ---- finished? ----
  const finals = finalSteps(wf);
  if (item.status !== "done" && patch.status !== "done" && finals.every((id) => node(id)?.status === "done")) {
    patch.finishedAt = iso;
    patch.jobStartedAt = null;
    const shipped = wf.steps.some((s) => s.type === "ship");
    effects.push(shipped ? { type: "notify", title: `Shipped: ${label(item)}`, body: (patch.prUrl ?? item.prUrl) ? `Done: ${patch.prUrl ?? item.prUrl}` : "Workflow finished." } : { type: "notify", title: `Finished: ${label(item)}`, body: "Every step of the workflow is done." });
  }

  // ---- recovered? ----
  // On a running item lastError holds an effect error, a merge wait reason or
  // an engine error. An effect error stays while its retry is pending; once no
  // step holds one (a delivery went through, a report arrived, the operator
  // retried, or it was resolved before this rule existed) the error is
  // history and must not stay on the card next to "agent working".
  const finishing = item.status === "done" || patch.status === "done";
  const mergeWait = wf.steps.some((s) => s.type === "ship" && (node(s.id)?.phase === "ready" || node(s.id)?.phase === "merging"));
  if (!failed && !finishing && !mergeWait && item.lastError && !item.lastError.startsWith(ENGINE_ERROR_PREFIX) && !("lastError" in patch) && !Object.values(nodes).some(holdsRetry)) {
    patch.lastError = null;
  }

  return { nodes, patch, effects, journal };
}

/** How an error thrown by `transition` itself starts in lastError (see delivery). */
/** Why a queued task waits while its repository is missing from the `repos` setting. */
export function repoNotConfiguredReason(repo: string): string {
  return `Repository ${repo} is not in the repos setting (or the setting has an error). The task starts once ${repo} is configured again, or close the task.`;
}

export const ENGINE_ERROR_PREFIX = "Chief of Staff could not handle ";

/** The step still has an effect error to retry or to show the operator. */
function holdsRetry(n: NodeState | undefined): boolean {
  return !!n && (!!n.retry || Object.keys(n.agentRetries ?? {}).length > 0 || n.waiting?.kind === "cos_error");
}

export const EFFECT_LABEL: Record<Effect["type"], string> = {
  agent: "send the agent its prompt",
  check: "run the check command",
  ship: "push the branch and open the pull request",
  merge: "merge the pull request",
  notify: "send a notification",
};

// ---------- derived item status ----------

export type ItemStatus = WorkItem["status"];

/** The item's coarse status, from its step states (who holds the ball). */
export function deriveStatus(item: Pick<WorkItem, "status" | "workflow">, nodes: Nodes): { status: ItemStatus; waitingKind: WaitingKind | null; waitingReason: string | null } {
  if (item.status === "failed") return { status: "failed", waitingKind: null, waitingReason: null };
  const wf = item.workflow;
  if (finalSteps(wf).every((id) => nodes[id]?.status === "done")) return { status: "done", waitingKind: null, waitingReason: null };
  const order = topoOrder(wf);
  const waiting = order.map((id) => ({ id, n: nodes[id] })).find((x) => x.n?.status === "waiting" && x.n.waiting);
  if (waiting) {
    const w = waiting.n!.waiting!;
    const name = stepById(wf, waiting.id)?.name ?? waiting.id;
    return { status: w.kind === "stalled" ? "blocked" : "waiting_on_human", waitingKind: w.kind, waitingReason: `${name}: ${w.reason}`.slice(0, 600) };
  }
  const running = order.map((id) => ({ s: stepById(wf, id)!, n: nodes[id] })).filter((x) => x.n?.status === "running");
  const active = running.filter((x) => !x.n!.retry?.at);
  if (active.some((x) => agentWork(x.s))) return { status: "agent", waitingKind: null, waitingReason: null };
  if (active.some((x) => x.s.type === "check" || x.n!.phase === "pushing" || x.n!.phase === "merging")) return { status: "cos", waitingKind: null, waitingReason: null };
  if (active.some((x) => x.n!.phase === "ci")) return { status: "ci", waitingKind: null, waitingReason: null };
  if (active.some((x) => x.n!.phase === "ready")) return { status: "ready", waitingKind: null, waitingReason: null };
  if (running.length) return { status: "retrying", waitingKind: null, waitingReason: null };
  return { status: "queued", waitingKind: null, waitingReason: null };
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
export function rosterStatus(item: Pick<WorkItem, "status">): "queued" | "running" | "waiting on human" | "blocked" | "done" | "failed" {
  switch (item.status) {
    case "queued":
      return "queued";
    case "waiting_on_human":
      return "waiting on human";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}
