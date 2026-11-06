# Chief of Staff — BB plugin

An engineering chief of staff for one or more GitHub repositories. It

- **watches agents**: a live roster of the threads it spawned (status, repo,
  issue, PR, started-at, last activity, token usage when the provider reports
  it), with stall and failure detection and notifications;
- **turns GitHub issues (or tasks you describe) into agent work**: issues
  matching a per-repo filter become isolated worktree threads with a prompt
  built from the issue, its comments and the repo's `AGENTS.md` /
  `CONTRIBUTING.md`;
- **drives every task through a delivery workflow**: Plan → Build → Verify →
  Review → Ship, each stage switchable and carrying your instructions, with
  questions and approvals pushed to you and failures looped back on a budget;
- **knows where every agent is**: which stage, and who holds the ball (the
  agent, Chief of Staff, you, or an infrastructure retry);
- **runs routines**: operator-defined cron/interval routines made of
  `batch_merge`, `release`, `deploy`, `run_agent` and `notify` steps, with
  per-step logs and a dry-run mode.

## Install

From GitHub (recommended, every BB instance tracks the same repository):

```sh
bb plugin install git:github.com/cleanunicorn/bb-plugin-chief-of-staff --yes
bb settings experiment pluginUpdates true   # opt in to automatic updates
```

With `pluginUpdates` on, BB checks the tracked source every 6 hours and pulls
new commits on `main` automatically. To update right away:

```sh
bb plugin update chief-of-staff --yes
```

Pin a release instead of tracking `main` with `git:github.com/cleanunicorn/bb-plugin-chief-of-staff@v0.4.2`.

From a local checkout (development):

```sh
npm install
bb plugin build
bb plugin install .
```

Then open **Chief of Staff** in the sidebar, or run `bb cos status`.

Note: `bb plugin remove` deletes the plugin's settings, so switch sources with
`bb plugin install` rather than remove + install.

## Workflow

Every task goes through these stages, in order. Chief of Staff moves to the
next one only when the agent reports the current one done (the `cos_report`
tool, or a `## Stage report` block), and nudges an agent that stops without
reporting.

