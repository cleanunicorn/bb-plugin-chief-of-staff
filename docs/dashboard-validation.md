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
