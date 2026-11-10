# Changelog

## Unreleased

- **Task actions that end or reset work ask first.** "Mark done", "Mark
  failed" and "Run again from here" ask for confirmation; the last one says
  how many steps it resets. Retry, Resume and Approve stay one click. The More
  actions menu closes on Escape, outside clicks and taps, and works with the
  keyboard. A sent message clears so it can't go twice, and closing the
  question sheet with an unsent reply asks first. Actions on one task no
  longer re-enable another task's buttons.

- **Fixed Model steps no longer keep the choosing text.** Switching a Model
  step from Automatically to Fixed, or to another step type, drops the default
  "choose the best model" instructions (text you wrote stays). The Notes field
  of Check, Ship and fixed Model steps now says what it is: your own notes,
  which no agent sees.

- **Stale errors and old task snapshots.** A task's card no longer keeps
  showing an error such as `Cannot read properties of undefined (reading
  'length')` once its step recovered: on a running task the error is cleared
  as soon as no step is still retrying or waiting on Chief of Staff, including
  cards left stuck by earlier versions (cleared at their next event). Merge
  wait reasons and errors of failed tasks are kept; an engine error is cleared
  once the same kind of event is handled. A stored workflow step that no
  longer passes validation is repaired field by field instead of kept as
  stored: missing or wrongly typed fields get their defaults, invalid optional
  fields and invalid entries in lists such as `chooses` are dropped. Failed
  effects and engine errors now log their stack trace in the activity log.

- **Model steps pick the model automatically.** A Model step no longer has to
  name a model: by default it runs a read-only agent that reads the task and
  the step's instructions (“choose the best model for the job”), looks at the
  providers and models available in BB, and picks the provider, model and
  reasoning level the later agent steps run with. The task's workflow view
  shows the pick. Choose **Fixed** to set the values yourself; existing Model
  steps that set values keep working as fixed.

- **Sheets and the workflow view work from the keyboard.** The task workflow
  sheet and the question sheet now take focus when they open, keep Tab inside,
  close on Escape, and return focus to the button that opened them. Steps on
  the workflow canvas can be selected with Enter or Space and are announced
  with their type and status; in the workflow sheet Escape leaves full screen
  first, then clears a focused step, then closes. The workflow sheet has a new
  List view with the same “Run again from here” action, so the canvas is no
  longer required. Single-select answers in a question are one tab stop moved
  through with the arrow keys. Status wording in the workflow sheet now matches
  the canvas (“needs approval” instead of “waiting”).

- **Dashboard works on phones.** Dashboard tabs stay on one line; the
  Repositories panel no longer scrolls sideways; pull request titles wrap
  instead of being cut short; the activity feed stacks each entry and expands
  in place instead of using a nested scroll box; chart dates stay on one line;
  configuration sections wrap so the selected one is always visible; the
  workflow editor's add-step toolbar no longer covers the top steps; long task
  titles in the workflow sheet are clamped; the question sheet fits the
  visible screen height.

- **Pause a single project.** Each project card now has its own Pause/Resume
  button, alongside the existing global “Pause everything”. A paused project
  holds its intake, new tasks, workflow events and sweeps, then replays held
  events in order on resume; other projects are unaffected. Existing
  installations gain a `paused_repos` table via an appended migration.

- **Group workflow threads in the sidebar.** Planning, building, and review
  threads now share a persistent parent thread in BB’s native tree. Existing
  active workflows are grouped automatically, child-result notifications are
  disabled, and completion archives children before their parent.

- **No more silent stalls after an agent finishes.** Chief of Staff no longer
  loses a step report when it fails to handle the turn end: the report and the
  idle stay unhandled, the failure shows on the task (last error and activity
  log), and the next sweep tries again. A step still running a few minutes
  after its agent went idle, with nothing in flight, has its turn end read
  again (report → move on, question → park, otherwise nudge). When that still
  cannot move it, the stall notice says the agent finished rather than blaming
  a quiet agent, and engine errors send a notification. Tasks started before model choices existed no
  longer crash with `Cannot read properties of undefined (reading 'length')`:
  stored workflow snapshots get the defaults of newer step fields.

- **Upgrade migration fix.** Restore the recorded index of the queued-event
  migration so existing installations can update without a migration 27 mismatch.
  Pause-control tables are appended after the existing migrations. Installations
  that already recorded the reordered pause migrations retain that history, with
  all statement hashes still validated by the SDK.

- **Visual task cues.** Larger state pictograms, repository and usage icons,
  recorded step-state symbols, and a theme-aware empty-queue illustration make
  the dashboard easier to scan without replacing text labels.

- **Active work first.** The dashboard puts attention items and task cards above
  historical throughput and capacity, with compact stage filters. Failure
  decisions and stalls have separate drill-downs; terminal failures remain
  historical outcomes. Cards lead with task titles and Open thread, collapse
  workflow details, and hide unavailable usage. Activity shows readable updates
  with expandable technical details and links to the task workflow.

