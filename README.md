# Chief of Staff — BB plugin

An engineering chief of staff for one or more GitHub repositories. It takes
each GitHub issue (or task you describe) through a workflow you define, a graph
of agent, check and ship steps that can run in parallel, and always knows
where each agent is. It

- **watches agents**: a live roster of the threads it spawned (status, repo,
  issue, PR, started-at, last activity, token usage when the provider reports
  it), with stall and failure detection and notifications;
- **turns GitHub issues (or tasks you describe) into agent work**: issues
  matching a per-repo filter become isolated worktree threads with a prompt
  built from the issue, its comments and the repo's `AGENTS.md` /
  `CONTRIBUTING.md`;
- **runs your workflows**: steps you define on a canvas or as a list, each an
  agent (with your instructions), a check command, or shipping; parallel
  read-only steps; approvals and questions pushed to you; failures sent back
  to an earlier step on a budget;
- **knows where every agent is**: which steps are running, and who holds the
  ball (an agent, Chief of Staff, you, or an infrastructure retry).

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

## Workflows

A workflow is the path every task takes: a set of **steps** connected by
arrows. A step starts when every step pointing at it is done; steps side by
side run in parallel, and a step with several arrows into it waits for all of
them. Chief of Staff moves on only when the agent reports its step (the
`cos_report` tool, or a `## Step report` block), and nudges an agent that stops
without reporting. Each step's prompt carries its instructions plus the reports
of the steps before it.

Every step has a name, instructions and arrows to the steps after it. Its
**type** adds the rest:

