## What it does

Chief of Staff keeps an eye on the agents working in this BB and runs the
boring parts of shipping for you.

## Agent monitoring

A roster of every thread the plugin started: queued, running, waiting on
human, blocked, done or failed, with repo, issue, PR, start time, last
activity and token usage when the provider reports it. Stalls and failures
raise a notification; you can retry, resume or re-run checks from the panel,
`bb cos status`, or the `chief_of_staff_status` agent tool.

## Issue intake

Label, milestone, assignee or explicit issue numbers decide which GitHub
issues become agent work. Each issue gets an isolated worktree thread with a
prompt built from the issue, its comments and the repo's conventions, plus a
comment on the issue linking the thread. An issue with an active thread or an
open PR is never picked up twice.

## PR delivery

When the agent finishes, the repo's check command runs on the branch, the
branch is pushed and a PR is opened with a summary, `Closes #n`, the agent and
model used, and test evidence. CI failures are fed back to the same thread
for a bounded number of fix cycles, then the item waits for a human.

## Routines

Define named routines with a cron expression or interval and ordered steps:
`batch_merge`, `release`, `deploy`, `run_agent`, `notify`. Every run logs each
step's outcome, dry-run mode reports without mutating anything, and merge,
release and deploy are gated behind per-repo allow flags.
