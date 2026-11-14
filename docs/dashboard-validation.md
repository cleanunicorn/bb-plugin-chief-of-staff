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
  including the issue and PR links (`UrlLink` passes `tabIndex` to its anchor). The first
  card is current until focus lands on another by any route: arrow key, click,
  or a sheet returning focus to its opener. If the current card leaves the
  list (refetch, filter, Show/Hide finished), the first card is current again.
- Arrow keys land on the card's “Workflow progress” row (marked with
  `data-roving-entry`), or on its Workflow button when it has no workflow
  steps. The issue link comes first in the card, but it leaves the plugin,
  so it is not where arrows land.
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
  tasks and equal the current card's (8 for an approval card, counting the
  issue link added in #113; 7 when this was measured); arrows, Home,
  End, no wrap; modifiers ignored; focus makes a card current; ArrowDown on
  More actions opens the menu without moving cards; fallback to the first
  card. `tests/dom.tsx` gains `tabbables()`, which computes tab order (jsdom
  does not move focus on Tab). The existing menu and sheet focus tests pass
  unchanged.
- Real browser (BetterWright, Chromium, 1440×1000): the actual `PipelineTab`
  and `ActivityFeed` with the built plugin CSS and fixture data of 54 tasks
  (each with workflow steps, a thread and a PR). From “Work overview”:
  21 Tab presses to “Problems only” with an approval card current (measured
  before #113 added the issue link to each card, which adds one) (the issue measured 235 in a live install); with the skip
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

## Workflow sheet on phones (issue #118)

Below `sm` (640 px) the workflow sheet uses a third class set, chosen by
`PHONE_VIEWPORT_QUERY` (`not all and (min-width: 40rem)`), which never matches
together with the short-viewport query from #98. The wide and short layouts
are unchanged. On a phone:

- The task line ("owner/repo#N title · workflow “…”") is its own full-width
  row under the title and the controls, clamped to three lines and wrapping
  anywhere; the full text stays in its `title`.
- The Canvas/List switch shows icons; the labels stay as `sr-only` text, so
  each button keeps its name.
- The content row is the only scroller: the canvas at `min(45dvh, 24rem)`
  (floor 16rem), then the list or overview at natural height. Selecting a step
  whose panel starts below the visible part of the column scrolls it into view.
- No footer until a step is selected.
- Full screen keeps the fill layout (canvas `flex-1`, overview in its own
  scroller); only the header and the missing footer hint differ.

Validation: `tests/workflowSheetPhone.test.tsx` (jsdom: header structure,
icon switch names, scroller classes, footer, scroll-into-view branch, Full
screen restores the fill classes); `tests/workflowSheetShort.test.tsx` and
`tests/workflowSheetCanvas.test.tsx` pass unmodified.

Browser check: headless Chromium (BB browser automation, `isMobile` +
`hasTouch`, DPR 2) on the actual components with the built `dist/app.css`,
fixture RPC data (a failed task titled
`cleanunicorn/bb-plugin-chief-of-staff#118 Workflow sheet header hides the task
name at phone width`, six steps, thread, issue and PR links; a second task with
14 steps), host icons replaced by placeholders and a simulated host theme. Not
a live BB install; the running plugin was not reinstalled.

| Viewport | Layout | Header | Canvas | Overview visible below canvas | Notes |
|---|---|---|---|---|---|
| 390×844 | phone | task line 3 lines at 332 px (repo, `#118`, full title); title 1 line | 380 px, controls and Full screen inside, 6/6 steps in view | 180 px of a 568 px column | aside has no inner scroller; scrolling the column reaches thread, issue and PR links; no footer until a step is selected |
| 360×640 | phone | 3 lines at 302 px; title 1 line | 288 px, 6/6 | 88 px of 384 px | |
| 320×568 | phone | 3 lines at 262 px; title 1 line | 256 px (floor), 6/6 | 55 px of 319 px | |
| 568×320 | phone | 2 lines; title 1 line | 256 px (floor) | 0: the canvas fills the 132 px column | deferred, see below |
| 844×390 | short | unchanged (#98) | 254 px, inside the dialog | side by side | footer inside the dialog |
| 740×360 | short | unchanged | 224 px, inside the dialog | side by side | footer inside the dialog |
| 1280×800 | wide | unchanged | 580 px | 26rem aside | |

Also at 390×844: after selecting Plan on the canvas, the step panel's top is
in view and "Run again from here" sits in the footer, outside the scroller;
its confirm dialog opens and Cancel returns focus to the button (no action
sent). In the 14-step List, tapping Step 5 or Step 14 while the panel is below
the fold scrolls the step heading into view. In Full screen the title stays on
one line, "Exit full screen" wraps under it without overlapping Close, the
canvas fills the space, the overview scrolls in its own box, and Escape leaves
full screen. No horizontal page overflow at any size.

Deferred: short viewports narrower than 640 px. On landscape phones such as
568×320 the 16rem canvas floor fills the whole scrolling column, so in Canvas
mode a touch drag pans the canvas instead of reaching the overview. This
predates #118: before it, the canvas overflowed the dialog there and the
overview was clipped (0 px visible). In List mode the column scrolls to the
overview (measured). Portrait heights below about 580 px leave less than 60 px
of overview below the canvas (55 px at 320×568), still reachable by touch. A
fix needs its own layout for short, narrow viewports.

## What changed, what needs you (issue #110)

What changed on the Pipeline tab:

- **Summary header**, under the Work overview row. It holds the former Needs
  attention row (same buttons, labels, `aria-pressed` and drill-downs, now a
  `role="group"` inside `section[aria-label="Summary"]`). Above it, with a
  baseline: "Since you were here (5h ago): 3 shipped · 1 failed (reason)".
  Only non-zero counts show; two or more failures are listed as "#N title —
  reason" (three at most, then "and N more"). A failure without a stored
  reason shows its outcome label ("Marked failed"); reasons are clipped to 80
  characters, whole in the tooltip. "Nothing waits on you" ends the line when
  nothing waits. "All clear — N agents working" needs the roster loaded,
  nothing waiting and no since counts (or none to load: a first visit, or
  `cos_since` failed, which `QueryErrors` reports). The shipped and failed
  counts turn Show finished on, clear the filter and focus the task list
  heading.
- **`cos_since`** (read-only RPC): done and failed counts with
  `COALESCE(finished_at, updated_at) > since`, and the newest three failures
  with outcome and reason. The reason rule is one helper, `endReason` in
  `src/outcome.ts`, used by the card and the RPC.
- **Skeletons** with `aria-busy` and an `sr-only` status replace "Loading…" in
  the summary, task grid, Throughput, Capacity and Activity. A panel whose
  first load failed shows none. The "Loading…" lines inside `WorkflowSheet`
  are out of scope (a sheet, not the tab).
- **Capacity** hides "All repos" with exactly one repository; the global cap
  stays in "Task slots".
- **Stage filters** are one sideways-scrolling row below `sm`, wrapping from
  `sm` up.
- **`j`/`k`** move between task cards (clamped), and focus the current card
  from outside the grid. They do nothing with a modifier, while composing,
  in `input, textarea, select, [contenteditable], [role=textbox]`, with a
  sheet open, or with any `[role=dialog]`, `[role=alertdialog]` or
  `[role=menu]` in the document (Radix unmounts closed ones). `/` is left out:
  #105, which adds the search field, is still open.

Baseline semantics (`components/cos/lastVisit.ts`): `localStorage
["cos.lastVisit"]` is when this browser last left the dashboard, written on
`pagehide`, on the page becoming hidden and when the Pipeline tab unmounts.
`sessionStorage["cos.visitBaseline"]` is this browser tab's baseline (`"none"`
on a first visit). Within a visit it is read back unchanged, so tab switches,
live refetches, StrictMode remounts and reloads keep the counts. A visit ends
when the dashboard was out of sight for 30 minutes: on mount, or when the page
becomes visible again, a stale `cos.lastVisit` starts a new visit from it.
This amends the plan, which kept the baseline for the browser tab's life; BB
stays open for days, so that baseline would never move. Storage that throws
reads as a first visit. Known limit: if the host keeps the panel mounted and
the page visible while you work elsewhere in BB, the visit continues until the
panel unmounts or the page is hidden.

Tests: `tests/since.test.ts` (counts on each side of `since` and at it, legacy
rows without a finish time, failure order and limit, reasons for a failed
thread, a closed PR, marked failed with and without the stored label, offsets,
empty), `tests/server.test.ts` (`cos_since` through the RPC, input validation,
nothing stored), `tests/lastVisit.test.tsx` (first visit, stored visit, reuse
within a visit, new visit after 30 minutes, invalid values, throwing and
unreachable storage, writes on `pagehide`/hidden/unmount, a new visit on
becoming visible), `tests/dashboardUi.test.tsx` (single and multiple
repository meters, the filter row classes, all clear with 0, 1 and 3 agents,
each attention kind, loading and failed roster, since counts, first visit,
the failure list, reason fallback and clipping, the links, counts kept across
a dashboard tab switch, a failed or loading `cos_since`, skeletons) and
`tests/pipelineKeyboard.test.tsx` (`j`/`k` from a card, any control and the
page, clamping, modifiers, the New task fields, an open menu, confirm dialog
and workflow sheet; guard tests assert the key was not claimed, since focus
traps would undo a move anyway). `npm run check` and `npm run build:ci` pass.

Browser check: headless Chromium (BB browser automation) on a static render of
the real `Dashboard` with the built `dist/app.css`, simulated host colour
tokens and reset, a stand-in SDK answering RPCs from fixture data (54 tasks:
4 or 5 active, 49 finished, one repository), and placeholder icons.

| Viewport | Scenario | Summary (top–bottom) | First card top | Filters | Page overflow |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | 3 shipped, 1 failed, 1 approval waiting | 119–175 px | 293 px | one 32 px row | 0 |
| 1440×900 | 7 shipped, 4 failed (3 listed), nothing waits | 119–211 px | 329 px | one 32 px row | 0 |
| 390×844 (touch) | 3 shipped, 1 failed, 1 approval waiting | 155–230 px | 348 px | one 32 px row, 791 px of chips scrolling in 358 px | 0 |
| 390×844 (touch) | 7 shipped, 4 failed (3 listed) | 155–266 px | 384 px | same | 0 |

At 390×844 the loading scenario showed skeletons with five busy regions
(summary, tasks, throughput, capacity, activity), pulsing, and no "Loading…"
text. All clear read "All clear — 4 agents working"; a first visit showed only
the Needs attention row. Capacity showed one meter, named after the repository.

Not checked: a live BB install (host navigation, icons, theme, and whether the
host unmounts or hides the panel when you open a thread, which decides when a
visit ends); dark theme; `j`/`k` and the links in a real browser (covered in
jsdom); reduced-motion rendering of the skeletons (`motion-safe:` only).
