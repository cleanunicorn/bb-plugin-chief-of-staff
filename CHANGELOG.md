# Changelog

## Unreleased

- **Discard in Configure asks first.** Discard in the save bar, and Revert in
  Advanced JSON, now open a confirmation that names what will be lost
  ('Discard changes to Workflows and General?') instead of dropping every
  unsaved draft at once. The save bar also says which sections have unsaved
  changes, and on phones Discard and Save sit at opposite ends of the bar.

- **A task waits out a Claude or Codex usage limit instead of failing.** When
  an agent's turn stops on the provider's subscription window (the 5-hour
  limit), its step keeps running and shows "usage limit reached; continues
  after 14:05 UTC". Once the window resets BB retries the failed turn and the
  agent carries on where it stopped, in the same thread, with no new prompt.
  You get one notification when the limit is hit. BB's provider-retry usually
  queues that retry, and Chief of Staff queues one itself when it did not. A
  reset more than 6 hours away (a weekly cap), a limit hit 5 times on one step,
  or one still in force 2 hours after its reset goes to you as a failure, as
  before. Credit and spend limits are still failures.

- **Intake no longer restarts an issue whose task failed or finished.** A
  failed task, a task marked done, a pushed or merged delivery and a PR closed
  without merging used to start the issue again from scratch at the next
  intake. The issue now stays stopped until someone relabels it (or assigns
  the filter's user again) or retries the task, and the intake result shows
  why it was skipped.

- **Overlapping intake runs no longer start the same issue twice.** Pressing
  "Run intake" (or `bb cos intake`) while the scheduled intake is running, or
  from two dashboards at once, used to create two tasks, two threads and two
  issue comments for one issue. Intake runs now take turns, and an issue is
  checked again just before it starts. Dry runs still answer straight away.

- **Mark done sticks.** A task marked done while its agent was still working
  went back to active, and the agent was nudged, when its turn ended. Now the
  task stays done: its agents get no more prompts, and the result of a check,
  push or merge still running is ignored (a push or merge already under way
  still completes on GitHub). Its threads are archived unless "Archive threads
  when a task is done" is off, which removes their workspace, so changes not
  pushed are lost; the confirmation says so. **Run again from here** on a done
  task unarchives its threads first. **Mark failed** also sticks while the
  agent is still working, a check it interrupts runs again on retry, and it is
  no longer offered on a task that has already failed. A task marked done
  reads "Closed" rather than "Shipped".

- **Auto-merge waits for CI to start.** In merge mode, a pull request whose
  head has no checks reported yet is no longer merged straight away: GitHub
  shows no checks until CI registers them. A head counts as having no CI only
  after about 5 minutes without checks, timed again after each push. Check runs
  past the first 100 are now read, so a failure there blocks the merge. A
  repository whose CI reports only check runs (GitHub Actions) no longer shows
  its checks as pending forever: GitHub's empty commit status is not counted.

- **Chief of Staff opens without crashing.** The activity feed omits its
  pagination cursor until viewing older entries, keeping query inputs valid JSON.

- **A task whose repository is not configured says so.** When a task's
  repository is missing from the `repos` setting (removed, renamed, or the
  setting has an error), a task waiting to start now reads "Repository
  owner/repo is not in the repos setting …" instead of "Waiting for task
  capacity", with one warning in the activity log. It keeps its place and
  starts on the next sweep after the repository is configured again. The
  overview and `bb cos status` show a warning naming the open tasks of
  repositories that are not configured, so you can fix the setting or close
  them.

- **Older tasks keep being tracked once you have more than 200.** Thread sync,
  retries, stall detection and restart recovery only reached the 200 newest
  tasks, so an older active task could miss turn ends, answered questions or
  deleted threads, and an older failed task was not revived when you resumed
  its thread. Every active task is now covered, and thread sync also checks
  every task that failed in the last 3 days; the roster still shows the 200
  newest.

- **Task cards and pull requests link to their GitHub issue.** A card's
  "repo #N" opens the issue in the browser, and its PR chip reads "PR #N" so
  the two numbers are no longer confused. Each row under Repos & PRs → Pull
  requests links "closes #N" to the issue and has a Workflow button that opens
  the task's workflow. Standalone tasks, which have no issue, show no issue
  link.

- **The Pull requests list shows each PR's own state.** Each row leads with
  Open, Draft, Merged, Closed or State unknown and, while the PR is open, its
  checks (passing, failing, pending, none) and review (approved, changes
  requested), each with its own icon and text. Finished tasks no longer read
  "Shipped" there. The list defaults to PRs that need action, puts failing
  checks and requested changes first, has Merged, Closed and All filters, and
  shows 10 rows at a time with **Show more**. Task cards show their PR's state
  next to the PR link. Open PRs refresh about every 10 minutes and need GitHub
  auth.

- **Merging with a required approval ignores pending reviews.** A reviewer's
  unsubmitted (pending) review no longer overrides their earlier verdict, an
  approval or requested changes.

- **Browse retained activity without losing older problems.** Problems only filters
  on the server before the page limit. Show older pages through retained entries;
  each page displays its time range and offers a return to the newest activity.

- **Keyboard users can skip the task grid.** The first Tab after “Work
  overview” is a “Skip to throughput and activity” link, shown on focus.
  Only one task card's actions are in the tab order; arrow keys move between
  cards, and Home and End jump to the first and last. With 54 tasks, “Problems
  only” in Activity is about 20 Tab presses away instead of 235, or 5 key
  presses through the skip link. The task list, Throughput, Capacity and
  Activity are named regions. Throughput chart days are no longer buttons
  that did nothing; use the table view for daily numbers by keyboard.

- **The task workflow view reads on phones.** Below 640 px the sheet header
  gives the task's repository, number and title a full-width line, the
  Canvas/List switch shows icons only, and the overview scrolls with the
  canvas instead of in a small box, so the thread, issue and PR links are in
  reach. The "Select a step…" footer hint is no longer repeated there.

- **Task cards and Throughput are easier to tap on touch screens.** On a
  touch (coarse) pointer, Open thread, Workflow, Approve, Resume, the pull
  request link and More actions are 40 px high, the Chart/Table toggle buttons
  are 34 px with space between them, and the Workflow progress row is taller.
  The whole pull request chip is now the link. On touch, tapping the
  Throughput chart opens its table instead of targeting 20 px day columns.
  Sizes with a mouse or trackpad are unchanged.

- **More actions stays on the first row of a task card.** It no longer wraps
  onto a line of its own; when the actions don't fit, the last one before it
  wraps instead. This also applies to narrow desktop windows.

- **Finished cards say how a task ended, when, and why.** With **Show
  finished**, a card and its Pull requests row read Merged, PR opened,
  Completed, Marked done, Failed, Marked failed or PR closed, each with its own
  icon. A delivered task no longer reads "Closed" because of an old error,
  and a task marked done by hand no longer reads "Shipped". Failed and
  PR-closed cards show why they ended (for example "thread archived") without
  opening the workflow; a task marked failed by hand shows its last error as
  such, not as the cause. The timer says "Finished 2h ago · took 1.2h"
  instead of the start time. Steps a finished task left running, waiting or
  in CI show as stopped in the card, the step list and the workflow view, and
  the workflow view no longer shows a finished task as waiting on you. A
  finished task with no history no longer says "No history yet".

- **Issue text in agent prompts is marked untrusted, and only maintainers'
  comments are quoted.** The issue's title, body and comments now sit in a
  delimited block that tells the agent they are user-supplied data that
  cannot override the workflow. Every line in it is quoted and each comment
  shows its author's association, so issue text cannot fake the block's end
  or a maintainer's comment. By default the brief quotes only comments by the repository's
  owner, members and collaborators and says how many others it left out. The
  new per-repository `briefComments` option (`trusted`, `all` or `none`)
  changes that. The README has a new Trust model section.

- **Active tasks always show, and finished history is paged.** The roster
  used to list the 200 most recently created tasks, so with **Show finished**
  on, an active task older than those (one waiting on your approval, say)
  vanished from the Pipeline, its Needs-attention and stage counts, and its PR
  from Repos & PRs. Now every active task is listed first, newest first,
  followed by the 50 most recently finished; **Show older finished** loads the
  next page. Repos & PRs shows every active task's PR plus the 200 most
  recently finished. `bb cos status --all` takes `--finished-limit` and
  `--before <cursor>` and prints the command for the next page;
  `cos_roster` and `chief_of_staff_status` take `finishedLimit` and `before`
  and return the next cursor (`nextBefore`). `bb cos` JSON output is no
  longer cut off at 60,000 characters, so it always parses.

- **The Pipeline tab stops re-reading token usage of finished tasks.** A
  finished task's usage is read from its thread once and stored; later
  refreshes reuse it, so **Show finished** costs about the same as active work.
  Usage of unfinished tasks is read concurrently instead of one task at a
  time. The dashboard's own refresh after a burst of updates now runs once,
  500 ms after the burst ends, or every 2 s while updates keep coming.

- **Activity rows name their task.** Each row that belongs to a task shows its
  issue number and title, or a described task's title, also for finished
  tasks; selecting it opens the task's workflow. Thread ids in messages and
  actors open their threads. A Task menu next to Problems only narrows the
  feed to one task, and so does Show activity in a task card's More actions,
  including on finished cards; both filters combine. With a single
  repository configured, rows no longer repeat its name. Message text is
  unchanged.

- **Finished task cards offer actions that fit how the task ended.** Failed
  cards offer "Restart on a new thread…", which asks first because it can
  start an agent and take a task slot, and "Mark done…"; they no longer offer
  "Mark failed…". Done cards offer "Run a step again…", which opens the
  workflow at its step list.

- **Cleaner workflow progress on task cards.** The collapsed row shows one
  segmented bar, one segment per step, with a done count; states differ by
  shape as well as color. Expanded, steps are
  listed top to bottom in workflow order, each with a status mark; steps that
  run in parallel are boxed together. Chips no longer wrap across lines with
  dangling arrows.

- **Intake and CI polling share sweep time fairly.** When a slow phase uses
  the budget, the other overdue phase gets the first turn on the next sweep,
  including after errors, rate limits and reloads. Frequent intake cannot
  indefinitely block CI polling, and slow CI cannot block intake.

- **Slow intake resumes across repositories and issues.** Scheduled intake
  saves its position between passes, including after reloads. A repository
  whose issue listing uses the time budget still considers one issue before
  yielding, so it and later repositories keep making progress.

- **Existing issue status comments are recovered without duplicates.** If the
  saved comment id is missing, recovery still finds older status comments
  beyond the newest ten replies. Agent briefs keep their newest-comment view.

- **CI polling resumes where its last pass stopped.** Older pull requests
  still get checked when slow requests exhaust the polling time budget,
  including after a plugin reload.

- **Shorter agent prompts.** Each step prompt is about 150–250 characters
  shorter: the delivery id now sits in the `cos_report` call and the
  `## Step report` block instead of a separate trailing sentence, and the
  reporting, model-pick and nudge wording is tighter. The Chief of Staff skill
  is about 20% smaller; its agent section points to the prompt's reporting
  instructions instead of repeating them.

- **Text reports on pass/fail steps no longer default to a pass.** The
  `## Step report` template on a pass/fail step shows `outcome: <done or
  failed>` instead of `outcome: done`, so an agent copying it verbatim cannot
  pass the work by accident. The reminder sent to an agent that stops without
  reporting now names the model-choice ids or pick fields its step requires.

- **The dashboard tabs fit on narrow screens.** Below 640 px the Pipeline,
  Repos & PRs and Configure tabs show their labels without icons, so all
  three, the selected tab and the unsaved-changes dot on Configure fit
  within a 320 px screen. If a large font size still makes them too wide,
  the tab strip scrolls sideways inside its border instead of pushing past
  the edge of the screen.

- **The task workflow view fits short screens.** In phone landscape and other
  short, wide windows, the canvas sits beside the details panel and shrinks to
  the space left. Its zoom and fit controls, the view switch, Close and "Run
  again from here" stay inside the dialog, with or without a step selected.
  The task summary keeps to one line. Taller screens keep the layout they had.

- **Fit shows the whole task workflow on phones.** Opening a task's workflow,
  resizing it and **Fit all steps in view** now zoom out as far as needed to
  show every step, and Zoom Out no longer stops at half size. Opening and Fit
  frame the graph the same way, in the task view and in the workflow editor.

- **Intake asks GitHub for open PRs once per repository, and not at all when
  the repository is full.** It used to list every open PR for each labelled
  issue, even when the repository had no free slot. It now checks capacity
  first, lists the open PRs once per run, and reads the newest 500 rather than
  the oldest, so a recent PR still stops its issue from being picked up again.
  `bb cos intake --dry-run` now counts the issues it would start against the
  concurrency limits, so it reports what a real run would do.

- **Saved configuration drafts survive a failed reload.** After a partial save,
  workflow and repository drafts stay until a successful read confirms their
  saved values. Retry reloads without repeating writes, and keeps any newer
  edits, including across dashboard tab switches.

- **The dashboard and task admission stay fast as history grows.** Counting
  task slots, the overview and the stats no longer read every task's full
  workflow state, a stored workflow is checked once rather than on every
  read, and the sweep only regroups a task's threads when they change. The
  stats' total and in-window counts are no longer capped at the 5,000 newest
  tasks.

- **Finished tasks are trimmed after 90 days.** 90 days after a task finishes,
  Chief of Staff removes its per-step outputs, report summaries and feedback
  text. The task keeps its status, PR, branch, timestamps, step statuses,
  model picks and thread links, so it still appears under finished tasks,
  counts in stats, and can be retried on the same models.

- **One status comment per issue, and no more `bb://` links.** Chief of Staff
  posts a single status comment when an agent starts on an issue and edits it
  when the task restarts or the issue is picked up again, instead of adding a
  new comment each time. The comment and the pull request description link the
  agent's thread only when BB has a web URL; without one they no longer carry a
  `bb://` link that GitHub cannot open. The first restart after the update
  edits the newest of an issue's old "started an agent" comments, which removes
  its `bb://` link; older duplicates on the same issue stay as they are. A new
  per-repository `issueComments` setting (Repositories → Comment on issues,
  default on) turns the status comment and the "opened pull request" comment
  off. The pull request comment stays a separate comment.

- **The plugin is now licensed under Apache 2.0.** The full text is in
  `LICENSE`, and `package.json` declares it.

- **Accurate plugin descriptions.** The plugin description in BB no longer
  mentions scheduled routines (removed earlier), and the issue intake overview
  names only the filters that exist: labels and assignee.

- **The visual editor no longer overwrites a stored document it could not
  load.** When the stored workflow or repositories JSON is invalid (edited by
  hand or over the CLI, or left invalid by an older version), the Workflows or
  Repositories section now shows the error and an "Open Advanced JSON" button
  instead of the built-in default or an empty list. Saving from the visual
  editor leaves that document out, so one rename or "Add repository" can no
  longer replace every custom workflow or repository. The other document and
  General settings stay editable. A repository's workflow picker is read-only
  while the workflows do not load. The banner now says what failed and that the
  stored JSON is left unchanged.

- **Unsaved configuration edits are no longer lost.** Drafts in Configure
  (workflows, repositories, general settings and Advanced JSON) now survive
  switching sections or dashboard tabs. Advanced JSON edits count as unsaved
  changes: they mark the section, show the save bar and lock the visual
  sections until you save or discard them. The Configure tab shows a dot
  while any edit is pending, and reloading the page asks first. "Save JSON"
  can no longer be sent twice by a double click, and a JSON edit can be saved
  even when the loaded configuration has problems the visual editor flags.

- **Save stays off until the configuration is valid.** The configurator now
  lists every reason the server would reject a save: empty names, choice ids,
  "Use when" and check commands, out-of-range numbers and over-long text in
  workflows and general settings. Each problem also shows next to its field.
  Number boxes keep what you type within range. A save no longer writes the
  repositories and workflows and then fails on the general settings; if the
  general settings still fail to send, the status says what was saved and only
  General stays unsaved once the saved documents are successfully reloaded.

- **Backspace and Delete no longer remove a workflow step.** In the workflow
  editor the keys deleted the selected step and its instructions at once, even
  with focus on a switch in the side panel, and the only undo was discarding
  all unsaved changes. They now remove only a selected arrow; remove a step
  with the Remove button in its panel, which asks first. The canvas also no
  longer drops the only step of a workflow while the workflow keeps it.

- **Dashboard query errors are no longer hidden or take over the editor.** The
  Pipeline tab now shows a failed overview read, and the Repos & PRs tab shows
  a failed roster read instead of "No pull requests yet" (the Pipeline tab no
  longer says "No active tasks" for a failed roster either). Each tab lists
  every failing read once. In the configuration editor, one failed refetch
  (after Save, or from a live update) no longer replaces the editor and your
  unsaved changes with an error line: the editor stays and a banner with Retry
  appears above it. The error alone, also with Retry, shows only when the
  configuration has never loaded.

- **GitHub outages and rate limits no longer stall or fail tasks.** GitHub
  requests time out after 30 seconds, and a sweep stops starting new intake
  and CI work after two minutes, so thread sync, retries and stall detection
  keep running. On a GitHub rate limit, Chief of Staff pauses
  GitHub work until the limit resets, says so in the overview warnings and
  `cos status`, and runs the waiting steps (opening a PR, starting an agent)
  again after the reset without using up their retries. CI failures are
  reported to the agent once their logs can be downloaded.
- **Agents see the newest comments of a long issue.** The brief quotes the
  last 10 comments, however many the issue has; it used to quote the last 10
  of the first 300.

- **See what happened in a task's run.** The task workflow view now fills the
  sheet: the canvas takes the full height and refits when the sheet resizes.
  A summary strip shows the task's status, how long it has run, the steps done,
  the loop-backs, the PR and the branch. The side panel shows the task's
  description and links, every loop-back (for example `Review → Build ×2`, with
  the latest reason), and a history of the run. Select a step to see what it
  received from the steps before it, the feedback that sent it back, its report
  or check output, its runs and its threads. Fail arrows show how many times
  they were taken. The history also notes runs that were cut short when
  another step sent work back, and why a task stopped (a closed pull request,
  a lost builder thread). Long entries load in full when you expand them.
  Chief of Staff records each step's history in a new table (the most recent
  50,000 entries are kept), so this history starts with tasks that run after
  the update.

- **The GitHub token is redacted from check and CI output** before it is
  stored, shown in the dashboard or sent to an agent as feedback.

- **Clearer workflow canvas controls.** Fit view uses a crosshair, and a
  labeled Full screen button uses outward arrows. The expanded workflow editor
  has its own Exit full screen bar with an Escape hint, separated from step
  removal; the task workflow sheet also has a labeled exit button.

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

- **Removal confirmations stay with their item.** Confirming "Remove?" on a
  repository or model choice no longer leaves the next one armed (a double
  click removed two), and selecting another step on the canvas, or another
  workflow tab, no longer carries the confirmation over to it.

- **Deleting a workflow moves its repositories to the default.** The
  confirmation names the repositories that will use the default workflow, and
  their choice is cleared, so a later workflow with the same name no longer
  picks them up silently. A repository already pointing at a deleted workflow
  shows it as "Missing" in its workflow selector.

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
