// RPC contract shared by server.ts (handlers) and app.tsx (typed client).
// Only zod + defineRpcContract here so the frontend bundle stays small.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Finished roster items per page: the default and the most one page may ask for. */
export const ROSTER_FINISHED_LIMIT = 50;
export const ROSTER_FINISHED_MAX = 500;
export const finishedLimitSchema = z.number().int().min(1).max(ROSTER_FINISHED_MAX).default(ROSTER_FINISHED_LIMIT);
/** An earlier roster page's opaque nextBefore cursor. */
export const rosterCursorSchema = z.string().min(1).max(1000);

const cost = z.object({ amount: z.number(), currency: z.string() });
/**
 * A task's usage summed over all its agent threads. Token fields are null when
 * no thread reported them (never 0). `counted` is false for a finished task
 * whose usage is not counted yet.
 */
const itemUsage = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  cost: cost.nullable(),
  /** Agent threads summed, and how many of them reported usage. */
  threads: z.number(),
  reportedThreads: z.number(),
  counted: z.boolean(),
});

const rosterEntry = z.object({
  occupiesCapacity: z.boolean(),
  id: z.string(),
  status: z.enum(["queued", "running", "waiting on human", "blocked", "done", "failed"]),
  detail: z.string(),
  workflowName: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(["agent", "check", "ship", "model"]),
      depth: z.number(),
      status: z.enum(["pending", "running", "waiting", "done", "stopped"]),
      phase: z.string().nullable(),
      agents: z.number(),
      reported: z.number(),
      nudged: z.number(),
      attempts: z.number(),
      round: z.number(),
      waitingKind: z.string().nullable(),
      retrying: z.boolean(),
    }),
  ),
  current: z.array(z.string()),
  actor: z.enum(["agent", "cos", "human", "system", "none"]),
  activity: z.string(),
  waitingKind: z.string().nullable(),
  repo: z.string(),
  issueNumber: z.number().nullable(),
  issueUrl: z.string().nullable(),
  issueTitle: z.string(),
  threadId: z.string().nullable(),
  threadStatus: z.string().nullable(),
  threadTitle: z.string().nullable(),
  branch: z.string().nullable(),
  prNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
  /** The pull request's last read state (see PrState); null when not read yet. */
  pr: z
    .object({
      state: z.enum(["open", "merged", "closed"]),
      draft: z.boolean(),
      checks: z.enum(["passing", "failing", "pending", "none"]).nullable(),
      review: z.enum(["approved", "changes_requested"]).nullable(),
      checkedAt: z.string(),
    })
    .nullable(),
  startedAt: z.string(),
  /** When a done or failed task finished; null while it runs (and on some legacy rows). */
  finishedAt: z.string().nullable(),
  /** How a finished task ended (src/outcome.ts); null while it runs. */
  outcome: z.enum(["merged", "pr_opened", "completed", "marked_done", "failed", "marked_failed", "pr_closed"]).nullable(),
  lastActivityAt: z.string().nullable(),
  stalled: z.boolean(),
  fixAttempts: z.number(),
  retryCount: z.number(),
  lastError: z.string().nullable(),
  waitingReason: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  source: z.string(),
  /** With withUsage: the task's usage summed over all its agent threads (see ItemUsage); null without. */
  usage: itemUsage.nullable(),
});

const logEntry = z.object({ id: z.number(), at: z.string(), level: z.string(), kind: z.string(), repo: z.string().nullable(), workItemId: z.string().nullable(), issueNumber: z.number().nullable(), issueTitle: z.string().nullable(), message: z.string(), actor: z.string() });

/** Scalar plugin settings the configurator edits (everything except repos/workflow/token). */
export const generalSettingsSchema = z.object({
  maxConcurrentTotal: z.number().int().min(0).max(100),
  stallThresholdMinutes: z.number().int().min(1).max(1440),
  intakeIntervalMinutes: z.number().int().min(1).max(1440),
  defaultProviderId: z.string().max(200),
  defaultModel: z.string().max(200),
  notifyPush: z.boolean(),
  archiveThreadsOnDone: z.boolean(),
});
export type GeneralSettings = z.output<typeof generalSettingsSchema>;
/** Read side: no range checks, so values set elsewhere (CLI, host fields) never break the configurator. */
const generalSettingsValuesSchema = z.object({
  maxConcurrentTotal: z.number(),
  stallThresholdMinutes: z.number(),
  intakeIntervalMinutes: z.number(),
  defaultProviderId: z.string(),
  defaultModel: z.string(),
  notifyPush: z.boolean(),
  archiveThreadsOnDone: z.boolean(),
});

