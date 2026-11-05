// RPC contract shared by server.ts (handlers) and app.tsx (typed client).
// Only zod + defineRpcContract here so the frontend bundle stays small.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const rosterEntry = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "waiting on human", "blocked", "done", "failed"]),
  detail: z.string(),
  repo: z.string(),
  issueNumber: z.number().nullable(),
  issueTitle: z.string(),
  threadId: z.string().nullable(),
  threadStatus: z.string().nullable(),
  threadTitle: z.string().nullable(),
  branch: z.string().nullable(),
  prNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
  startedAt: z.string(),
  lastActivityAt: z.string().nullable(),
  stalled: z.boolean(),
  fixAttempts: z.number(),
  retryCount: z.number(),
  lastError: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  source: z.string(),
  usage: z
    .object({
      inputTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      totalTokens: z.number().nullable(),
      cost: z.object({ amount: z.number(), currency: z.string() }).nullable(),
    })
    .nullable(),
});

const stepResult = z.object({ index: z.number(), type: z.string(), status: z.string(), summary: z.string(), details: z.unknown().optional(), startedAt: z.string(), finishedAt: z.string() });
const runSchema = z.object({ id: z.string(), routine: z.string(), repo: z.string(), triggeredBy: z.string(), dryRun: z.boolean(), status: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(), steps: z.array(stepResult) });
const logEntry = z.object({ id: z.number(), at: z.string(), level: z.string(), kind: z.string(), repo: z.string().nullable(), workItemId: z.string().nullable(), message: z.string(), actor: z.string() });

/** Scalar plugin settings the configurator edits (everything except repos/routines/token). */
export const generalSettingsSchema = z.object({
  maxConcurrentTotal: z.number().int().min(0).max(100),
  stallThresholdMinutes: z.number().int().min(1).max(1440),
  maxFixRetries: z.number().int().min(0).max(10),
  autoRetryStalled: z.boolean(),
  intakeIntervalMinutes: z.number().int().min(1).max(1440),
  ciPollIntervalMinutes: z.number().int().min(1).max(120),
  defaultProviderId: z.string().max(200),
  defaultModel: z.string().max(200),
  notifyPush: z.boolean(),
  notifyWebhookUrl: z.string().max(2000),
});
export type GeneralSettings = z.output<typeof generalSettingsSchema>;
/** Read side: no range checks, so values set elsewhere (CLI, host fields) never break the configurator. */
const generalSettingsValuesSchema = z.object({
  maxConcurrentTotal: z.number(),
  stallThresholdMinutes: z.number(),
  maxFixRetries: z.number(),
  autoRetryStalled: z.boolean(),
  intakeIntervalMinutes: z.number(),
  ciPollIntervalMinutes: z.number(),
  defaultProviderId: z.string(),
  defaultModel: z.string(),
  notifyPush: z.boolean(),
  notifyWebhookUrl: z.string(),
});

export const rpcContract = defineRpcContract({
  cos_overview: {
    input: z.null(),
    output: z.object({
      tokenSource: z.enum(["setting", "gh-cli", "none"]),
      repos: z.array(z.object({ key: z.string(), projectId: z.string(), maxConcurrent: z.number(), active: z.number(), labels: z.array(z.string()), allow: z.object({ intake: z.boolean(), openPr: z.boolean(), merge: z.boolean(), release: z.boolean(), deploy: z.boolean() }), checkCommand: z.string().nullable(), deployCommand: z.string().nullable(), deployWorkflow: z.string().nullable() })),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
      settings: z.object({ stallThresholdMinutes: z.number(), maxFixRetries: z.number(), maxConcurrentTotal: z.number(), autoRetryStalled: z.boolean(), intakeIntervalMinutes: z.number() }),
    }),
  },
  cos_roster: { input: z.object({ repo: z.string().optional(), includeDone: z.boolean().default(false), withUsage: z.boolean().default(false) }), output: z.object({ entries: z.array(rosterEntry) }) },
  cos_routines: {
    input: z.null(),
    output: z.object({ routines: z.array(z.object({ name: z.string(), repo: z.string(), enabled: z.boolean(), schedule: z.string().nullable(), nextRunAt: z.string().nullable(), lastRunAt: z.string().nullable(), dryRun: z.boolean(), steps: z.array(z.string()), running: z.boolean(), configured: z.boolean() })) }),
  },
  cos_runs: { input: z.object({ routine: z.string().optional(), limit: z.number().int().min(1).max(200).default(30) }), output: z.object({ runs: z.array(runSchema) }) },
  cos_run_routine: { input: z.object({ name: z.string(), dryRun: z.boolean().optional() }), output: runSchema },
  cos_set_routine_enabled: { input: z.object({ name: z.string(), enabled: z.boolean() }), output: z.object({ ok: z.literal(true) }) },
  cos_intake_now: { input: z.object({ repo: z.string().optional(), dryRun: z.boolean().default(false) }), output: z.object({ results: z.array(z.object({ repo: z.string(), considered: z.number(), started: z.array(z.object({ issue: z.number(), threadId: z.string() })), skipped: z.array(z.object({ issue: z.number(), reason: z.string() })), error: z.string().optional() })) }) },
  cos_item_action: { input: z.object({ id: z.string(), action: z.enum(["retry", "resume", "rerun_checks", "mark_done", "mark_failed"]) }), output: z.object({ status: z.string() }) },
  cos_stats: {
    input: z.object({ windowDays: z.number().int().min(1).max(90).default(14) }),
    output: z.object({
      byStatus: z.record(z.string(), z.number()),
      daily: z.array(z.object({ date: z.string(), started: z.number(), done: z.number(), failed: z.number() })),
      windowDays: z.number(),
      startedInWindow: z.number(),
      doneInWindow: z.number(),
      failedInWindow: z.number(),
      medianCycleMinutes: z.number().nullable(),
      totalTracked: z.number(),
      runs: z.object({ succeeded: z.number(), failed: z.number(), partial: z.number(), running: z.number() }),
    }),
  },
  cos_log: { input: z.object({ limit: z.number().int().min(1).max(500).default(100), workItemId: z.string().optional() }), output: z.object({ entries: z.array(logEntry) }) },
  cos_merge_preview: { input: z.object({ repo: z.string() }), output: z.object({ decisions: z.array(z.object({ number: z.number(), action: z.string(), reason: z.string(), title: z.string(), headRef: z.string() })) }) },
  cos_get_config: { input: z.null(), output: z.object({ repos: z.string(), routines: z.string() }) },
  cos_set_config: { input: z.object({ repos: z.string().optional(), routines: z.string().optional() }), output: z.object({ ok: z.literal(true), warnings: z.array(z.string()) }) },
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
  cos_set_settings: {
    input: generalSettingsSchema.partial().extend({ githubToken: z.string().min(1).max(500).optional(), clearGithubToken: z.boolean().optional() }),
    output: z.object({ ok: z.literal(true), changed: z.array(z.string()) }),
  },
});
