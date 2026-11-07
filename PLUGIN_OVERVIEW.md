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

## Workflows

Define how work gets done: a graph of steps on a canvas. Agent steps run agents
on your instructions (read-only ones can run several agents in parallel, e.g.
two planners), check steps run a command, ship steps push, open or merge the
PR. Steps can need your approval, pass/fail verdicts and failed checks send the
work back to an earlier step, and every task shows live where it is.