const decision = z.enum(["allow_once", "allow_for_session", "deny"]);
const openQuestion = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    interactionId: z.string(),
    questions: z.array(z.object({ id: z.string(), prompt: z.string(), shortLabel: z.string().nullable(), options: z.array(z.object({ label: z.string(), value: z.string(), description: z.string().nullable() })), allowFreeText: z.boolean(), multiSelect: z.boolean(), required: z.boolean() })),
  }),
  z.object({ kind: z.literal("approval"), interactionId: z.string(), subject: z.string(), reason: z.string().nullable(), detail: z.string().nullable(), detailMarkdown: z.boolean(), decisions: z.array(decision) }),
  z.object({ kind: z.literal("request"), interactionId: z.string(), title: z.string(), detail: z.string().nullable(), answerable: z.boolean() }),
  z.object({ kind: z.literal("text"), question: z.string() }),
]);
export type OpenQuestion = z.output<typeof openQuestion>;
const questionView = z.object({
  itemId: z.string(),
  repo: z.string(),
  issueNumber: z.number().nullable(),
  issueTitle: z.string(),
  threadId: z.string().nullable(),
  threadUrl: z.string().nullable(),
  status: z.string(),
  stepId: z.string().nullable(),
  stepName: z.string().nullable(),
  waitingKind: z.string().nullable(),
  waitingReason: z.string().nullable(),
  /** The waiting step's report (what you approve), all agents combined. */
  report: z.string().nullable(),
  /** Whether Approve / Send back apply. */
  decidable: z.boolean(),
  open: z.array(openQuestion),
  lastMessage: z.string().nullable(),
  checkOutput: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type QuestionView = z.output<typeof questionView>;
const answerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), interactionId: z.string().max(200), answers: z.record(z.string().max(200), z.object({ selected: z.array(z.string().max(500)).max(50), freeText: z.string().max(10000).optional() })) }),
  z.object({ kind: z.literal("approval"), interactionId: z.string().max(200), decision }),
  z.object({ kind: z.literal("request"), interactionId: z.string().max(200), value: z.string().max(20000) }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(20000) }),
  /** Approve the waiting step's report, or move past a stuck step. */
  z.object({ kind: z.literal("approve") }),
  /** Send the waiting step back to the agent with feedback. */
  z.object({ kind: z.literal("revise"), feedback: z.string().min(1).max(20000) }),
]);
export type AnswerPayload = z.input<typeof answerInput>;

const taskDetail = z.object({
  repo: z.string(),
  issueNumber: z.number().nullable(),
  issueUrl: z.string().nullable(),
  body: z.string().nullable(),
  status: z.string(),
  branch: z.string().nullable(),
  prNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
  threadId: z.string().nullable(),
  waitingReason: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  lastActivityAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** A finished task's stored usage over all its threads (no usage calls); null while it runs: read that once with cos_item_usage. */
  usage: itemUsage.nullable().optional(),
});

const stepDetail = z.object({
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Why the step runs again: failure output, review findings or operator feedback. */
  feedback: z.string().nullable(),
  /** Check output or CI log of the latest run. */
  output: z.string().nullable(),
  waitingReason: z.string().nullable(),
  reports: z.array(z.object({ agent: z.number(), outcome: z.string(), summary: z.string(), at: z.string() })),
  threads: z.array(z.object({ threadId: z.string(), agent: z.number() })),
});

const journalRecord = z.object({
  id: z.number(),
  at: z.string(),
  step: z.string(),
  round: z.number(),
  kind: z.enum(["started", "reported", "passed", "failed", "waiting", "revised", "rerun", "interrupted", "stopped"]),
  agent: z.number().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** A preview when `truncated`: fetch the whole text with cos_journal_detail. */
  detail: z.string().nullable(),
  truncated: z.boolean().optional(),
  actor: z.string(),
});

