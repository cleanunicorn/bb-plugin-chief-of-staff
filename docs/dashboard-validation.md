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
