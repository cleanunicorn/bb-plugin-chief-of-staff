// A roster entry for UI tests: an agent working on "Fix login" in acme/app.
import type { RosterEntry } from "../../src/roster";

export function entry(extra: Partial<RosterEntry> = {}): RosterEntry {
  return { id: "one", detail: "agent", status: "running", actor: "agent", occupiesCapacity: true, workflowName: "Delivery", steps: [], current: ["Build"], activity: "Build: agent working", waitingKind: null, repo: "acme/app", issueNumber: 1, issueUrl: "https://github.com/acme/app/issues/1", issueTitle: "Fix login", threadId: "thread-1", threadStatus: "working", threadTitle: "Build", branch: null, prNumber: null, prUrl: null, pr: null, startedAt: new Date().toISOString(), lastActivityAt: null, stalled: false, fixAttempts: 0, retryCount: 0, lastError: null, waitingReason: null, providerId: null, model: null, source: "task", usage: null, ...extra };
}