- **Model steps.** A new workflow step type sets the agent (provider), model and
  reasoning level for the agent steps after it, and keeps applying until another
  Model step changes them. It does no work of its own and completes instantly.
  A running builder thread keeps the model it started with. An agent step can
  also list model choices and pick one by analysing the task, so the agent
  decides which model the later steps use.

- **Shipping has a completion boundary.** PR-only delivery finishes when the PR
  opens; merge delivery finishes after GitHub confirms the merge. CI and review
  waits release task capacity, while repairs and successors queue for an available
  slot. Stored PR-only CI/ready items reconcile after restart. Closed, unmerged
  PRs fail delivery. The dashboard reports task reservations separately from
  unfinished work. Use merge mode when delivery must include merging; PR-only
  mode no longer watches or repairs later CI failures.

- **Finished tasks archive their threads.** When a task's workflow is done,
  Chief of Staff archives the builder and step threads it started, so the
  sidebar only shows work in flight. Failed tasks keep theirs. Turn it off with
  `archiveThreadsOnDone` (Configure → General → Housekeeping).
- **Your own workflows.** A workflow is now a graph of steps you define,
  replacing the fixed Plan → Build → Verify → Review → Ship (which stays as the
  default). Three step types share a name, instructions and arrows to the steps
  after them:
  - **Agent**: agents work on the instructions; code-writing or read-only;
    read-only steps can run several agents in parallel; optional approval by
    you and a pass/fail verdict that sends the work back to an earlier step.
  - **Check**: Chief of Staff runs a command; failure goes back to a step.
  - **Ship**: push, open a PR, or merge when green; red CI goes back to a step.
  Steps side by side run in parallel; a step waits for every step pointing at
  it. Each step's prompt carries the reports of the steps before it.
- **Canvas editor.** Configure → Workflows: drag steps, connect them, add and
  remove them (React Flow), or edit them as a list. Several workflows; each
  repository picks one; a task keeps the workflow it started with.
- **Agent skills in step instructions.** Type `/` in an agent step's
  instructions to pick a skill from the configured projects; referenced skills
  are listed under the field (unknown ones flagged) and reach the agent as
  skill mentions, so the provider loads them.
- **Live workflow view.** Task cards show the workflow's steps with their
  state (parallel steps stacked); **Workflow** opens the task on the canvas and
  runs any step again from there (`bb cos item rerun <id> --step <step>`).
