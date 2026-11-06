---
name: chief-of-staff
description: Inspect or drive the Chief of Staff plugin from the bb CLI — the delivery workflow (plan, build, verify, review, ship), agent roster, GitHub issue intake and ad-hoc tasks, approvals, and scheduled routines (batch-merge, release, deploy).
---

# Chief of Staff

The plugin turns GitHub issues (or described tasks) into agent work and takes
each one through a configurable workflow: Plan → Build → Verify → Review →
Ship. It moves to the next stage only when the agent reports the current one
done, pushes questions and approvals to the operator, loops failures back to
Build on a budget, and runs operator-defined routines. Every command lives
under `bb cos`.

## If you are a workflow agent

Your prompt names the stage you are in. When the stage is finished, call the
`cos_report` tool with that `stage`, an `outcome` (`done`; verify may be
`failed`; review may be `changes_requested`; `needs_input` with a `question`
when a person must decide) and a Markdown `summary`. Then end your turn. If the
tool is unavailable, end your message with a `## Stage report` block
(`stage:`, `outcome:`, `summary:` lines). Do not push or open pull requests;
Chief of Staff does that.

## Commands

- `bb cos status [--repo owner/repo] [--all] [--usage] [--json]` — roster of tracked
  agents: workflow stage, who holds the ball (agent / cos / human / system),
  what is happening now, repo, issue, PR, thread id, stall flag, and a "Waiting
  on you" list with the question, plan or escalation each item waits on.
  Answering or resuming the thread in BB moves the item back to running; the
  plugin re-syncs every thread each minute. In the dashboard, clicking the
  question opens it with its options and context and answers it in place
  (RPCs `cos_question {id}` and `cos_answer {id, answer}`).
- `bb cos intake [--repo owner/repo] [--dry-run]` — pick up eligible issues now.
- `bb cos task "<title>" --repo owner/repo [--body "..."]` — start a task with no
  GitHub issue (also the `cos_start_task` agent tool).
- `bb cos run <routine> [--dry-run]` — run a routine immediately. Dry run reports
  what each step would do without mutating GitHub or deploying.
- `bb cos routines list|enable <name>|disable <name>|runs [--routine name]`.
- `bb cos item approve|revise|retry|resume|rerun-checks|done|failed <id> [--message "..."]`
  — act on a tracked work item (ids come from `bb cos status --json`).
  `approve` approves a plan or moves past a stuck stage; `revise --message`
  sends the plan or the work back to the agent with feedback; `retry` re-runs
  the failed step or restarts the stage.
- `bb cos log [--limit n] [--item id]` — activity log with who/what triggered each step.

Agents also have the `chief_of_staff_status` tool, which returns the same roster.

## Workflow configuration

The global workflow is the `workflow` setting (Configure → Workflow). Each
stage has `enabled` (Build always runs) and `instructions`, plus: plan
`requireApproval`; verify `command` (defaults to the repo's `checkCommand`),
`timeoutMinutes`, `maxAttempts`; review `mode` (`agent` = fresh reviewer
thread in the builder's workspace, `self`), `maxRounds`; ship `action`
(`push`, `pr`, `merge`), `draft`, `maxCiFixes`. A repo overrides any field
under its own `workflow` key.

## Configuration

Configure visually in the dashboard's **Configure** tab (or the plugin's
settings page): multiple repositories, per-repo allow flags, routines with a
schedule and step editor, limits, notifications and a write-only GitHub token.
Saves go through the `cos_set_config` / `cos_set_settings` RPCs, which validate
before writing. The BB project id per repo is machine-specific.

Install or update from GitHub:
`bb plugin install git:github.com/cleanunicorn/bb-plugin-chief-of-staff --yes`,
then `bb settings experiment pluginUpdates true` for automatic updates.

## Operating constraints

- Only repositories configured under Repositories are touched. Merge,
  release and deploy steps additionally require `allow.merge`, `allow.release`,
  `allow.deploy` on that repo; otherwise the step is skipped and logged.
- GitHub auth comes from the `githubToken` secret setting, falling back to
  `gh auth token` on the server host. The token is never printed or logged.
- Issue intake never starts a second thread for an issue that already has an
  active thread or an open PR referencing it.
- Routines are dispatched by the plugin's durable per-minute BB schedule
  (`cos-sweep`), so they survive restarts. To surface one as a BB Automation,
  create a script automation that runs `bb cos run <routine>`.
