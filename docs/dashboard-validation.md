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

## Workflow editor toolbar and Full screen (issue #121)

In the workflow editor (Configure → Workflows) the add-step toolbar is now an
in-flow, wrapping bar above the canvas at every width (`role="group"`, named
"Canvas tools"), and Full screen is its last button. Before, from `sm` up, the
toolbar floated over the canvas's top left and Full screen over its top right,
so they overlapped on a narrow canvas and the toolbar covered the first step
after Fit. The React Flow frame no longer contains the toolbar, so the opening
fit and "Fit all steps in view" frame only the area below the bar, and
`FIT_EDIT` is unchanged. The same bar is used in full screen, where it
floated before too, and on phones, where Full screen moves from the canvas's
top right into the bar. In full screen the bar has no Full screen button: the
way out is the "Exit full screen" bar, as before.

In the two-column layout (`xl`) the canvas is `self-start` and, on windows at
least 45rem (720 px) tall, `sticky top-3`, so it stays in view while the step
panel scrolls. The pinned canvas spans 12–532 px from the top of the page's
scroller. On a shorter window the configurator's Save bar (`sticky bottom-0`,
shown while there are unsaved edits) would cover its bottom strip, which holds
the zoom and Fit controls, so there the canvas scrolls with the page as before.
The read-only task sheet canvas keeps its floating Full screen button and is
unchanged.

Tests (jsdom has no layout, so they check structure): `tests/workflowCanvas.test.tsx`
checks that the editor has exactly one Full screen button, that it is the last
child of the toolbar group after the four Add buttons and Tidy, and that the
group is outside `.react-flow` with no `absolute` class. It also checks that
there is no Full screen button once expanded, and that the read-only canvas
keeps its own button with no toolbar. `tests/workflowEditor.test.tsx` checks
that the embedded canvas gets `xl:self-start` and `sticky`/`top-3` under the
`(min-width: 80rem) and (min-height: 45rem)` media variant, that no other
variant makes it sticky, and that none of them apply in full screen. The existing fit tests pass
unchanged.

Browser check: headless Chromium (Playwright 1.62 with the bundled headless
shell; BB browser automation kept losing its browser on this host). It ran the
actual `WorkflowsEditor` with the default workflow and the built
`dist/app.css`. The page is a fixture shell that mimics the plugin page: a
host-sidebar placeholder, a `[data-bb-plugin=chief-of-staff]` panel with
the `h-full overflow-auto` scroller, the `max-w-7xl p-4 md:p-6` column, header
and nav placeholders, and a `sticky bottom-0` Save bar. It used a simulated
host theme, a 16 px root with 14 px system-font body text, and placeholder
squares for host icons. It is not a live BB install, the running plugin was
not reinstalled, and nothing was saved.
Measured with `getBoundingClientRect`: on opening and after Fit, the toolbar
buttons' pairwise intersections, each step's top against the toolbar's
bottom, and steps inside the frame. Then, after selecting Review, scrolling
"On fail, go back to" to the bottom of the window and then scrolling the page
to its end, the canvas box against the window.

The fixture's panel stands in for the plugin page's width, so the editor is the
panel minus the page padding (48 px). The real page also has the
configurator's section list beside the editor from `lg` up, and that list is
not in the fixture. The canvas widths below cover the issue's range either
way.

| Window | Editor | Layout | Canvas | Toolbar rows | Overlaps | Steps under toolbar (open / Fit) | Canvas at page end |
|---|---|---|---|---|---|---|---|
| 1440×1000 | 847 (issue repro) | two-column | 451 px | 2 (Full screen wraps) | none | none / none | sticky, top 12, fully in view |
| 1440×1000 | 652 | two-column | 256 px | 2 | none | none / none | sticky, fully in view |
| 1280×1000 | 652 | two-column | 256 px | 2 | none | none / none | sticky, fully in view |
| 1440×1000 | 1232 | two-column | 836 px | 1 | none | none / none | sticky, fully in view |
| 1920×1000 | 1232 | two-column | 836 px | 1 | none | none / none | sticky, fully in view |
| 1440×720 | 847 | two-column | 451 px | 2 | none | none / none | sticky, y 12–532, clear of the Save bar (672–720) |
| 1440×719 | 847 | two-column | 451 px | 2 | none | none / none | not sticky (window under 45rem) |
| 1280×600 | 652 | two-column | 256 px | 2 | none | none / none | not sticky (window under 45rem) |
| 1279×1000 | 652 | stacked | 652 px | 1 | none | none / none | scrolled off (by design) |
| 1000×1000 | 952 | stacked | 952 px | 1 | none | none / none | scrolled off (by design) |
| 1200×900 | 952 | stacked | 952 px | 1 | none | none / none | scrolled off (by design) |

At every size every toolbar button lies inside the canvas box and Full screen
is the last button. With "On fail, go back to" at the bottom of a 1000 px
window, and again with the page scrolled to its end, the whole 520 px canvas
is visible in every two-column case at least 720 px tall.