- `cos_report` takes the `step` id; agents on read-only steps get their own
  threads (in the task's workspace once code exists).
- Migration: the stage config converts into a workflow (repos with stage
  overrides get their own), and tasks in flight continue at their stage.


- **Delivery workflow: Plan → Build → Verify → Review → Ship.** Chief of Staff
  takes every task through these stages and only moves on when the agent
  reports the stage done. Each stage can be switched off (Build always runs) and
  carries your own instructions. A global workflow (Configure → Workflow, or the
  `workflow` setting) applies to every repository; a repository can customise
  any stage. Defaults: plan with your approval, verify with the repo's check
  command, an independent reviewer agent, then a pull request.
  - Plan: the agent writes a plan without touching code; with "Wait for my
    approval" it shows up in the dashboard with Approve / Send back.
  - Verify: the verify command (falls back to the repo's `checkCommand`)
    and/or agent verification with your instructions. Failures go back to Build
    on a budget, then to you.
  - Review: a fresh reviewer thread in the builder's own workspace (it sees
    exactly what was built), or self-review. Requested changes go back to
    Build → Verify → Review, on a budget.
  - Ship: push only, open a PR (you merge), or open a PR and merge it when CI
    is green. With instructions, the agent writes the PR description. Red CI
    goes back to Build → Verify → Ship (no second review).
- **Explicit stage reports.** Agents finish a stage with the new `cos_report`
  tool (or a `## Stage report` block when the provider has no plugin tools).
  An agent that stops without reporting is nudged twice, then handed to you.
  This replaces guessing "finished vs asking" from the last message.
- **Reliable tracking of where each agent is.**
  - Every item now shows its stage and who holds the ball: the agent, Chief of
    Staff, you, or an infrastructure retry, with a one-line "now" description.
  - Thread events and the per-minute sync are serialized per item and each
    turn end is handled once (no more double check runs).
  - Long steps (verify command, push/PR, merge) run as detached jobs with their
    own timeout, so event handling and the sweep never block; a job lost to a
    restart is started again; a late result from a stale job is dropped.
  - Chief of Staff's own failures (host timeouts, GitHub errors) are retried
    with backoff (1, 4, 9 min) and only then reported to you, labelled as
    Chief of Staff's problem rather than the agent's.
  - The sync reads all tracked threads in one call and uses the runtime status
    (`provisioning`, `waiting-for-host`, …), pending interactions and prompts
    the thread never picked up.
- **Tasks without an issue.** "New task" on the dashboard, `bb cos task`, the
  `cos_start_task` RPC and agent tool start an item from a description.
- Answer panel: plan approval and escalations get Approve / Send back with
  feedback. CLI: `bb cos item approve|revise --message …`.
- **Removed: routines and everything that only served them.** The Routines
  tab, `bb cos run` / `bb cos routines`, the routine RPCs and the batch-merge
  preview are gone, along with the release, deploy and batch-merge steps.
- **Fewer settings.** Repositories keep: project, issue labels / assignee,
  intake on/off, max agents, agent (provider, model, permission mode),
  reviewers, merge strategy, and per-stage workflow overrides. Removed:
  `allow.*` flags (Ship's action decides), `checkCommand` (now Verify's
  command), deploy / release / version / tag options, merge filters, conflict
  handling, branch prefix and renaming, team reviewers, PR labels, milestone
  and explicit-number filters. General drops the CI poll interval (fixed at 2
  minutes), auto-retry of stalled agents, and the notification webhook.
  Ship gains `requireApproval` for merging.
- Existing settings keep working: `checkCommand` becomes the repo's verify
  command, `allow.intake: false` pauses intake, `mergeFilter.requireApproval:
  false` lifts the merge approval gate; other removed keys are ignored. Items in
  flight are migrated onto stages in place. `maxFixRetries` is replaced by the
  per-stage budgets (`verify.maxAttempts`, `review.maxRounds`,
  `ship.maxCiFixes`).
- Repo entries infer `owner`/`repo` from the BB project's GitHub remote;
  `{ "projectId": "proj_..." }` is enough. Explicit values still override.
- Configurator: picking a BB project fills the GitHub repository from its
  remote, and a blank repository is accepted when the project has one.
- Fix: a check command that times out is killed with its whole process tree
  (`make`, test runners, docker clients) and reported as a failed check.
  Before, surviving children held the output pipe open and the run surfaced as
  "host plugin call exceeded its deadline".
- When Chief of Staff's own step fails (checks, opening the PR), the roster
  says so ("Chief of Staff could not run the repository checks (the agent is
  not asking anything): ...") instead of a bare "waiting on human".
- Better thread-state reading: an item parked as waiting on a human, with no
  open interaction and no plain-text question, is re-evaluated when its thread
  has moved on (a turn whose events were missed). On startup, including after
  a plugin update, items parked by Chief of Staff's own failure re-run their
  checks. The work-item database is kept across updates.

## 0.4.2

- The answer panel is larger by default (up to 64rem wide, 85% of the window
  tall) and resizable: drag the bottom-right corner (or focus it and use the
  arrow keys, Shift for bigger steps), double-click it to reset. The size is
  remembered. A maximize button in the header fills the window.

## 0.4.1

- The answer panel renders Markdown with BB's chat message renderer: the
  agent's last message, a plain-text question, question prompts, option
  descriptions, approval reasons and plans now look as they do in the thread.
  Commands and check output stay monospace. A trimmed last message is cut at a
  line break, and a code fence is reopened when the cut lands inside one.

## 0.4.0

- Answer agents from the dashboard. Click the question on a waiting card to
  open it: the agent's question with its options (and their descriptions), a
  free-text box when the question allows one, approval decisions with the
  command or plan being approved, and the context around it (the agent's last
  message, failing check output, last error). Send the answer, or open the
  thread instead.
- Answers go through `bb.sdk.threads.interactions.resolve` for questions,
  approvals and namespaced requests; plain-text questions get a reply message
  in the thread. Forms from other plugins link to the thread.
- New RPCs `cos_question` and `cos_answer`. Answers are validated against the
  open interaction (offered options, required questions, offered decisions),
  logged with who answered, and never logged verbatim.

## 0.3.0

- Thread state stays in sync with BB. Every minute the sweep re-reads each
  tracked thread and its pending interactions, so changes made directly in BB
  are picked up even when no event fires (or the plugin missed it).
- Resuming a thread works: when a waiting, blocked, failed or PR-open item's
  thread starts a new turn, the item goes back to running, and the next idle
  re-runs checks and pushes to the same branch. A human resume resets the fix
  budget.
- The plugin shows what the agent is asking. Questions, approval requests and
  plugin requests are stored on the item and shown on the dashboard card, in
  `bb cos status`, in the agent tool and in the notification.
- An agent that ends its turn with a plain-text question (no Summary section,
  last paragraph ends in "?") is marked waiting on human instead of being sent
  to checks.
- Unarchiving a thread that was archived mid-task resumes its item.

## 0.2.1

- Fix installing from GitHub: `@get-bb/plugin-sdk` and `@radix-ui/react-slot`
  are now runtime dependencies, so the production-only install that git
  sources use can build the frontend bundle.

## 0.2.0

- Visual configurator: Configure tab in the dashboard and on the plugin's
  settings page. Edit repositories, routines, general limits and GitHub access
  without touching JSON; validation before save; raw JSON still available.
- Multiple repositories, each with its own project, filters, agent and
  allow flags. New repos start least-privilege.
- Write-only GitHub token field; the token is never returned or logged.
- Incomplete repo entries load for editing instead of hiding the whole list.
- Install from GitHub with automatic updates documented.

## 0.1.0

- Initial release: agent roster with stall detection, GitHub issue intake into
  worktree agent threads, PR delivery with check command + CI fix cycles,
  routines (batch_merge, release, deploy, run_agent, notify) on a durable BB
  schedule, dashboard panel, `bb cos` CLI and `chief_of_staff_status` tool.
