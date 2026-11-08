# Dashboard visual recognition review

User request: retain the cleaner layout and use more icons/images to make the
information easier to parse. The user also invoked review-ux-psychology.

## Review scope and metric

Scope: PipelineTab → attention filters → AgentCard → task actions, with the
activity feed and historical panels as secondary context. Main branch resolves
to origin/main. The working tree was clean at review start.

Working metric: reduce time to correctly identify a task needing attention,
without increasing selection/action errors. This was the recommended default
in an optional metric question; no preference was supplied before implementation.
No timing or conversion improvement has been measured.

Six independent read-only lens reviews returned no supported findings:

| Lens | Result |
| --- | --- |
| Decision fatigue / defaults | Current overview default and count-bearing attention filters are reasonable and reversible. |
| Goal gradient | Real completed/total step counts already exist. Unequal, parallel, retried steps cannot honestly imply time-to-finish percentage. |
| Reciprocity | No signup, payment, or result-withholding gate in this flow. |
| Endowment / IKEA | No commitment boundary discards the user's configuration or artifacts. |
| Loss aversion | No supported hidden loss or urgency to introduce. |
| Anchoring / contrast | Cost is secondary telemetry; no meaningful budget/reference price exists to anchor it against. |

Critical: 0. Important: 0. Refinements: 0. Verification candidates: 0;
filtered-out findings: 0. With no candidates, a separate verification pass was
unnecessary. These results do not mean the UI cannot be visually improved;
this skill's behavioral lenses do not establish iconographic design quality.

## Visual changes requested by the user

- Larger state pictograms pair with existing explicit status labels. Active,
  waiting, stalled, failed and completed states retain existing semantics.
- Repository and metric icons provide scan landmarks; the common task-card
  renderer applies them consistently across issue-backed and standalone tasks.
- A small step-state strip shows recorded done/running/waiting/retrying/pending
  states with different shapes, as well as colors. It is not a percentage or an
  elapsed-time estimate. More than twelve steps show a remaining-count marker;
  the existing expanded workflow still exposes every step.
- A local SVG queue illustration accompanies the empty active roster. It follows
  theme tokens and makes no external image requests.

These are local presentation changes, not structural product decisions or
psychology findings. No new urgency, default filter, hidden action, or generated
progress was introduced. Pattern scope: one shared task-card renderer, its four
metric labels, one workflow summary, and one active-roster empty state; all
instances in that scope updated. Other flows were not changed.

## Validation

- 132 tests pass across 16 files; typecheck, build, and diff whitespace check pass.
- Browser fixtures inspected at 1280 px and 390 px, including attention-required
  and empty-roster states. The narrow fixture has no horizontal page overflow.
- Fixtures render the real components and built CSS with representative SVG
  stand-ins for host icons and simulated RPC/theme data. The production UI uses
  the existing host Icon wrapper. This is not a live installed-plugin check.
- The earlier preview omitted icons entirely; it is not evidence that the real
  dashboard lacked icons. New preview fixtures include representative glyphs.

Suggested measurement: ask operators to identify and open an attention-needed
item in comparable mixed-status rosters. Compare median time and wrong-task
selections before and after, keeping task count and content comparable.