| Stage | What happens | Options |
| --- | --- | --- |
| Plan | The agent investigates and writes a plan, no code changes. | `enabled`, `instructions`, `requireApproval` (Approve / Send back in the dashboard) |
| Build | The agent implements and commits. Always on. | `instructions` |
| Verify | Chief of Staff runs the verify command in the worktree; with instructions, the agent also verifies behaviour and collects evidence. Failures go back to Build. | `enabled`, `instructions`, `command` (defaults to the repo's `checkCommand`), `timeoutMinutes`, `maxAttempts` |
| Review | A fresh reviewer agent in the builder's workspace (`agent`) or the builder (`self`) reviews the diff. Requested changes go back to Build → Verify → Review. | `enabled`, `instructions`, `mode`, `maxRounds` |
| Ship | `push` the branch, open a `pr` (you merge), or `merge` it when CI is green. With instructions the agent writes the PR description. Red CI goes back to Build → Verify → Ship. | `enabled`, `instructions`, `action`, `draft`, `maxCiFixes` |

Out of attempts, a question, a plan to approve: the item waits on you, and the
dashboard's answer panel shows the plan, findings or question with the right
buttons. Chief of Staff's own failures (host timeouts, GitHub errors) are
retried with backoff before they reach you, and are labelled as such.

The global workflow lives in **Configure → Workflow** (setting `workflow`):

```json
{
  "workflow": {
    "plan":   { "enabled": true, "requireApproval": true, "instructions": "" },
    "build":  { "instructions": "Follow AGENTS.md." },
    "verify": { "enabled": true, "command": "npm test", "instructions": "Exercise the changed flow.", "timeoutMinutes": 30, "maxAttempts": 2 },
    "review": { "enabled": true, "mode": "agent", "instructions": "", "maxRounds": 2 },
    "ship":   { "enabled": true, "action": "pr", "draft": false, "instructions": "", "maxCiFixes": 2 }
  }
}
```

A repository overrides any field of any stage under its own `workflow`
(`{"review": {"enabled": false}}`). Start a task without an issue from the
dashboard (**New task**), with `bb cos task "Title" --repo owner/repo --body …`,
or let another agent call the `cos_start_task` tool.

## Configure

Use the visual configurator: the **Configure** tab in the Chief of Staff
dashboard, or the plugin's page under Settings. It edits:

- **Repositories**: add as many as you like. Paste `owner/repo` or a GitHub
  URL, pick the BB project that holds the checkout (projects whose git remote
  matches are suggested), and toggle what the plugin may do. New repos start
  least-privilege: intake and pull requests only; merge, release and deploy
  are off until you switch them on.
- **Routines**: schedule (manual, every N minutes/hours/days, or cron with
  presets and a timezone), steps you can add, reorder and remove, and warnings
  when a step needs a permission the repo does not grant.
- **General**: capacity, recovery, default agent and notifications.
- **GitHub access**: a write-only token field. A stored token is never shown,
  returned to the browser, or logged.
- **Advanced JSON**: the raw documents, for bulk edits.

Everything is validated before saving (duplicate repos, missing project,
invalid cron, http webhooks) and every change is logged with who made it.

The BB project id is specific to each BB instance, so after installing on a
new machine, open Configure and pick the project for each repository.

The same settings, as stored (also editable as host-rendered fields):

| Setting | Purpose |
| --- | --- |
| `githubToken` (secret) | Token with `repo` + `workflow` scope. Empty → `gh auth token` on the server host. Never logged. |
| `repos` (JSON) | Repository list, see below. |
| `routines` (JSON) | Routine definitions, see below. |
| `workflow` (JSON) | The global delivery workflow, see above. |
| `maxConcurrentTotal`, `stallThresholdMinutes`, `autoRetryStalled`, `intakeIntervalMinutes`, `ciPollIntervalMinutes` | Limits and cadence. |
| `defaultProviderId`, `defaultModel` | Used when a repo does not set its own. |
| `notifyPush`, `notifyWebhookUrl` | Notification targets (push-notifications plugin and/or a webhook). |

### Repositories

```json
{
  "repos": [
    {
      "projectId": "proj_xxxxxxxxxx",
      "owner": "acme", "repo": "app",
      "issueFilter": { "labels": ["agent-ready"], "milestone": null, "assignee": null, "numbers": [] },
      "maxConcurrent": 2,
      "providerId": "claude-code", "model": "claude-opus-5-5",
      "checkCommand": "npm test",
      "workflow": { "review": { "mode": "self" } },
      "deployCommand": "./scripts/deploy.sh",
      "deployWorkflow": "deploy.yml",
      "reviewers": ["alice"], "teamReviewers": ["platform"], "labels": ["agent"],
      "mergeStrategy": "squash",
      "conflictHandling": "skip",
      "versionStrategy": "patch", "tagPrefix": "v",
      "allow": { "intake": true, "openPr": true, "merge": false, "release": false, "deploy": false }
    }
  ]
}
```

`projectId` is the BB project whose checkout hosts the work (`bb project list`).
`owner` and `repo` are optional: they default to the project's GitHub remote
(`gitRemoteUrl`), so `{ "projectId": "proj_..." }` is a complete entry. Set them
only to target a different repository; a mismatch with the remote is reported as
a warning. In the configurator, picking a BB project fills the GitHub
repository from its remote.
Merge, release and deploy steps run only when the matching `allow` flag is true.

### Routines

```json
{
  "routines": [
    {
      "name": "Nightly ship",
      "enabled": true,
      "cron": "0 2 * * *",
      "timezone": "UTC",
      "repo": "acme/app",
      "dryRun": false,
      "steps": [
        { "type": "batch_merge", "strategy": "squash", "conflictHandling": "skip" },
        { "type": "release", "strategy": "patch" },
        { "type": "deploy", "workflow": "deploy.yml", "pollTimeoutMinutes": 30 },
        { "type": "notify", "title": "Nightly ship done" }
      ]
    }
  ]
}
```

Use `every: "6h"` instead of `cron` for intervals. Routines are dispatched by
the plugin's durable BB schedule (`cos-sweep`, visible in `bb plugin list`); to
surface one as a BB Automation, create a script automation that runs
`bb cos run <routine>`.

## CLI

```
bb cos status [--repo owner/repo] [--all] [--usage] [--json]
bb cos intake [--repo owner/repo] [--dry-run]
bb cos task "<title>" --repo owner/repo [--body "..."]
bb cos item approve|revise|retry|rerun-checks|done|failed <id> [--message "..."]
bb cos run <routine> [--dry-run]
bb cos routines list | enable <name> | disable <name> | runs
bb cos log [--limit n] [--item id]
```

Agents get three tools: `chief_of_staff_status` (the roster), `cos_report`
(workflow agents report a finished stage) and `cos_start_task` (hand a task to
Chief of Staff).

## How it works

- State lives in the plugin's SQLite database (`work_items`, `routine_runs`,
  `activity_log`). On startup the plugin reconciles every active item against
  the live thread and GitHub.
- One durable schedule (`* * * * *`) runs intake, CI polling, thread sync,
  stall detection and routine dispatch; cron matching uses `cron-parser`.
- Stage machine (`src/machine.ts`, pure): each item has a stage (plan, build,
  verify, review, ship, done) and a status saying who holds the ball (`agent`,
  `cos`, `ci`, `ready`, `waiting_on_human`, `retrying`, `blocked`). Events from
  threads, jobs, CI and you produce the next stage and the effects to run.
- Thread sync: thread events drive the machine, and the sweep re-reads every
  tracked builder and reviewer thread in one `threads.list` call each minute
  (runtime status, pending interactions) to catch anything missed. All
  observations of one item run under a per-item lock, and a turn end is
  handled once (keyed on the thread's `updatedAt`, ignoring turns older than
  Chief of Staff's latest prompt). When a turn ends, the agent's stage report
  decides what happens; without one, an open interaction or a plain-text
  question parks the item on you, otherwise the agent is nudged.
- Jobs: the verify command, push/PR and merge run detached from event handlers
  with their own timeout. Their result is applied only if the item is still
  waiting on that job; a job lost to a restart is started again by the sweep.
  Errors are retried with backoff before they reach you.
- Answering from the dashboard: click the question on a waiting card to see
  the question, its options and the agent's last message, then answer in place
  or open the thread. Questions, approvals and requests are resolved with
  `threads.interactions.resolve`; a plain-text question gets a reply message.
  The activity log records who answered, not what they wrote.
- Commands on a checkout (git, check and deploy commands) run on the enrolled
  host through the plugin's `host.ts` entry; nothing opens user paths from the
  server process.
- Worktree branches are named by BB when the thread is created (the thread
  title is set to `cos/issue-<n>-<slug>` so the derived name follows it); the
  plugin records the real branch name once the environment is ready.

## Development

```sh
npm test            # vitest: stage machine, workflow config, batch-merge ordering, scheduling, fake plugin host
npm run typecheck
bb plugin dev       # build + install + reload on change
```
