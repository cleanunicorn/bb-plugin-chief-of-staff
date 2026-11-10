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

Your prompt names the step you are on and its id. When the step is finished,
call the `cos_report` tool with that `step` id, an `outcome` (`done`;
`failed` on a pass/fail step that does not pass, or when you cannot finish;
`needs_input` with a `question` when a person must decide) and a Markdown
`summary` (the next steps read it). If your prompt lists model choices, also
pass the `choice` id you pick (a text report uses a `choice:` line). If your
step chooses the model, find what is available with `bb provider list --json`
and `bb provider models <providerId> --json`, and pass the `providerId`,
`model` and `reasoningLevel` you pick (`providerId:`, `model:` and
`reasoningLevel:` lines before `summary:` in a text report). Then end
your turn. When the prompt includes a delivery id, pass it as `delivery` (or
put `delivery:` before `summary:` in the text report). This associates the
report with the current prompt, including recovery after a lost send response.
If the tool is
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

A prompt delivery marked uncertain is not automatically resent, including after
restart. A report with the matching delivery id can recover it. If no agent
received the prompt, inspect the thread before explicitly retrying; the SDK does
not guarantee that a thrown send/spawn call delivered nothing. Activity alone
does not prove delivery. Preparation failures still retry with bounded backoff.

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

Shipping waits for CI, review or a human decision do not reserve task capacity.
The item remains visible and tracked. Repairs, reruns and agent steps after
shipping queue until repo and global capacity is available, then resume
without keeping an agent turn alive. Limits count tasks, not parallel threads;
non-shipping gates keep their existing reservations. `cos_overview` reports
`occupiedCapacity` globally and reserved counts in each repo's `active` field;
roster entries expose `occupiesCapacity`.

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

Chief of Staff uses BB’s native parent-thread tree to group each workflow in project view. The first live workflow thread becomes its parent; planning agents, the builder, reviewers, and replacement threads are grouped beneath it across worktrees. The parent identity is stored separately from the builder and survives restarts. No extra coordinator agent or custom sidebar is created.

Child-result notifications are disabled (`parentNotifications: "off"`); Chief of Staff still handles step reports and progression. Workspace choices and configured provider, model, reasoning, and permissions remain explicit. Unset execution options can inherit BB’s parent defaults.

The regular sweep groups existing active workflows and preserves threads attached to parents outside the workflow. BB can send an assignment notice to the parent when existing threads are attached, even with child-result notifications disabled. A missing or archived parent is replaced with a live workflow thread when available. Failed grouping is logged for a later retry.

On completion, Chief of Staff archives children before their parent when automatic archiving is enabled. Manually archiving the parent detaches live children; deleting a parent also deletes its descendants. BB limits nesting to four levels. This implementation creates no native sections and does not change sidebar preferences.
