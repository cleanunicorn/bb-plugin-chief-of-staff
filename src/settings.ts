// Plugin settings descriptors. Repos and routines are JSON documents in
// multiline fields; the dashboard edits them through RPC + experimental_set.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SEED_REPOS, SEED_ROUTINES, parseRepos, parseRoutines } from "./config";

const jsonSchema = (parse: (raw: string) => { ok: boolean; error?: string }) => ({
  "~standard": {
    version: 1 as const,
    vendor: "chief-of-staff",
    validate(value: unknown) {
      if (typeof value !== "string") return { issues: [{ message: "expected a string" }] };
      const result = parse(value);
      return result.ok ? { value } : { issues: [{ message: result.error ?? "invalid" }] };
    },
  },
});

export const settingDescriptors = {
  githubToken: {
    type: "string",
    label: "GitHub token",
    description: "Fine-grained or classic token with repo + workflow scope. Leave empty to use `gh auth token` on the server host. Never logged.",
    secret: true,
  },
  repos: {
    type: "string",
    label: "Repositories (JSON)",
    description: 'JSON: {"repos":[{owner, repo, projectId, issueFilter, maxConcurrent, checkCommand, deployCommand, allow:{intake,openPr,merge,release,deploy}, ...}]}',
    experimental_multiline: true,
    experimental_schema: jsonSchema(parseRepos),
    default: JSON.stringify(SEED_REPOS, null, 2),
  },
  routines: {
    type: "string",
    label: "Routines (JSON)",
    description: 'JSON: {"routines":[{name, cron|every, repo:"owner/repo", enabled, dryRun, steps:[{type:"batch_merge"|"release"|"deploy"|"run_agent"|"notify", ...}]}]}',
    experimental_multiline: true,
    experimental_schema: jsonSchema(parseRoutines),
    default: JSON.stringify(SEED_ROUTINES, null, 2),
  },
  maxConcurrentTotal: { type: "number", label: "Max concurrent agent threads (all repos)", default: 4 },
  stallThresholdMinutes: { type: "number", label: "Stall threshold (minutes)", description: "A running agent with no activity for this long is reported as stalled.", default: 30 },
  maxFixRetries: { type: "number", label: "Max fix cycles per issue", description: "How many times failing checks/CI are fed back to the agent before escalating to a human.", default: 1 },
  autoRetryStalled: { type: "boolean", label: "Auto-retry stalled or failed agents once", default: false },
  intakeIntervalMinutes: { type: "number", label: "Issue intake interval (minutes)", default: 10 },
  ciPollIntervalMinutes: { type: "number", label: "CI poll interval (minutes)", default: 2 },
  defaultProviderId: { type: "string", label: "Default provider id", description: "Used when a repo does not set providerId (e.g. claude-code).", default: "" },
  defaultModel: { type: "string", label: "Default model", default: "" },
  notifyPush: { type: "boolean", label: "Send BB push notifications", description: "Uses the push-notifications plugin when installed.", default: true },
  notifyWebhookUrl: { type: "string", label: "Notification webhook URL", description: "Optional HTTPS endpoint receiving JSON {title, body, threadId} on every alert.", default: "" },
} as const;

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define(settingDescriptors);
}
export type SettingsHandle = ReturnType<typeof defineSettings>;
export type SettingsValues = Awaited<ReturnType<SettingsHandle["get"]>>;
