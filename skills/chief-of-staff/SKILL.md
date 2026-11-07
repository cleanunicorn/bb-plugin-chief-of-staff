---
name: chief-of-staff
description: Inspect or drive the Chief of Staff plugin from the bb CLI — user-defined agent workflows (agent, check and ship steps, parallel steps), the roster, GitHub issue intake and ad-hoc tasks, and approvals.
---

# Chief of Staff

The plugin turns GitHub issues (or described tasks) into agent work and takes
each one through the repository's workflow: a graph of steps (agent, check,
ship) where steps side by side run in parallel. It moves on only when an agent
reports its step done, pushes questions and approvals to the operator, and
sends failures back to an earlier step on a budget. Every command lives under
`bb cos`.

## If you are a workflow agent

Your prompt names the step you are on and its id. When the step is finished,
call the `cos_report` tool with that `step` id, an `outcome` (`done`;
`failed` on a pass/fail step that does not pass, or when you cannot finish;
`needs_input` with a `question` when a person must decide) and a Markdown
`summary` (the next steps read it). Then end your turn. If the tool is
unavailable, end your message with a `## Step report` block (`step:`,
`outcome:`, `summary:` lines). On a read-only step, do not change files. Never
push or open pull requests; Chief of Staff does that.

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
- `bb cos task "<title>" --repo owner/repo [--body "..."]` — start a task with no
  GitHub issue (also the `cos_start_task` agent tool).
- `bb cos item approve|revise|retry|rerun|done|failed <id> [--step <id>] [--message "..."]`
  — act on a tracked work item (ids come from `bb cos status --json`).
  `approve` approves the waiting step or moves past a stuck one; `revise
  --message` sends it back with feedback; `retry` re-runs a step Chief of
  Staff failed on; `rerun --step <id>` runs a step and everything after it
  again.
- `bb cos log [--limit n] [--item id]` — activity log with who/what triggered each step.

Agents also have the `chief_of_staff_status` tool, which returns the same roster.

## Workflow configuration

The `workflow` setting holds `{"workflows": [{id, name, steps}], "default": id}`
(edit it under Configure → Workflows, on a canvas or as a list). Every step
has `id`, `name`, `type`, `instructions` and `next` (step ids after it). Types:
`agent` (`writes`, `agents` for parallel read-only agents, `approval`,
`verdict`, `onFail`, `maxRounds`), `check` (`command`, `timeoutMinutes`,
`onFail`, `maxAttempts`), `ship` (`action`: push / pr / merge, `draft`,
`requireApproval`, `onFail` for red CI, `maxAttempts`). A repo picks one with
`"workflow": "<id>"`; a task keeps the workflow it started with.

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
