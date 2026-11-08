## Progress

- [x] 1. Finish PR-only shipping at the configured boundary.
- [x] 2. Release concurrency capacity while merge shipping waits externally.
- [x] 3. Admit resumed agent work through the same capacity gate as new work.
- [x] 4. Make completion modes and capacity visible in configuration and the roster.
- [x] 5. Reconcile existing shipping items safely on restart.
- [x] 6. Verify both delivery paths and document the behavior.

## Problem and intended behavior

Shipping must have a configurable completion boundary. Opening a PR can finish one workflow; another workflow must open the PR and merge it before finishing. Human review remains a valid gate, but waiting for it must not occupy capacity that prevents other tasks from starting. After the configured boundary is reached, finalize the workflow and allow subsequent work to proceed.

No separate Define output exists for this request. This problem statement and scope capture the user's requirements for implementation.

The repository already exposes Ship `action: push | pr | merge`, plus `requireApproval` for merge mode. Reuse those settings. Currently `pr_opened` always enters CI watching, `ci_passing` leaves PR-only shipping in `ready`, and only `pr_merged` completes it. `countActive` / `countActiveAll` count every unfinished item, so waiting PRs block intake. The dashboard also labels unfinished items as active agents.

Completion contract:

| Ship action | Completion boundary | External waiting |
| --- | --- | --- |
| `push` | Branch push succeeds | Existing behavior |
| `pr` | PR is successfully created or an existing open PR for the branch is confirmed | Workflow finishes; later review, CI and merge belong to the PR owner |
| `merge` | GitHub confirms the PR merged | Keep watching CI and approval without occupying an execution slot |

`requireApproval` stays configurable and retains its existing default. Merge mode never bypasses approval or GitHub protections. PR-only mode deliberately stops automatic CI repair once its completion boundary is reached. Existing active workflows keep their stored settings; do not silently change PR-only items into merge mode.

## Ordered implementation tasks

### 1. Finish PR-only shipping at the configured boundary

Scope: update `src/machine.ts` to complete the ship node on `pr_opened` for `action: pr`; retain CI/merge progression for `action: merge`. Persist the PR reference before completing. Continue scheduling configured successor steps normally; mark the whole item done only when all final steps finish.

Acceptance: new and reused open PRs both complete PR-only shipping; failed PR creation does not complete it; push behavior is preserved; merge shipping remains unfinished until a confirmed merge. Duplicate events do not send repeated completion notifications. Terminal PR-only items cannot later be revived by CI polling.

Verification: table tests in `tests/machine.test.ts` cover each action, duplicate events, and a ship step with a successor. Server tests verify successful PR reuse and creation, failure, persisted URL and final timestamp.

Dependencies: none.

### 2. Release capacity while merge shipping waits externally

Scope: separate tracked unfinished work from capacity consumption in `src/state.ts`, `src/intake.ts` and runtime admission. Retain active tracking and duplicate-issue protection. A task waiting only on ship CI, review/merge eligibility or a ship human decision consumes zero execution slots; a task with another executing branch still consumes its existing task slot. Preserve the current per-work-item concurrency unit and other steps' capacity behavior.

Acceptance: with repo and global limits set to one, task B starts while task A waits for CI, an approving review, or a ship decision. A remains visible, is still polled and cannot be picked up twice. A merge success finishes A and releases all remaining reservations. Detached shipping work never leaves an idle agent turn running to poll GitHub.

Verification: store and server tests exercise each wait state, mixed parallel branches, duplicate intake, blocked merge attempts and review approval followed by merge. Assert both repo and global capacity values.

Dependencies: task 1.

### 3. Reacquire capacity before resuming agent work

Scope: gate every transition from a released shipping wait into agent execution, including CI loop-backs, operator retries/reruns and ship successors. Persist a visible queue when capacity is full. Centralize admission with new intake and ad-hoc startup so concurrent callbacks cannot reserve the same slot. Service queued resumptions deterministically before fresh intake; release reservations on failures and terminal transitions. Preserve the explicit existing force-start override.

Acceptance: when A's CI fails while B occupies the sole slot, A's repair stays queued without starting an agent. Once B releases capacity, A resumes once with CI feedback. Operator actions, repeated polls, retries and concurrent intake do not bypass the gate or create duplicate prompts. Repo and global limits both hold.

Verification: integration tests with limits of one, controlled concurrent dispatches, repeated CI events, manual rerun, and capacity release; assert thread/prompt counts and queued-to-running transitions. Include a shipping successor that needs an agent.

Dependencies: task 2.

### 4. Expose completion modes and accurate capacity

Scope: update `components/cos/workflowEditor.tsx`, workflow summaries, roster/RPC data and `app.tsx`. Label PR mode as finishing when the PR opens and merge mode as finishing after merge. Explain approval waiting, show waiting PRs separately from occupied capacity, and remove the implication that every unfinished task is an active agent. Keep the existing action schema and workflow selection model.