The same script against the parent commit (`c59c5af`, built the same way)
reproduces the issue. In the issue's configuration (451 px canvas), Tidy
spans x 868–926 and Full screen x 916–1011, so they overlap. The issue
measured 890–955 and 911–1011. With a 256 px canvas, Full screen covers
Check and Ship, and the toolbar covers the Plan step both on opening and
after Fit. At the page end the canvas is not sticky and its top is 78 px off
screen.

No element between the page's scroller (`app.tsx`, `h-full overflow-auto`)
and the editor sets `overflow`, so nothing stops the canvas from sticking in
the live page. The wrappers are flex and gap only, plus the configurator's
`lg:flex-row lg:items-start` row.

Not met, by design: below `xl` the canvas and the step panel stack, and the
canvas still scrolls away while you edit the bottom of the panel. A sticky
canvas there would cover the panel. The same holds at `xl` on windows under
720 px tall, where a pinned canvas would sit under the Save bar. Criterion 3 was measured, and is met, in
the two-column layout.

Not checked: a live BB install (host fonts, icons, the configurator's section
list, and the real header heights), touch, and dark theme. Also not checked:
the compact configurator in BB's settings page (`<Configurator compact />`).
There the page's scroller belongs to the host, and the media variant follows
the window, so the canvas also sticks there, 12 px below the top of the
host's scroller, and may sit under a sticky host header if there is one. The fixture's step
panel for Review is about 990 px tall, against about 1,400 px in the live
report. The canvas stuck at the page end anyway, so a taller panel only
scrolls further under it.

## Configure problems listed once (issue #123)

A workflow draft's problems are listed once, in the Workflows editor; the save
bar keeps only the count.

- The editor's list shows the open workflow's problems without the
  `Workflow "<name>":` prefix, starting with the step they are about, then one
  `<name> · N to fix` row per other workflow with problems. Three lines show,
  then "Show all N".
- Graph problems now carry their step (a pair that could run at once: the
  later step in the list, usually the one just added; a duplicate id: the
  second step; a loop: none), so every line about a step selects it. The
  canvas pans to the step if it is out of view, and its panel opens with focus
  on its heading; in list view that step expands.
- Steps with problems have a critical border and a count badge on the canvas,
  "N to fix" in their accessible name, and an "N to fix" pill while collapsed
  in list view.
- The save bar is one row: "Unsaved changes · N to fix before saving" (below
  `sm`, "N to fix"), Show/Hide, Discard, Save. Expanded, it lists section
  summaries for what is not on screen (`Workflows · N to fix`,
  `Repositories · acme/app · N to fix`, `General · N to fix`), at most about
  three rows before scrolling. With nothing off screen, Show scrolls to the
  section's own list or first invalid field.

Validation: `tests/workflow.test.ts` (step of each graph problem),
`tests/workflowEditor.test.tsx` (no prefix, step selection on the canvas and
in list view, other-workflow row, three lines then Show all),
`tests/workflowCanvas.test.tsx` (marks, accessible name, a selection made with
a new workflow is kept, the in-view check behind panning),
`tests/configurator.test.tsx` (collapsed bar without problem text, Show, the
on-screen section left out, opening a repository, selecting a step from
General, a revealed step not selected again on returning).

Browser check: headless Chromium (Playwright 1.62, Chromium build 1234; BB
browser automation sessions failed to start on this host) on the actual
`Configurator` with the built `dist/app.css` under a
`data-bb-plugin="chief-of-staff"` root, fixture RPC data (the default workflow,
one repository), placeholder icons and a minimal host preflight. Not a live BB
install; the running plugin was not reinstalled. Repro: Workflows → toolbar
**Check**, unsaved. The default workflow gives 3 problems (the issue's
workflow gave 5); a second Check gives 4 lines and "Show all 4".

| Viewport | Section | Save bar | Editor list | Canvas visible | Notes |
|---|---|---|---|---|---|
| 390×844 | Workflows | 48 px, one row ("3 to fix · Show · Discard · Save") | 88 px, 3 lines | 263 px of 484 px above the bar | was 496 px bar, no canvas in view |
| 390×844 | Workflows, 2 Checks | 48 px | 108 px, 3 lines + "Show all 4" | 243 px | |
| 390×844 | Workflows, a Check and a Ship (7 to fix) | 48 px | 92 px, 3 lines + "Show all 7" | 259 px | |
| 390×844 | General, same draft | 48 px; expanded 75 px with `Workflows · 3 to fix` | n/a | n/a | General row absent (on screen) |
| 390×844 | `Workflows · 3 to fix` from General | 48 px | | | New check selected, its panel heading focused and scrolled to the top |
| 1440×1000 | Workflows | 48 px, one row | 56 px, 3 lines | 520 px, all of it | New check panned into view, red border and badge "3" |
| 1440×1000 | General, same draft | 48 px; expanded 75 px | n/a | n/a | |

At 1440×1000 a step added from the toolbar below the fitted view is panned to
(its top 233 px into the 520 px canvas). After a step is opened from a problem
line, clicking a step only partly inside the canvas (Review, at 1440×1000 and
at 390×844) selects it and leaves the pan and zoom as they were. No horizontal
page overflow at either size, and no error text in the bar in any state. Not checked: a screen reader, Safari, a live BB install.
