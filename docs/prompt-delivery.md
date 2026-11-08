# Prompt delivery and report recovery

Issue #24 exposed two independent failure modes. Persisted workflow snapshots
written before model choices existed can omit `chooses`; applying the step
schema at the storage boundary supplies that and other additive defaults. This
reproduces a `.length` exception, but does not prove the cause of the reported
production incident.

The delivery boundary now distinguishes:

- Preparation: no transport call has begun; failures use bounded backoff.
- Sending: a per-agent attempt is persisted immediately before the SDK call.
- Accepted: SDK success is persisted before logs, GitHub comments, branch
  discovery, and other bookkeeping. Failures in those operations cannot cause
  another prompt or park the agent.
- Uncertain: transport threw, or restart found an interrupted send. Automatic
  resend is disabled. A busy thread or an attempt timestamp is not acceptance.

The pinned SDK 0.6.104 declares successful `threads.send` responses as `sent`
or `queued`, both with `ok: true`. Its public contract supplies no idempotency
key or guarantee that a rejected send/spawn promise delivered nothing. Both
success variants therefore count as accepted; thrown calls remain uncertain.
This plugin cannot make an SDK call atomic with its SQLite writes.

Each prompt includes a delivery id for tool and text reports. A matching report
can acknowledge an uncertain attempt under the item lock; step, agent, thread,
and round must agree. Later rounds require the token even after acceptance.
Legacy rows retain round validation and may recover only agent-delivery
`cos_error` waits. Approval and unrelated error waits do not become reportable.
Reports still pass through the usual verdict, model-choice and approval logic
on idle. One agent cannot clear another agent's retry or discard its report.

Lost spawn responses can be associated with threads using exact plugin-owned
metadata (item, step, agent, round, delivery id). Metadata identifies the thread;
it does not prove prompt acceptance. Recovery still requires its matching
report. Idle events and the report tool attempt association directly; the sweep
also searches up to 200 visible/hidden threads when an unresolved spawn exists.
If discovery or evidence is unavailable, the item remains uncertain. An operator
may inspect the thread and explicitly retry; startup does not blindly retry old
agent delivery errors whose acceptance was never recorded.

Regression coverage lives in `tests/server.test.ts` and `tests/machine.test.ts`:
legacy workflow reload, post-send exceptions, lost send/spawn responses,
interrupted delivery, queued work after long silence, tool/text recovery,
old-round rejection, ordinary approval/error guards, sibling agents, four-item
isolation, and bounded preparation retries.
