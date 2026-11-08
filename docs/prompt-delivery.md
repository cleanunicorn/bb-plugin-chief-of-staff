# Prompt delivery and recovery

Chief of Staff records a unique delivery attempt on the workflow node before
calling BB. Each attempt belongs to one step round and agent, and carries its
thread ID when known. The prompt and spawn metadata carry the same identity.
The record lives in the existing persisted node JSON; old items require no
schema migration.

The pinned SDK (0.6.104) returns `sent` or `queued` from `threads.send`, and a
thread from `threads.spawn`. A successful response establishes acceptance;
later logging, issue-comment, or other bookkeeping errors cannot schedule a
resend. Queue acceptance does not establish pickup. While an attempt remains
queued, an earlier turn's activity or idle cannot consume it or trigger a nudge.
A thread that remains active is not stalled merely because its timestamp is old.

A rejected SDK invocation is ambiguous: it may have delivered the prompt before
losing its response. Chief of Staff checks queue content and prompt history for
the exact attempt marker. For a spawn with no returned thread ID, it first looks
for matching plugin metadata among the project's latest 200 plugin threads.
History inspection is bounded to 100 prompts. Missing evidence or an unavailable
observation API is **unknown**, not proof of non-delivery. Such attempts pause
automatic resends, with an explicit reason, and are reconciled on later sweeps.
Failures before invoking the SDK retain the existing retry/backoff behavior.

Each agent has an independent persisted retry record. A prompt-delivery wait
belongs to its agent; it does not prevent another agent's due preflight retry
from running. Resolving that wait preserves the other retry's count, deadline,
and effect. The original node-level retry remains a representative record for
existing UI and legacy state.

Preparation also records its intended effect before asynchronous work begins.
The sweep checks preparing attempts under the same item lock held throughout
live preparation. A preparing attempt still present once that lock is acquired,
without a scheduled or blocked retry, was interrupted before BB invocation and
can safely enter retry backoff. This also recovers interruption during a retry;
it preserves the nudge/start effect and retry budget. Unknown delivery after BB
invocation continues to require evidence and is never handled as preparation.

Agents should include the prompt's `attempt` in `cos_report`, or as an `attempt:`
field before `summary:` in a text Step report. This lets a report establish
receipt even while delivery is unknown. Reports are validated and stored under
the item lock; the workflow still advances only when the turn ends. Recovery
clears only the matching agent's prompt retry, never an unrelated job failure,
approval, replacement-thread wait, or another agent's outstanding retry. Legacy
items without attempt records can recover prompt-send waits through their
current thread and round. They cannot offer the same per-attempt proof as new
prompts. No SDK idempotency key or exactly-once guarantee is assumed.

The regression tests inject a delivered-then-rejected `TypeError` and post-send
bookkeeping errors. They reproduce the failure boundary reported in issue #24;
they do not identify the original provider's undefined `.length` access. Live
provider reproduction and production log inspection were not part of this fix.
