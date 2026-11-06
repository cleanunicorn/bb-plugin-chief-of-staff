# Chief of Staff — BB plugin

An engineering chief of staff for one or more GitHub repositories. It takes
each GitHub issue (or task you describe) through Plan → Build → Verify → Review
→ Ship with an agent, and always knows where that agent is. It

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
  agent, Chief of Staff, you, or an infrastructure retry).

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

- **Workflow**: the stages above, with their instructions and budgets.
- **Repositories**: add as many as you like. Pick the BB project that holds
  the checkout (its GitHub remote fills in the repository), the issue labels
  to pick up, the agent, and any workflow stage you want to customise for
  that repository.
- **General**: capacity, intake cadence, stall threshold, default agent,
  push notifications.
- **GitHub access**: a write-only token field. A stored token is never shown,
  returned to the browser, or logged.
- **Advanced JSON**: the raw documents, for bulk edits.

Everything is validated before saving and every change is logged with who
made it. The BB project id is specific to each BB instance, so after
installing on a new machine, open Configure and pick the project for each
repository.

The same settings, as stored:

| Setting | Purpose |
| --- | --- |
| `githubToken` (secret) | Token with `repo` scope. Empty → `gh auth token` on the server host. Never logged. |
| `workflow` (JSON) | The global delivery workflow, see above. |
| `repos` (JSON) | Repository list, see below. |
| `maxConcurrentTotal`, `stallThresholdMinutes`, `intakeIntervalMinutes` | Limits and cadence. |
| `defaultProviderId`, `defaultModel` | Used when a repo does not set its own. |
| `notifyPush` | Push notifications through the push-notifications plugin. |

### Repositories

```json
{
  "repos": [
    {
      "projectId": "proj_xxxxxxxxxx",
      "intake": true,
      "issueFilter": { "labels": ["agent-ready"], "assignee": null },
      "maxConcurrent": 2,
      "providerId": "claude-code", "model": "claude-opus-5-5",
      "reviewers": ["alice"],
      "mergeStrategy": "squash",
      "workflow": { "verify": { "command": "npm test" }, "review": { "mode": "self" } }
    }
  ]
}
```

`projectId` is the BB project whose checkout hosts the work (`bb project list`).
`owner` and `repo` are optional: they default to the project's GitHub remote,
so `{ "projectId": "proj_..." }` is a complete entry. Issues are picked up only
when they carry every label in `issueFilter.labels` (or are assigned to
`issueFilter.assignee`); set `intake: false` to run only tasks you start.

Entries written for earlier versions keep working: `checkCommand` becomes the
repo's verify command, `allow.intake: false` pauses intake, and options of the
removed routines feature (deploy, release, merge filters) are ignored.

## CLI

```
bb cos status [--repo owner/repo] [--all] [--usage] [--json]
bb cos intake [--repo owner/repo] [--dry-run]
bb cos task "<title>" --repo owner/repo [--body "..."]
bb cos item approve|revise|retry|rerun-checks|done|failed <id> [--message "..."]
bb cos log [--limit n] [--item id]
```

Agents get three tools: `chief_of_staff_status` (the roster), `cos_report`
(workflow agents report a finished stage) and `cos_start_task` (hand a task to
Chief of Staff).

## How it works

- State lives in the plugin's SQLite database (`work_items`, `activity_log`).
  On startup the plugin reconciles every active item against its threads.
- One durable schedule (`* * * * *`) runs intake, CI polling, thread sync,
  retries and stall detection.
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
- Commands on a checkout (git and the verify command) run on the enrolled
  host through the plugin's `host.ts` entry; nothing opens user paths from the
  server process.
- Worktree branches are named by BB when the thread is created (the thread
  title is set to `cos/issue-<n>-<slug>` so the derived name follows it); the
  plugin records the real branch name once the environment is ready.

## Development

```sh
npm test            # vitest: stage machine, workflow config, stats, fake plugin host
npm run typecheck
bb plugin dev       # build + install + reload on change
```
