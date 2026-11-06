# Plan: configurable delivery pipeline (Plan → Build → Verify → Review → Ship)

## Progress

Planning
- [x] Read current machine / sync / delivery / intake and the live activity log
- [x] Diagnose why the plugin loses track of agents (see "Tracking failures")
- [x] Draft pipeline model, config shape, stage protocol
- [x] Confirm open decisions: review supports both `agent` and `self` (default `agent`); plan gate on by default; global workflow + per-repo overrides
- [x] Mirror this checklist into a GitHub epic issue (#4)

Implementation (one PR, milestones in order)
- [x] M1 Tracking core: per-item lock, detached jobs with timeouts, infra-error retry, richer thread snapshot (no deps)
- [x] M2 Workflow config: global `workflow` setting + per-repo per-stage overrides, `checkCommand` stays the verify fallback, `maxFixRetries` replaced by per-stage budgets (no deps)
- [x] M3 Stage report protocol: `cos_report` agent tool + text fallback + idle nudge (needs M1)
- [x] M4 Stage machine: plan → build → verify → review → ship, skip disabled stages, loop-backs with budgets (needs M2, M3)
- [x] M5 Stage runners: plan approval gate, verify (command + agent), review (reviewer thread / self), ship (push / PR / merge) (needs M4)
- [x] M6 Ad-hoc tasks: start an item from a typed description, not only a GitHub issue (needs M4)
- [x] M7 Dashboard: stage stepper per item, "who is acting" (agent / CoS / you), plan-approval + review UI in the answer panel; Workflow editor in Configure (needs M2, M4)
- [x] M8 Migrate in-flight items, tests (machine table tests, sync races, migration), README / SKILL / CHANGELOG under Unreleased; version bump left to release (needs all)

Before merge
- [ ] Install the branch build on a BB instance and walk one real issue through every stage (not done: the live instance has in-flight canary items)
- [ ] Open the PR, mirror final checkboxes to #4

Deferred
- [ ] Per-stage provider/model (e.g. cheaper model for review)
- [ ] Human review via GitHub PR approval as a gate before merge

## Tracking failures (evidence from the 2026-11-06 activity log)

1. **Races.** `thread.idle` arrives via the event *and* the per-minute sync; both
   dispatch `thread_idle`. Log shows `running → checking` twice within seconds and
   two concurrent check runs, both dying with "host plugin call exceeded its deadline".
2. **Black-hole state.** `checking` has no timeout and is only re-run at startup.
   #753 sits in `checking` with an idle thread indefinitely.
3. **Infra errors are reported as "needs you".** Any effect error moves the item to
   `waiting_on_human`, so host timeouts look like agent questions.
4. **Sweep blocked.** Checks (up to 28 min) run inline inside event handlers and the
   sweep; `running` guard skips all monitoring meanwhile.
5. **Weak signals.** Only `thread.status` is read. `runtime.displayStatus`
   (`provisioning`, `waiting-for-host`, `stopping`), `hasPendingInteraction` and
   `queuedWork` are ignored, and "finished vs asking" is guessed from a trailing `?`.
6. **No next step.** After the agent's one turn, CoS runs checks and opens a PR; there
   is no notion of stages, so nothing pushes the agent from "coded" to "verified" to
   "reviewed".

## Pipeline model

Define is done upstream (GitHub issue or a typed task). Each work item has a
`stage` and, within it, an `actor` that tells you who holds the ball:

| actor     | meaning                                                   |
|-----------|-----------------------------------------------------------|
| `agent`   | a turn is running in the agent's thread                   |
| `cos`     | CoS is doing deterministic work (checks, push, PR, CI)    |
| `human`   | waiting on you: question, approval, plan sign-off, escalation |
| `system`  | CoS hit an infra error; retrying with backoff (not your problem yet) |

Stages, each with `enabled` + free-text `instructions`:

- **plan**: agent investigates and writes a plan, no code changes. Optional
  `requireApproval` puts the plan in front of you (Approve / Request changes).
- **build**: always on. Agent implements (with the approved plan), commits.
- **verify**: CoS runs `command` (if set) in the worktree, detached with timeout;
  agent verification with the instructions (e.g. "run the app, exercise the flow,
  attach evidence") if instructions are set. Failure → back to build with the log,
  `maxAttempts` then escalate.
- **review**: `mode: "agent"` spawns a fresh reviewer thread on the branch (not
  anchored on the builder's reasoning) or `mode: "self"` asks the builder thread.
  Changes requested → back to build → verify → review, `maxRounds` then escalate.
- **ship**: `action: "push" | "pr" | "merge"`. `pr` pushes, opens the PR and
  watches CI (CI red → back to build, bounded). `merge` also merges when green
  (needs `allow.merge`). Instructions are given to the agent writing the PR
  description / release notes.

Disabled stages are skipped. Loop-backs keep one shared fix budget per item so a
task can't bounce forever.

## Stage report protocol (how CoS knows where the agent is)

Every stage prompt ends with: "When you finish this stage, call the
`cos_report` tool". `cos_report({ stage, outcome: "done" | "needs_input" |
"blocked", summary, question? , findings? })` is a plugin agent tool; the call's
`ctx.threadId` maps to the work item, so the signal is explicit and structured.

Fallback for providers without plugin tools: a final `## Stage report` block
with `stage:` / `outcome:` lines, parsed on idle.

Thread goes idle with neither → CoS sends one short nudge ("you stopped without
reporting the build stage; report done or ask your question") up to 2 times, then
escalates to you with the last message. Open interactions still win (they mean
"waiting on human" regardless).

## Config shape (global `workflow` setting; repos override per stage)

```json
"workflow": {
  "plan":   { "enabled": true,  "instructions": "", "requireApproval": true },
  "build":  { "instructions": "" },
  "verify": { "enabled": true,  "instructions": "", "command": "npm test", "timeoutMinutes": 30, "maxAttempts": 2 },
  "review": { "enabled": true,  "instructions": "", "mode": "agent", "maxRounds": 2 },
  "ship":   { "enabled": true,  "instructions": "", "action": "pr" }
}
```

A repo's `workflow` holds partial stage objects that are merged over the global
default field by field (`{"review": {"enabled": false}}` turns review off for that repo only).

Migration: a repo without a `workflow` override and with a legacy `checkCommand` gets plan off, verify on with
`command = checkCommand`, `maxAttempts = maxFixRetries`, review off,
ship `pr` if `allow.openPr` else `push`: today's behavior, unchanged.

## Engineering notes

- `work_items` gains `stage`, `actor`, `stage_attempts` (JSON), `plan_text`,
  `review_thread_id`, `job_started_at`, `nudges`. Old `status` stays for
  roster compatibility and is derived.
- Per-item async mutex around every dispatch; events and sync become idempotent.
- Jobs (verify command, push, PR) run detached from handlers; sweep fails a job
  past its timeout and retries infra errors with backoff before escalating.
- Sweep reads all tracked threads with one `threads.list` call and uses
  `runtime.displayStatus`, `hasPendingInteraction`, `queuedWork`.
- Machine stays pure; table-driven tests cover every stage × event.