| Type | What runs | Options |
| --- | --- | --- |
| Agent | Agents work on the instructions. | **Writes code** (runs in the task's main thread, one code-writing step at a time; off = read-only, may run in parallel), **agents in parallel** (read-only steps, e.g. two planners), **needs my approval** (approve the report or send it back), **pass/fail verdict** (fail sends the work back), on fail → step, rounds |
| Check | Chief of Staff runs a command in the worktree; non-zero exit fails it. | command, timeout, on fail → step, attempts |
| Ship | Push the branch, finish when a PR opens, or finish after the PR merges with green CI. | action, draft, wait for an approving review, when CI is red → step, attempts |
| Model | Does no work. Sets the agent (provider), model and reasoning level for the agent steps after it. | provider, model, reasoning level (empty = keep the current one) |

**Model steps.** A Model step's settings apply to every agent step after it, not just the next one, until
another Model step changes them (field by field: a later step that sets only the model keeps the earlier
provider). They apply to threads started after the step: read-only steps, and the builder when it is first
spawned. An already running builder thread keeps the model it started with. Without a Model step before it,
a step uses the repository's settings, then the global default.

**Letting an agent choose.** An agent step can list **model choices** (an id, a "use when" description and a
provider, model and reasoning level each). The agent analyses the task and reports the id it picks as `choice`
(the `cos_report` tool rejects a missing or unknown id; a text report uses a `choice:` line). The steps after it run
with that choice until a Model step or another choosing step changes it. If the agent names no valid choice, the
step waits for you: approve to continue with the current model, or send it instructions.

**Shipping completion.** Choose `action: "pr"` to finish the ship step as soon as
its PR is created or an existing open PR is confirmed. Review, CI and merge then
belong to the PR owner; Chief of Staff does not repair later CI failures for that
finished delivery. Choose `action: "merge"` to keep watching CI, repair failures
within the configured budget, and finish only after GitHub confirms the merge.
`requireApproval` controls the approving-review gate in merge mode (on by default).
`push` finishes after a successful push. Steps configured after shipping still run.

CI, review and human decisions in shipping release the task's concurrency slot.
The waiting item stays tracked, and intake can start another task. A CI repair,
manual rerun or agent step after shipping reacquires capacity; if the repo or
global limit is full, it queues and resumes automatically. Limits count task
reservations, including non-shipping human gates, rather than individual parallel
agent threads. Other branches still working in the same task retain its slot.
The dashboard shows occupied task capacity separately from waiting PRs. The
Pipeline view places active tasks before historical throughput and repository
capacity. Stage filters count tasks; task slots retain the admission semantics
above. “Failures needing a decision” counts active human waits caused by an
escalation, a missing report, or a Chief of Staff error. Stalled work is shown
separately. Terminal failed runs are historical outcomes, not unresolved
incidents; they remain accessible with **Show finished**. Retrying work stays in
Checks & shipping until it requires a decision.

**Upgrade behavior:** unfinished PR-only items in CI/ready finish after their PR
is confirmed open or merged. Closed, unmerged PRs fail delivery; a GitHub error
leaves completion unconfirmed for a later retry. Stored workflow choices remain
unchanged. Select merge mode for new tasks whose delivery must include merging.

“On fail” goes back to an earlier step: that step and everything after it run
again, with the failure (check output, review findings, CI log) as feedback.
Past the limit, the task waits on you: approve to continue anyway, or send
instructions back. Read-only steps run in their own threads, in the task's
workspace once code exists, so a reviewer sees exactly what was built.

**Agent skills.** An agent step's instructions can name skills the way the bb
composer does: type `/` in **Instructions for the agent** to pick one (e.g.
`Use /tdd, then implement the plan.`). The editor lists the skills of your
configured repositories' projects and flags any it does not know. When Chief of
Staff prompts the agent, each `/skill` reference to a skill installed in that
workspace is sent as a skill mention, so Claude Code, Codex and ACP agents load
the skill; anything else stays plain text.

The default workflow is **Plan** (needs approval) → **Build** (writes code) →
**Review** (pass/fail, back to Build) → **Ship** (PR). Edit it, or add your own,
under **Configure → Workflows**: drag steps on the canvas, connect a step's
bottom edge to another step, select an arrow and press Backspace to remove it,
or use the list view. Each repository picks a workflow; a task keeps the
workflow it started with. On a task card, **Workflow** shows the task live on
the canvas and lets you run any step again from there.

Stored in the `workflow` setting:

```json
{
  "workflows": [
    {
      "id": "careful",
      "name": "Careful",
      "steps": [
        { "id": "plan", "name": "Plan", "type": "agent", "agents": 2, "approval": true, "instructions": "Write a plan.", "next": ["build"] },
        { "id": "build", "name": "Build", "type": "agent", "writes": true, "instructions": "Implement the plan.", "next": ["test"] },
        { "id": "test", "name": "Tests", "type": "check", "command": "npm test", "onFail": "build", "maxAttempts": 2, "next": ["review", "docs"] },
        { "id": "review", "name": "Review", "type": "agent", "verdict": true, "onFail": "build", "maxRounds": 2, "next": ["ship"] },
        { "id": "docs", "name": "Docs", "type": "agent", "instructions": "Check the docs cover the change.", "next": ["ship"] },
        { "id": "ship", "name": "Ship", "type": "ship", "action": "pr", "onFail": "build" }
      ]
    }
  ],
  "default": "careful"
}
```

Workflows are validated before saving: no loops through arrows (use “on fail”
to go back), code-writing steps, checks and ship must run one after another,
“on fail” must point back to an earlier step, and checks and ship need a
code-writing step before them. The fixed-stage config from earlier versions is
converted automatically.

Start a task without an issue from the dashboard (**New task**), with
`bb cos task "Title" --repo owner/repo --body …`, or let another agent call the
`cos_start_task` tool. Configure the repository first; neither a GitHub issue
nor automatic intake is required. The task uses that repository's configured
workflow and counts against its concurrency limits.

## Configure

Use the visual configurator: the **Configure** tab in the Chief of Staff
dashboard, or the plugin's page under Settings. It edits:

- **Workflows**: the canvas / list editor above.
- **Repositories**: add as many as you like. Pick the BB project that holds
  the checkout (its GitHub remote fills in the repository), the issue labels
  to pick up, the agent, and which workflow it runs.
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
| `workflow` (JSON) | Your workflows and which one is the default, see above. |
| `repos` (JSON) | Repository list, see below. |
| `maxConcurrentTotal`, `stallThresholdMinutes`, `intakeIntervalMinutes` | Limits and cadence. |
| `defaultProviderId`, `defaultModel` | Used when a repo does not set its own. |
| `notifyPush` | Push notifications through the push-notifications plugin. |
| `archiveThreadsOnDone` | Archive a task's builder and step threads once its workflow is done (default on). Failed tasks keep theirs. |

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
      "workflow": "careful"
    }
  ]
}
```

`projectId` is the BB project whose checkout hosts the work (`bb project list`).
`owner` and `repo` are optional: they default to the project's GitHub remote,
so `{ "projectId": "proj_..." }` is a complete entry. Issues are picked up only
when they carry every label in `issueFilter.labels` (or are assigned to
`issueFilter.assignee`); set `intake: false` to run only tasks you start.

`workflow` names one of your workflows (empty: the default). Entries written
for earlier versions keep working: per-stage overrides and `checkCommand` are
converted into a workflow for that repository, `allow.intake: false` pauses
intake, and options of the removed routines feature are ignored.

## CLI

```
bb cos status [--repo owner/repo] [--all] [--usage] [--json]
bb cos intake [--repo owner/repo] [--dry-run]
bb cos task "<title>" --repo owner/repo [--body "..."]
bb cos item approve|revise|retry|rerun|done|failed <id> [--step <id>] [--message "..."]
bb cos log [--limit n] [--item id]
```

Agents get three tools: `chief_of_staff_status` (the roster), `cos_report`
(workflow agents report a finished step) and `cos_start_task` (hand a task to
Chief of Staff).

## How it works

- State lives in the plugin's SQLite database: `work_items` (each task with a
  snapshot of its workflow and the state of every step), `item_threads` (which
  agent thread works on which step) and `activity_log`. On startup the plugin
  reconciles every active item against its threads.
- One durable schedule (`* * * * *`) runs intake, CI polling, thread sync,
  retries and stall detection.
- Workflow engine (`src/machine.ts`, pure): each step has a state (pending,
  running, waiting, done), a round and a failure count. Events from threads,
  jobs, CI and you produce new step states and the effects to run; a pending
  step starts once every step before it is done. The item's status (who holds
  the ball: `agent`, `cos`, `ci`, `ready`, `waiting_on_human`, `retrying`,
  `blocked`) is derived from its steps.
- Threads: code-writing steps share the task's builder thread (a managed
  worktree); every agent on a read-only step gets its own thread, in the
  builder's workspace once it exists, reused for later rounds.
- Thread sync: thread events drive the engine, and the sweep re-reads every
  tracked thread in one `threads.list` call each minute
  (runtime status, pending interactions) to catch anything missed. All
  observations of one item run under a per-item lock, and a turn end is
  handled once (keyed on the thread's `updatedAt`, ignoring turns older than
  Chief of Staff's latest prompt to that thread). When a turn ends, the agent's step report
  decides what happens; without one, an open interaction or a plain-text
  question parks the item on you, otherwise the agent is nudged.
- Jobs: check commands, push/PR and merge run detached from event handlers
  with their own timeout. Their result is applied only if the item is still
  waiting on that job; a job lost to a restart is started again by the sweep.
  Errors are retried with backoff before they reach you.
- Answering from the dashboard: click the question on a waiting card to see
  the question, its options and the agent's last message, then answer in place
  or open the thread. Questions, approvals and requests are resolved with
  `threads.interactions.resolve`; a plain-text question gets a reply message.
  The activity log records who answered, not what they wrote.
- Commands on a checkout (git and check commands) run on the enrolled
  host through the plugin's `host.ts` entry; nothing opens user paths from the
  server process.
- Worktree branches are named by BB when the thread is created (the thread
  title is set to `cos/issue-<n>-<slug>` so the derived name follows it); the
  plugin records the real branch name once the environment is ready.

## Development

```sh
npm test            # vitest: workflow engine and validation, stats, fake plugin host e2e
npm run typecheck
bb plugin dev       # build + install + reload on change
```
