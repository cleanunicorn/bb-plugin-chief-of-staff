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

## Delivery workflow

Every task goes through Plan → Build → Verify → Review → Ship. Switch stages
on or off and give each one your own instructions, globally or per repository.
The plan can wait for your approval; verification runs the repo's command and
can ask the agent to exercise the change; review uses a fresh reviewer agent or
self-review; shipping means pushing, opening a PR, or merging it when CI is
green. Agents report each finished stage explicitly, failures loop back to
Build on a budget, and you always see who holds the ball: the agent, Chief of
Staff, or you.

## Routines

Define named routines with a cron expression or interval and ordered steps:
`batch_merge`, `release`, `deploy`, `run_agent`, `notify`. Every run logs each
step's outcome, dry-run mode reports without mutating anything, and merge,
release and deploy are gated behind per-repo allow flags.