export const rpcContract = defineRpcContract({
  cos_overview: {
    input: z.null(),
    output: z.object({
      paused: z.boolean(),
      occupiedCapacity: z.number(),
      tokenSource: z.enum(["setting", "gh-cli", "none"]),
      repos: z.array(z.object({ key: z.string(), projectId: z.string(), maxConcurrent: z.number(), active: z.number(), labels: z.array(z.string()), intake: z.boolean(), paused: z.boolean(), workflowId: z.string(), workflowName: z.string(), stepNames: z.array(z.string()) })),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
      settings: z.object({ stallThresholdMinutes: z.number(), maxConcurrentTotal: z.number(), intakeIntervalMinutes: z.number(), archiveThreadsOnDone: z.boolean() }),
    }),
  },
  cos_set_paused: { input: z.object({ paused: z.boolean() }), output: z.object({ paused: z.boolean() }) },
  cos_set_repo_paused: { input: z.object({ repo: z.string().max(200), paused: z.boolean() }), output: z.object({ repo: z.string(), paused: z.boolean() }) },
  cos_roster: {
    input: z.object({
      repo: z.string().optional(),
      includeDone: z.boolean().default(false),
      /** Finished items per page. */
      finishedLimit: finishedLimitSchema,
      /** An earlier page's nextBefore: return only the next page of finished items. */
      before: rosterCursorSchema.optional(),
      /** Finished items most recently finished first, or most tokens first. A cursor belongs to its order. */
      finishedOrder: z.enum(["recent", "tokens"]).default("recent"),
      withUsage: z.boolean().default(false),
    }),
    output: z.object({
      entries: z.array(rosterEntry),
      nextBefore: z.string().nullable(),
      /** With finished items: tokens of every finished task in scope (all pages), for each task's share; null when none reported tokens. */
      finishedTokens: z.number().nullable(),
    }),
  },
  cos_intake_now: { input: z.object({ repo: z.string().optional(), dryRun: z.boolean().default(false) }), output: z.object({ results: z.array(z.object({ repo: z.string(), considered: z.number(), started: z.array(z.object({ issue: z.number(), threadId: z.string() })), skipped: z.array(z.object({ issue: z.number(), reason: z.string() })), error: z.string().optional() })) }) },
  cos_item_action: {
    input: z.object({ id: z.string(), action: z.enum(["retry", "rerun_step", "approve", "mark_done", "mark_failed"]), step: z.string().max(40).optional(), feedback: z.string().max(20000).optional() }),
    output: z.object({ status: z.string() }),
  },
  cos_item_workflow: {
    input: z.object({ id: z.string() }),
    output: z.object({
      title: z.string(),
      /** The workflow the task runs (a Workflow document). */
      workflow: z.any(),
      live: z.record(z.string(), z.object({ status: z.enum(["pending", "running", "waiting", "done", "stopped"]), phase: z.string().nullable(), reported: z.number(), agents: z.number(), waitingKind: z.string().nullable(), retrying: z.boolean(), attempts: z.number(), round: z.number(), picked: z.string().nullable().optional() })),
      /** The task itself. */
      task: taskDetail.optional(),
      /** Each step's current round: what it received, what it produced, who works on it. */
      steps: z.record(z.string(), stepDetail).optional(),
      /** What happened to each step, oldest first, kept across re-runs. Empty for tasks started before it was recorded. */
      journal: z.array(journalRecord).optional(),
    }),
  },
  /** A task's usage over all its agent threads: stored for a finished task, read live (several usage calls) for an active one. */
  cos_item_usage: { input: z.object({ id: z.string() }), output: z.object({ usage: itemUsage.nullable() }) },
  cos_journal_detail: { input: z.object({ itemId: z.string(), id: z.number().int() }), output: z.object({ detail: z.string().nullable() }) },
  cos_start_task: { input: z.object({ repo: z.string().min(3).max(200), title: z.string().max(200).optional(), body: z.string().max(20000).default("") }), output: z.object({ id: z.string(), workflow: z.string(), status: z.string() }) },
  cos_question: { input: z.object({ id: z.string() }), output: questionView },
  cos_answer: { input: z.object({ id: z.string(), answer: answerInput }), output: z.object({ status: z.string() }) },
  cos_stats: {
    input: z.object({ windowDays: z.number().int().min(1).max(90).default(14) }),
    output: z.object({
      byStatus: z.record(z.string(), z.number()),
      /** `tokens`: of the tasks that finished that day, summed over their threads; null when none reported tokens. */
      daily: z.array(z.object({ date: z.string(), started: z.number(), done: z.number(), failed: z.number(), tokens: z.number().nullable() })),
      windowDays: z.number(),
      startedInWindow: z.number(),
      doneInWindow: z.number(),
      failedInWindow: z.number(),
      medianCycleMinutes: z.number().nullable(),
      totalTracked: z.number(),
      /** Token usage of the done and failed tasks finished in the window (src/stats.ts UsageStats). */
      usage: z.object({
        totalTokens: z.number().nullable(),
        cost: z.array(cost),
        counted: z.number(),
        unreported: z.number(),
        pending: z.number(),
        medianTokensPerDone: z.number().nullable(),
      }),
    }),
  },
  cos_log: { input: z.object({ limit: z.number().int().min(1).max(500).default(100), workItemId: z.string().optional(), onlyProblems: z.boolean().default(false), before: z.number().int().positive().optional() }), output: z.object({ entries: z.array(logEntry), nextCursor: z.number().int().nullable() }) },
  cos_get_config: { input: z.null(), output: z.object({ repos: z.string(), workflow: z.string() }) },
  cos_set_config: { input: z.object({ repos: z.string().optional(), workflow: z.string().optional() }), output: z.object({ ok: z.literal(true), warnings: z.array(z.string()) }) },
  cos_get_settings: {
    input: z.null(),
    output: z.object({
      values: generalSettingsValuesSchema,
      /** Whether a token is stored in settings. The value itself never leaves the server. */
      token: z.object({ stored: z.boolean(), source: z.enum(["setting", "gh-cli", "none"]) }),
      projects: z.array(z.object({ id: z.string(), name: z.string(), remote: z.string().nullable() })),
      providers: z.array(z.object({ id: z.string(), displayName: z.string(), available: z.boolean(), enabled: z.boolean() })),
    }),
  },
  /** Skills agents can use, for the `/` typeahead in step instructions: those of the configured repos' projects, by name. */
  cos_skills: {
    input: z.null(),
    output: z.object({ skills: z.array(z.object({ name: z.string(), description: z.string().nullable(), scope: z.string().nullable() })) }),
  },
  cos_set_settings: {
    input: generalSettingsSchema.partial().extend({ githubToken: z.string().min(1).max(500).optional(), clearGithubToken: z.boolean().optional() }),
    output: z.object({ ok: z.literal(true), changed: z.array(z.string()) }),
  },
});
