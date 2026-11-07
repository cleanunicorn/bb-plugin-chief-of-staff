# Plan: user-defined workflows (typed steps, graph, canvas editor)

## Progress

Planning
- [x] Decide step model: 3 types (Agent, Check, Ship); review/approval are Agent options
- [x] Decide parallelism: parallel steps are read-only and share the task's worktree; code-writing steps run one at a time
- [x] Decide editor: React Flow canvas + the list editor side by side; no per-step cost/budget
- [x] Mirror this checklist into a GitHub epic issue (#6)

Implementation (one PR, milestones in order)
- [x] M1 Workflow schema: named workflows of typed steps + `next` edges + `onFail` back-jumps; validation (DAG, writers ordered, back-jumps to ancestors, check/ship after a writer); default workflow = Plan → Build → Review → Ship; conversion from the stage config (no deps)
- [x] M2 Graph engine (pure): per-step node state, ready-set scheduling, parallel agents, joins, loop-back reset of a step and its descendants, approval / verdict / question / nudge / escalation, per-step infra retry (needs M1)
- [x] M3 State: workflow snapshot + node states per item, `item_threads` (thread → item, step, agent index; per-thread prompt/idle/report bookkeeping); migrate in-flight items (needs M2)
- [x] M4 Runtime: prompts built from step instructions + predecessor reports + feedback; builder thread for writing steps, step threads for read-only steps (reuse the builder workspace when it exists); check/ship/merge jobs; CI; observer keyed by thread (needs M3)
- [x] M5 `cos_report` by step; roster, CLI, RPC, answer panel per step; repos choose a workflow by id (needs M4)
- [x] M6 Editor: list editor for steps; React Flow canvas (drag, connect, delete, auto-layout, fail-edges dashed); validation shown inline (needs M1)
- [x] M7 Live view: the item's workflow on the canvas, coloured by step status; roster stepper follows the graph (needs M5, M6)
- [x] M8 Tests (schema, engine table tests, e2e parallel plan → build → gate loop → ship), docs, changelog (needs all)

Before merge
- [x] Canvas editor checked in a headless browser (standalone preview): layout, parallel column, fail arrows, live colours, step panel, list view, connect and delete arrows
- [ ] Install the branch build and walk one real task through a custom workflow (not done here: the live BB has in-flight items)
- [ ] Open the PR, mirror final checkboxes to #6

Deferred
- [ ] Parallel code-writing steps in separate worktrees with a merge step
- [ ] Per-step provider/model

## Model

A repository runs one named **workflow**. A workflow is a list of **steps**; each step has
`id`, `name`, `type`, `instructions`, `next` (step ids that follow it) and type properties:

| Type | What runs | Properties |
| --- | --- | --- |
| Agent | An agent works on the step's instructions and reports done | `writes` (changes code: runs in the task's builder thread, one at a time; otherwise read-only, may run in parallel), `agents` (read-only: N agents in parallel), `approval` (a person approves the report or sends it back), `verdict` (the agent reports pass / fail; fail jumps to `onFail`), `onFail`, `maxRounds` |
| Check | Chief of Staff runs a command in the worktree | `command`, `timeoutMinutes`, `onFail`, `maxAttempts` |
| Ship | Push, open a PR, or merge when green | `action`, `draft`, `requireApproval`, `onFail` (CI red), `maxAttempts` |

Execution: a step starts when every step pointing at it is done; several ready steps start
together (parallel), a step with several inputs waits for all (join). A failing gate/check/ship
resets its `onFail` target and everything downstream of it and re-runs from there with the
failure as feedback, up to its limit, then asks a person. The task is done when every final step
is done. Each step's prompt carries the reports of the steps before it.
