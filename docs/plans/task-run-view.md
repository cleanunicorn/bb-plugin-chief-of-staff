# Task run view: details, handoffs and loop-backs in the workflow overlay

## Progress

- [x] Planning: read the overlay (`WorkflowSheet` in `app.tsx`), the canvas, the engine's step state and what the server exposes.
- [x] 1. Step journal: the engine returns what happened in each transition, and a new append-only `step_journal` table stores it with the actor.
- [x] 2. `cos_item_workflow` returns task details, each step's current inputs and outputs, its threads and the journal. All new fields are optional. (Needs 1.)
- [x] 3. Overlay redesign: the canvas fills the sheet and refits when the sheet resizes, a task summary strip, an always-visible side panel (overview and timeline, or the selected step), and loop-back counts on the arrows. (Needs 2.)
- [x] 4. Tests (engine journal, storage, RPC shape, loop model, overlay rendering), CHANGELOG, README.
- [x] Reports, feedback and the task description render as Markdown (the SDK's `Markdown`); check output stays monospace.
- [x] Verified visually: harness screenshots of the overlay before and after, with the overview and a selected step.
- [x] Review fixes: the journal is capped at 50,000 rows; the workflow view gets 600-character previews of long entries and loads the rest with `cos_journal_detail`; runs cut short by a loop-back are recorded (`interrupted`), as is why a task stopped (`stopped`: PR closed, builder thread lost); check and CI output is redacted; `docs/images/demo-data.js` carries task t3's history.
- [x] README screenshots (`docs/images/task-workflow-*.png`) retaken in BB with `docs/images/demo-data.js`. The headless page was served this branch's `app.js` and `app.css` in place of the installed plugin's; the installed plugin was not changed.
- [ ] Deferred: tasks started before this change have no journal. Their loop-back counts come from step rounds and failure counts and are labelled approximate.

## Problem

The Workflow button on an active task opens an overlay that shows the workflow graph coloured by step status, and little else:

- The canvas is fixed at 420px tall, so most of the 85dvh sheet stays empty.
- The overlay leaves out the task itself (description, branch, PR, threads, timing, why it is waiting).
- You cannot see what a step passed to the next one: its report summary, check output, or the feedback that sent work back.
- You cannot see how often work looped back to an earlier step, or why. The engine overwrites each step's state when it re-runs (`resetFrom` clears reports, `complete` clears feedback, `revise` zeroes attempts), so this history is not stored anywhere.

## Design

### Journal

`transition()` also returns `journal: JournalEntry[]`. Each entry has a kind, a step, a round, an optional `from`/`to` and a clipped detail:

| kind | when | detail |
| --- | --- | --- |
| `started` | a step starts a round | the feedback it runs with (why it re-runs) |
| `reported` | an agent files its report | the summary: what the next steps read |
| `passed` | a step completes | check output, or how it completed (approved, merged) |
| `failed` | verdict, check or CI fails; `to` = the step it loops back to, if within budget | failure detail |
| `waiting` | a step waits on a person | the reason |
| `revised` | the operator sends a waiting step back with feedback; `to` = where it re-runs | feedback |
| `rerun` | the operator re-runs a step | feedback |
| `interrupted` | a running or waiting step is reset because an earlier step re-runs; `from` = the step that sent work back, `to` = where it re-runs | — |
| `stopped` | the task fails: the PR was closed, or the builder thread was lost | the reason |

`dispatchLocked` writes the entries with the dispatch actor after it stores the transition. Transitions held back for capacity write nothing. The table is append-only and indexed by item.

### RPC

`cos_item_workflow` adds `task` (description, branch, PR, threads, status, waiting reason, last error, timing), `steps[id]` (current feedback, report summaries, check output, waiting reason, start and finish times, thread ids), and `journal` (oldest first, capped).

### Overlay

- The canvas takes the remaining height and refits on resize and on full screen.
- A summary strip shows elapsed time, steps done, loop-backs (for example `Review → Build ×2`), the PR and the branch.
- The side panel is always present, so the canvas does not jump. With no step selected it shows the task overview and a timeline. With a step selected it shows the step's inputs (from upstream steps), the feedback that sent it back, its output, its runs, and "Run again from here".
- Fail arrows carry a count once taken (`on fail ×2`). Arrows stay passive: the Escape and selection order is unchanged.
