---
name: chief-of-staff
description: Inspect or drive the Chief of Staff plugin from the bb CLI — user-defined agent workflows (agent, check, ship and model steps, parallel steps), the roster, GitHub issue intake and ad-hoc tasks, and approvals.
---

# Chief of Staff

The plugin turns GitHub issues (or described tasks) into agent work and takes
each one through the repository's workflow: a graph of steps (agent, check,
ship, model) where steps side by side run in parallel. It moves on only when an agent
reports its step done, pushes questions and approvals to the operator, and
sends failures back to an earlier step on a budget. Every command lives under
`bb cos`.

## If you are a workflow agent

Follow the "When you finish this step" section of your prompt: it gives the
exact `cos_report` call (step id, delivery id, outcomes, any model-choice
fields) and the `## Step report` text block to use when the tool is
unavailable. Report, then end your turn; Chief of Staff waits for
the report. Use `outcome: "failed"` when you cannot finish, and
`outcome: "needs_input"` with a `question` when a person must decide. On a read-only step, do not change files. Never push or open pull
requests; Chief of Staff does that.

## Commands

- `bb cos status [--repo owner/repo] [--all] [--usage] [--json]` — roster of tracked
  agents: the steps running, who holds the ball (agent / cos / human / system),
  what is happening now, repo, issue, PR, thread id, stall flag, and a "Waiting
  on you" list with the question, plan or escalation each item waits on.
  Answering or resuming the thread in BB moves the item back to running; the
  plugin re-syncs every thread each minute. In the dashboard, clicking the
  question opens it with its options and context and answers it in place
  (RPCs `cos_question {id}` and `cos_answer {id, answer}`).
- `bb cos intake [--repo owner/repo] [--dry-run]` — pick up eligible issues now.
- `bb cos task "<prompt>" --repo owner/repo [--body "..."]` — start a task with no
  GitHub issue (also the `cos_start_task` agent tool). The repository must be
  configured, but automatic intake need not be enabled. The task follows its
  configured workflow and counts against capacity limits.
- `bb cos item approve|revise|retry|rerun|done|failed <id> [--step <id>] [--message "..."]`
  — act on a tracked work item (ids come from `bb cos status --json`).
  `approve` approves the waiting step or moves past a stuck one; `revise
  --message` sends it back with feedback; `retry` re-runs a step Chief of
  Staff failed on; `rerun --step <id>` runs a step and everything after it
  again.
- `bb cos log [--limit n] [--item id]` — activity log with who/what triggered each step.

An uncertain prompt delivery is never resent automatically, even after a
restart: a report carrying its delivery id recovers it. Otherwise inspect the
thread before an explicit `retry` (a failed send may still have delivered;
activity alone does not prove it). Preparation failures retry with backoff.

Agents also have the `chief_of_staff_status` tool, which returns the same roster.

## Workflow configuration

The `workflow` setting holds `{"workflows": [{id, name, steps}], "default": id}`
(edit it under Configure → Workflows, on a canvas or as a list). Every step
has `id`, `name`, `type`, `instructions` and `next` (step ids after it). Types:
`agent` (`writes`, `agents` for parallel read-only agents, `approval`,
`verdict`, `onFail`, `maxRounds`), `check` (`command`, `timeoutMinutes`,
`onFail`, `maxAttempts`), `ship` (`action`: push / pr / merge, `draft`,
`requireApproval`, `onFail` for red CI, `maxAttempts`). An agent step's
`instructions` may reference agent skills as `/skill-name`; Chief of Staff sends
each reference to a skill installed in the workspace as a skill mention (the
`cos_skills` RPC lists them). A repo picks one with
`"workflow": "<id>"`; a task keeps the workflow it started with.

Ship completion depends on `action`: `push` finishes after the branch push;
`pr` finishes when a new or existing open PR is confirmed; `merge` finishes only
when GitHub confirms a merge. PR-only delivery stops watching and repairing CI
when finished. Use merge mode when the assignment includes merging, and preserve
`requireApproval` unless the user configured otherwise.

While shipping waits on CI, review or a person, the task holds no capacity
slot (it stays tracked); repairs, reruns and later agent steps queue for a
free slot. Limits count tasks, not threads; other gates keep their slot.
`cos_overview` reports `occupiedCapacity` and each repo's reserved `active`
count; roster entries expose `occupiesCapacity`.

## Configuration

Configure visually in the dashboard's **Configure** tab (or the plugin's
settings page): repositories (BB project, issue labels, agent,
the workflow it runs), workflows (canvas or list), limits, push notifications and a write-only GitHub
token. Saves go through the `cos_set_config` / `cos_set_settings` RPCs, which
validate before writing. The BB project id per repo is machine-specific.

Install or update from GitHub:
`bb plugin install git:github.com/cleanunicorn/bb-plugin-chief-of-staff --yes`,
then `bb settings experiment pluginUpdates true` for automatic updates.

## Operating constraints

- Only repositories configured under Repositories are touched.
- GitHub auth comes from the `githubToken` secret setting, falling back to
  `gh auth token` on the server host. The token is never printed or logged.
- Issue intake never starts a second thread for an issue that already has an
  active thread or an open PR referencing it, and never picks up issues
  without a label or assignee filter.
- Agents never push or open pull requests themselves; Chief of Staff does,
  in a Ship step.

### Workflow thread grouping

Each workflow's threads (planners, builder, reviewers, replacements) are
grouped under its first live thread using BB's native parent-thread tree,
across worktrees; no coordinator agent or custom sidebar is created. Child
result notifications are off (`parentNotifications: "off"`); step reports
still drive progression. Unset provider, model, reasoning and permission
options may inherit the parent's BB defaults. The sweep regroups active workflows, keeps threads
already attached to outside parents, and replaces a missing or archived
parent; failures are logged and retried. With automatic archiving, children
are archived before their parent. Archiving the parent manually detaches live
children; deleting it deletes them. BB nests at most four levels.
