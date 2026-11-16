# Already-resolved issues finish on their own

## Progress

- [x] Trace why an already-fixed issue blocks a task (Theralexis/canary#929)
- [x] Decide the layer: the engine, for every workflow, not a "check first" workflow
- [x] Decide the issue policy: verified ⇒ Chief of Staff closes the issue and comments with the evidence
- [x] M1 `resolved` step outcome: report tool, text report, prompt contract
- [x] M2 Engine: a `resolve` effect verifies the evidence; verified ⇒ the task ends "Already resolved"; not verified ⇒ escalation (depends on M1)
- [x] M3 Delivery: verify on GitHub (merged PR into the default branch, or commit on it), close the issue, then comment (depends on M2)
- [x] M4 Outcome "Already resolved" on the dashboard and roster (depends on M2)
- [x] M5 A dead thread's late failure no longer parks the step its replacement works on (independent)
- [x] M6 The global default model applies only with the global default provider (independent)
- [x] M7 Tests, typecheck, lint, docs (README, skill, CHANGELOG)
- [x] M8 Review fixes: the approval gate holds the close; default branch cached per repo; `NodePhase`; nudge and template prompts
- [ ] Commit and open one PR
- [ ] Deferred: when GitHub's own `Closes #N` already closed the issue, intake never sees it; nothing to do
- [ ] Deferred: scan merged PRs at intake for unlinked fixes (no reliable signal: #920 never named #929)

## What happened to canary#929

| Time (UTC) | Event |
| --- | --- |
| 08:55 | Intake starts the task. The repo sets `providerId: codex` but no model, so the global default model "Opus" is sent to Codex. The Plan thread fails at once. |
| 09:38 | PR #920, which does fix the issue, merges. It never mentions #929, so GitHub leaves the issue open. |
| 10:07 | Retry spawns a new Plan thread. The sweep sees the old, dead thread (same step, agent and round) and reports `thread_failed` again: the step is parked while the new agent works. |
| 10:09 | The new agent finds #920 fixed it and reports. Chief of Staff rejects the report: "Plan is not running (it is waiting)". |
| 11:01 | Closed and marked done by hand. |

Three gaps, each fixed here:

1. No way for an agent to say "this is already done on the default branch". It can report done (the workflow then builds nothing and Ship refuses an empty branch), failed or needs_input: each needs a person.
2. A replaced thread's failure is not told apart from the live thread's (`observeFailure` checks the round, which a retry keeps).
3. `resolveAgent` falls back field by field, pairing a repo's provider with the global model.

## Design

**Outcome `resolved`.** Any agent step may report it, with `resolvedPr` (preferred: squash merges orphan branch SHAs) or `resolvedCommit`. The agent is told to judge against `origin/<default branch>` after a fetch, since its worktree may be older than the fix.

**Chief of Staff checks the evidence, not just the agent's word.** It proves the change landed on the default branch, not that it fixes the issue (the agent's judgement). The step's node stays running and a `resolve` effect checks on GitHub. Phase `closing` (no approval gate) verifies and closes; phase `resolving` (the step has an approval gate) only verifies, then the step waits for approval, and Approve moves it to `closing` (verified again, then closed) while Revise sends the agent back. It runs inside the dispatch that asked for it (a few requests, under the item lock), so it never takes the job slot or touches `jobStartedAt`, which a check running in parallel owns. Errors go through `effect_error` (backoff retries, then a person); a restart that cuts it off is picked up by the sweep (`resume_resolve`). It checks:

- PR: merged, and its base is the default branch.
- Commit: `compare/<default>...<sha>` has `ahead_by` 0 (the commit is in the default branch).
- The task has no open pull request of its own (work in flight is not discarded).

Verified: Chief of Staff closes the issue (`state_reason: completed`), then comments the evidence (when `issueComments` is on); an issue already closed is left alone. The task then ends: every step that ran is done with "Already resolved by …", steps that never ran stay pending (as Mark done leaves them), `lastError` holds the marker and the outcome reads "Already resolved". A refused close (403/404/410) does not undo the verified result; it is logged and shown in the step's journal.

Not verified: the step waits on a person (escalation) with the reason. Approve continues the workflow as if the step were done; Revise sends the agent back.
