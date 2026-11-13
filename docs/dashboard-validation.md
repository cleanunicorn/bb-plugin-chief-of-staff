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

## Validation

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

## Keyboard path past the task grid (issue #115)

What changed: every dashboard `Panel` is a region named by its heading
(`section[aria-labelledby]`); the Pipeline tab has a “Skip to throughput and
activity” link right after the “Work overview” heading; the Throughput chart's
day columns are images (`role="img"`, named with the day's numbers) instead of
buttons; the task grid is one group (`role="group"`, “Tasks”) with a roving
current card (`components/cos/rovingCards.ts`).

Decisions worth knowing:

- The skip link focuses the Throughput heading by script and cancels the click.
  bb routes the panel by `subPath`, so the hash must not reach the host. The
  `href` points at the Throughput section's real id in case scripts fail.
- The link is `sr-only` until focused, then absolutely positioned below the
  heading row so the row does not reflow. Its padding uses `focus:` variants:
  `not-sr-only` resets padding and sorts after the plain utilities. It has no
  `shadow-sm`: the plugin CSS does not define `--shadow-sm`, and the undefined
  variable drops the whole `box-shadow`, focus ring included.
- Chart days are not focusable. The table view toggle, just before the chart
  in tab order, gives the same numbers by keyboard. A real action for a day
  (open that day's finished tasks) belongs to #105. The view toggle buttons
  are named on the button (“Chart view”, “Table view”), not on the icon.
- Only the current card's controls have `tabIndex` 0; the others get -1,
  including the PR link (`UrlLink` passes `tabIndex` to its anchor). The first
  card is current until focus lands on another by any route: arrow key, click,
  or a sheet returning focus to its opener. If the current card leaves the
  list (refetch, filter, Show/Hide finished), the first card is current again.
- Arrow movement is linear in DOM order, one card per key, so Up and Down in
  the three-column layout move one card, not one row. Left and Up stop at the
  first card, Right and Down at the last; nothing wraps.
- The grid handler ignores keys a control already handled
  (`defaultPrevented`): ArrowDown on More actions opens its menu, as before,
  and does not move to the next card. ArrowUp there moves to the previous
  card. Keys with modifiers and keys from DOM nodes outside the grid (the menu
  and dialogs are portals, but React events bubble through them) are ignored.
- The hint “Arrow keys move between tasks.” is the group's description. It
  sits above the cards and is visible only while focus is inside the group;
  its line is reserved while hidden, so focus entering the grid does not
  shift the cards.

Checks:

- `npm run check` (lint, typecheck, 550 tests in 40 files) and `npm run build:ci` pass.
- jsdom, `tests/pipelineKeyboard.test.tsx`: named regions; chart days are
  images, not buttons or tab stops, and still show the tooltip on hover; the
  view toggles are named; the skip link is the first tab stop after the
  heading, also with no tasks, and moves focus to Throughput, three tab stops
  before “Problems only”; the grid's tab stops are the same for 5 and 50
  tasks and equal the current card's (7 for an approval card); arrows, Home,
  End, no wrap; modifiers ignored; focus makes a card current; ArrowDown on
  More actions opens the menu without moving cards; fallback to the first
  card. `tests/dom.tsx` gains `tabbables()`, which computes tab order (jsdom
  does not move focus on Tab). The existing menu and sheet focus tests pass
  unchanged.
- Real browser (BetterWright, Chromium, 1440×1000): the actual `PipelineTab`
  and `ActivityFeed` with the built plugin CSS and fixture data of 54 tasks
  (each with workflow steps, a thread and a PR). From “Work overview”:
  21 Tab presses to “Problems only” with an approval card current (the issue measured 235 in a live install); with the skip
  link, Tab, Enter, Tab ×3 (5 key presses). The skip link appears on focus
  with the focus ring and does not move the heading row. Enter scrolls to and
  focuses the Throughput heading. ArrowRight, ArrowDown, End and Home move
  between cards, and End scrolls the last card into view. Only the current
  card's PR link has tabIndex 0. ArrowDown on More actions opens the menu,
  Escape returns to the trigger, and Tab leaves the grid for “Chart view”.
  The hint is on screen with focus on the first card and hidden once focus leaves the grid. Hovering a chart day shows
  its tooltip.

The browser pass used a stand-in `UrlLink` that spreads its props. The host's
`UrlLink` in bb-app 0.49.0 (the version `build:ci` uses) does the same: it
renders an `<a>` with the rest props spread, so `tabIndex` reaches the anchor.

Not checked: a screen reader, Safari, and a live BB installation (icons and
theme). The running plugin was not reinstalled.
