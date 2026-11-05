---
name: chief-of-staff
description: Inspect or drive the Chief of Staff plugin from the bb CLI — agent roster, GitHub issue intake, PR delivery state, and scheduled routines (batch-merge, release, deploy).
---

# Chief of Staff

The plugin watches agent threads it spawned, turns GitHub issues into agent
work, opens pull requests, and runs operator-defined routines. Every command
lives under `bb cos`.

## Commands

- `bb cos status [--repo owner/repo] [--all] [--usage] [--json]` — roster of tracked
  agents: status (queued / running / waiting on human / blocked / done / failed),
  repo, issue, PR, thread id, last activity, stall flag.
- `bb cos intake [--repo owner/repo] [--dry-run]` — pick up eligible issues now.
- `bb cos run <routine> [--dry-run]` — run a routine immediately. Dry run reports
  what each step would do without mutating GitHub or deploying.
- `bb cos routines list|enable <name>|disable <name>|runs [--routine name]`.
- `bb cos item retry|resume|rerun-checks|done|failed <id>` — act on a tracked work
  item (ids come from `bb cos status --json`).
- `bb cos log [--limit n] [--item id]` — activity log with who/what triggered each step.

Agents also have the `chief_of_staff_status` tool, which returns the same roster.

## Operating constraints

- Only repositories listed in the plugin's Repositories JSON are touched. Merge,
  release and deploy steps additionally require `allow.merge`, `allow.release`,
  `allow.deploy` on that repo; otherwise the step is skipped and logged.
- GitHub auth comes from the `githubToken` secret setting, falling back to
  `gh auth token` on the server host. The token is never printed or logged.
- Issue intake never starts a second thread for an issue that already has an
  active thread or an open PR referencing it.
- Routines are dispatched by the plugin's durable per-minute BB schedule
  (`cos-sweep`), so they survive restarts. To surface one as a BB Automation,
  create a script automation that runs `bb cos run <routine>`.
