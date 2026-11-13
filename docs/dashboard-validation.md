# Dashboard design changes (#22)

Implemented as three tasks: active-work hierarchy and attention filters; task
card hierarchy and actions; activity feed presentation (subsequently restored
to the previous compact rows).

## Behavior

- Active tasks precede throughput and repository capacity. Compact stage
  filters replace the duplicated metric tiles and pipeline distribution bar.
- Failure decisions, ordinary questions/approvals, and stalled tasks have
  distinct attention filters. Terminal failed runs remain historical outcomes.
  README documents the lifecycle rule; no schema or execution changes are needed.
- Cards lead with the title, retain current status and task age, omit repeated
  generic working text, and expose full step progress on expansion. Task age is
  measured from task creation, not from the current step's start.
- Missing usage fields disappear; zero tokens and zero cost remain visible.
  Open thread is primary when available, Workflow remains available without it,
  and existing approval, retry, PR, and overflow actions are retained.
- Activity uses the previous compact rows: severity icon, event type, repository,
  original message, actor and timestamp are visible together. Problems only
  retains the severity filter. Long messages wrap within their row.
- Since #109 each row also names its task (`#N title`, or a described task's
  title), as a truncated button that opens the task's workflow. Thread ids in
  the message and actor are links. The repository is left out when only one
  is configured. A Task menu, or Show activity on a card, narrows the feed to
  one task; Problems only applies on top. Message text is unchanged.

## Validation

Task context in Activity (#109): `npm run check` (lint, typecheck, all tests)
and `npm run build` pass. Tests cover the `listLog` join (row id and repo kept,
missing tasks unnamed), task labels, the workflow sheet opened from a row with
focus returned, thread links in messages and actors, the Task menu and clear,
Show activity from active and finished cards, the combined filters, and the
repository prefix with one, two and unknown repositories. No live browser
check was performed.

Compact activity restoration: all 166 tests across 15 files, typecheck, plugin
build and whitespace checks pass. The dashboard test verifies visible event
type, original message, actor and timestamp, and Problems only filtering.
The unused summary formatter and its tests were removed. No new live browser
check was performed for this restoration.

Original dashboard redesign validation (before the activity restoration):

- `npm test`: 129 tests passed across 15 files. New tests cover attention
  classification and drill-down, history separation, DOM reading order, missing
  and zero usage, thread navigation, summary accuracy and problem filtering.
- `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- BetterWright visual fixtures at 1280 px and 390 px: active work, historical
  failures without current attention, missing and zero usage, attention,
  expanded workflow steps, and an empty roster. No horizontal page overflow
  in those fixtures. Light and dark theme-token fixtures were inspected.

Visual checks used static rendering of the actual React components and the
built plugin CSS, with simulated host theme/reset styles, fixture RPC data,
and host icons omitted. Native disclosure expansion was checked in the browser;
React filter/navigation interactions were checked in jsdom. These checks do not
replace a live BB installation check of host navigation, icons, and theme
integration. The running plugin was not reinstalled or reloaded.

BB reports installed SDK 0.6.132 versus the repository pin 0.6.104. Build succeeds
with the existing pin; no SDK upgrade is included.

## Keyboard and focus (issue #67)

What changed: the task workflow sheet and the question sheet are built on the
vendored dialog (`components/cos/sheet.tsx`); canvas selection comes from
React Flow's `onSelectionChange`; the workflow sheet has a List view; single-select
question options use a roving tabindex; the skill typeahead sets
`aria-controls` only while its list is mounted.

Decisions worth knowing:

- The sheets open from state, not from a dialog trigger, so the opener is
  recorded on click and focused again on close. If it has left the page (a
  question card changes once answered) focus goes to the “Work overview”
  heading.
- The sheets always use the centred dialog, never the swipe-to-close drawer.
- A canvas selection that is an arrow or several steps leaves the open step
  panel alone, as before. Arrows are tab stops in the editor only.
- In the workflow sheet, Escape on a step never reaches React Flow (the dialog
  handles it first and stops it): React Flow would blur a selected step and
  select an unselected one. Escape on the selected step clears it and keeps
  focus there; Escape on any other step closes the sheet.
- Switching the workflow sheet to List leaves full screen.

Checks:

- `npm run check` (lint, typecheck, 222 tests in 24 files) and `npm run build:ci` pass.
- jsdom: `tests/sheetFocus.test.tsx` (focus in, Tab wrap, Escape order, focus
  return, fallback, rerun from the list), `tests/workflowCanvas.test.tsx` (the
  real React Flow canvas: Enter selects, Escape clears, a selection made by the
  parent is not undone, node names), `tests/workflowSheetCanvas.test.tsx` (the
  real canvas inside the real sheet: Escape clears the selected step and keeps
  focus on it, Escape from another step closes), `tests/questionField.test.tsx`
  (arrow keys, Home, End), `tests/skillTextarea.test.tsx`.
- Real browser (BetterWright, Chromium) at 1280 px and 390 px, keyboard only
  where possible, on the actual components with the built plugin CSS, fixture
  RPC data and a simulated host theme: both sheets open, trap Tab and return
  focus; Enter and Space select a canvas step; Escape order; backdrop click;
  wheel zoom on the canvas and scrolling inside the question sheet under the
  dialog's scroll lock; rerun from the List view; arrow keys on single-select
  options; arrow-key resize, reset and maximize of the question sheet; phone
  bottom-sheet layout; no horizontal overflow at 390 px; dark theme reaches the
  portaled sheets. In the editor: keyboard select, Add step keeps its new
  selection, selecting an arrow keeps the panel, Backspace removes the arrow,
  a pane click deselects.

Not checked: a screen reader, Safari, and a live BB installation (host
navigation, icons and theme). The running plugin was not reinstalled.

Not in this change: the workflow editor's full screen is still not a dialog,
and the task card's “More actions” menu has no menu keyboard behaviour. (Since fixed: the
menu is a Radix dropdown menu with keyboard support, issue #65.)
