// Plugin settings descriptors. Repos and the workflow are JSON documents in
// multiline fields; the dashboard edits them through RPC + experimental_set.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SEED_REPOS, parseRepos } from "./config";
import { DEFAULT_DOCUMENT, parseWorkflows, serializeWorkflows } from "./workflow";

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
    description: 'JSON: {"repos":[{projectId, owner?, repo?, intake, issueFilter:{labels, assignee?}, maxConcurrent, providerId?, model?, permissionMode, reviewers, mergeStrategy, workflow?: "<workflow id>"}]}. owner/repo default to the project\'s GitHub remote.',
    experimental_multiline: true,
    experimental_schema: jsonSchema(parseRepos),
    default: JSON.stringify(SEED_REPOS, null, 2),
  },
  workflow: {
    type: "string",
    label: "Workflows (JSON)",
    description: 'JSON: {"workflows":[{id, name, steps:[{id, name, type:"agent"|"check"|"ship", instructions, next:[ids], ...}]}], "default": "<id>"}. Repos pick one with "workflow": "<id>". Edit visually under Configure → Workflows.',
    experimental_multiline: true,
    experimental_schema: jsonSchema(parseWorkflows),
    default: serializeWorkflows(DEFAULT_DOCUMENT),
  },
  maxConcurrentTotal: { type: "number", label: "Max concurrent tasks (all repos)", default: 4 },
  stallThresholdMinutes: { type: "number", label: "Stall threshold (minutes)", description: "A running agent with no activity for this long is reported as stalled.", default: 30 },
  intakeIntervalMinutes: { type: "number", label: "Issue intake interval (minutes)", default: 10 },
  defaultProviderId: { type: "string", label: "Default provider id", description: "Used when a repo does not set providerId (e.g. claude-code).", default: "" },
  defaultModel: { type: "string", label: "Default model", default: "" },
  notifyPush: { type: "boolean", label: "Send BB push notifications", description: "Uses the push-notifications plugin when installed.", default: true },
  archiveThreadsOnDone: { type: "boolean", label: "Archive threads when a task is done", description: "When a task's workflow finishes, archive the builder and step threads it started. Failed tasks keep their threads.", default: true },
} as const;

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define(settingDescriptors);
}
export type SettingsHandle = ReturnType<typeof defineSettings>;
export type SettingsValues = Awaited<ReturnType<SettingsHandle["get"]>>;