Acceptance: saved/reloaded workflows preserve the chosen action and approval setting. The roster distinguishes completed PR-only delivery, merge waiting, and repair queued for capacity. Global and repo slot meters agree with admission; completed PR-only work remains accessible with its PR link. Completion counts no longer claim every done item was merged.

Verification: configuration round-trip tests and RPC assertions; browser check of both modes, slot meters, waiting/queued states and completion display at narrow and wide widths.

Dependencies: tasks 1–3.

### 5. Reconcile existing items safely

Scope: extend startup/sweep reconciliation to apply the completion contract to stored PR-only items still waiting in CI/ready and recompute capacity without losing tracking. Validate the stored PR is still open or merged before marking delivery complete; closed-unmerged PRs retain an explicit unsuccessful-delivery explanation. Preserve merge items and pending human decisions, and restore queued resumptions after restart.

Acceptance: an existing PR-only item with a confirmed open PR completes once; merge-mode review waits survive restart without consuming capacity. No duplicate PR, merge request, agent prompt or completion notification results from reconciliation. New configuration edits do not rewrite stored workflow snapshots.

Verification: restart fixtures for legacy-converted and current items: PR-only CI/ready, merge approval wait, closed-unmerged PR, temporary GitHub error and queued repair. On an unavailable GitHub response leave completion unconfirmed and retry.

Dependencies: tasks 1–3.

### 6. Validate and document the complete paths

Scope: expand `tests/server.test.ts` to exercise the complete delivery and scheduling behavior, then update README, the Chief of Staff skill and CHANGELOG with completion boundaries and the changed meaning of PR-only delivery. Document switching a workflow to merge mode when merged delivery is required.

Acceptance: two tasks progress under limits of one in both modes. PR-only A finishes with an open PR and B starts; merge A releases its slot while awaiting review, B starts, and A finishes after approved green merge. CI failure queues repairs safely. Approval refusal, red CI and merge API rejection never produce a successful merge outcome. Required validation passes.

Verification: run `npm test`, `npm run typecheck` and `npm run build`; record browser verification from task 4. Tests must assert final status, finishedAt, PR links, occupied slots and actual merge calls, not only notifications.

Dependencies: tasks 4–5.

## Scope boundaries

No manager hierarchy or assignment batching (#11), no new shipping agent, no change to the concurrency unit, no blanket change to non-shipping human gates, and no live configuration mutation as part of this planning task. Implementation should reuse the current detached jobs, CI watcher and workflow snapshots.

## Issue review before build

- Important: capacity release requires durable admission for CI loop-backs and ship successors. Persist the deferred engine event, keep the item visible as queued, and replay it through the same synchronous capacity check used by startup. Avoid holding an agent turn to wait.
- Clarification: keep per-task concurrency reservations; do not silently redefine limits as individual thread counts. Detached merge requests can run while other tasks occupy agent capacity.

## Implementation and review results

All six implementation tasks are complete. The action schema and approval defaults are preserved. Shipping waits release per-task reservations; deferred engine events persist in SQLite and resume through synchronous admission, including after restart. Terminal PR-only items stop CI ownership. Merge confirmation schedules successor steps rather than skipping them.

Review findings (all fixed):

- 🔴 Critical — `src/state.ts`, migration ordering: inserting the queued-event column before an existing migration broke upgrades with recorded statement hashes. Appended it instead; a regression starts with all previous migrations applied and verifies upgrade succeeds.
- 🟡 Important — `src/intake.ts`, dry-run intake: queue draining could resume repairs during a dry run. Skip draining for dry runs; regression asserts the queued event and prompt count are unchanged.
- 🟡 Important — `src/machine.ts` / `src/delivery.ts`, merge successors: the former merge handler completed successor steps without running them, and continued polling could clear successor job bookkeeping. Complete only delivery and its prerequisites; stop watching after shipping finishes. Tests cover a queued successor, normal execution and no subsequent PR polling.
- 🟢 Nice-to-have — configuration and roster labels: use task capacity consistently, identify queued CI repairs, explain PR-only completion and hide CI-repair options for modes that do not watch CI. Removed obsolete active-count methods to keep admission and display on one capacity definition.

Validation: 102 tests pass; `npm run typecheck`, `npm run build` and `git diff --check` pass. Coverage includes concurrent repairs, global and repo limits, manual rerun admission, persisted queues, PR-only handoff, approval waits through reload, approved merge while another task runs, red CI, changes requested, merge rejection, PR creation failure, legacy/current stored items and unavailable GitHub responses.

Browser check: actual StepPanel controls in a standalone React preview, at wide and 390px widths, with generated plugin CSS and stubbed host icons. PR mode explains the handoff and hides CI repair controls; merge mode shows the approval gate and repair controls. Mode changes preserve approval, and no page-width overflow was detected. Proof images were inspected and saved in thread storage. Dashboard capacity is verified through RPC/runtime assertions and type checking; a live installation or a real production merge was not performed.

Build note: BB reports installed SDK 0.6.132 versus the repository's pinned 0.6.104. The build succeeds with the existing pin; no SDK upgrade is part of this change.
