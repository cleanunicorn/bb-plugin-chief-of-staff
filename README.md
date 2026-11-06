# Chief of Staff — BB plugin

An engineering chief of staff for one or more GitHub repositories. It

- **watches agents**: a live roster of the threads it spawned (status, repo,
  issue, PR, started-at, last activity, token usage when the provider reports
  it), with stall and failure detection and notifications;
- **turns GitHub issues into agent work**: issues matching a per-repo filter
  become isolated worktree threads with a prompt built from the issue, its
  comments and the repo's `AGENTS.md` / `CONTRIBUTING.md`;
- **delivers pull requests**: runs the repo's check command, pushes, opens a PR
  (`Closes #n`, agent + model, test evidence), watches CI and feeds failures back
  to the same thread for a bounded number of fix cycles before escalating;
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

Pin a release instead of tracking `main` with `git:github.com/cleanunicorn/bb-plugin-chief-of-staff@v0.4.1`.

From a local checkout (development):

```sh
npm install
bb plugin build
bb plugin install .
```

Then open **Chief of Staff** in the sidebar, or run `bb cos status`.

Note: `bb plugin remove` deletes the plugin's settings, so switch sources with
`bb plugin install` rather than remove + install.

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
| `maxConcurrentTotal`, `stallThresholdMinutes`, `maxFixRetries`, `autoRetryStalled`, `intakeIntervalMinutes`, `ciPollIntervalMinutes` | Limits and cadence. |
| `defaultProviderId`, `defaultModel` | Used when a repo does not set its own. |
| `notifyPush`, `notifyWebhookUrl` | Notification targets (push-notifications plugin and/or a webhook). |

### Repositories

```json
{
  "repos": [
    {
      "owner": "acme", "repo": "app",
      "projectId": "proj_xxxxxxxxxx",
      "issueFilter": { "labels": ["agent-ready"], "milestone": null, "assignee": null, "numbers": [] },
      "maxConcurrent": 2,
      "providerId": "claude-code", "model": "claude-opus-5-5",
      "checkCommand": "npm test",
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
bb cos run <routine> [--dry-run]
bb cos routines list | enable <name> | disable <name> | runs
bb cos item retry|resume|rerun-checks|done|failed <id>
bb cos log [--limit n] [--item id]
```

Agents get the `chief_of_staff_status` tool with the same roster.

## How it works

- State lives in the plugin's SQLite database (`work_items`, `routine_runs`,
  `activity_log`). On startup the plugin reconciles every active item against
  the live thread and GitHub.
- One durable schedule (`* * * * *`) runs intake, CI polling, thread sync,
  stall detection and routine dispatch; cron matching uses `cron-parser`.
- Thread sync: thread events drive the state machine, and the sweep re-reads
  each tracked thread (`threads.get`) and its open interactions
  (`threads.interactions.list`) every minute to catch anything missed. An open
  interaction, or a turn that ends with a plain-text question, puts the item in
  waiting on human with the question attached. When the thread starts a new
  turn (you answered or resumed it in BB), the item returns to running; the
  next idle re-runs checks and pushes. BB has no "interaction resolved" event,
  so an answer is noticed by the next thread event or within a minute.
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
npm test            # vitest: state machine, batch-merge ordering, scheduling, fake plugin host
npm run typecheck
bb plugin dev       # build + install + reload on change
```
