import type { LogEntry } from "../../src/state";

/** Presentation only: raw messages remain available for diagnosis. */
export function activitySummary(entry: Pick<LogEntry, "kind" | "message">): string {
  const { kind, message } = entry;
  if (kind === "transition") {
    const changes = message.replace(/ \([a-z_]+\)$/, "").split("; ");
    const steps = changes.flatMap((change) => {
      const match = change.match(/^(.+): (pending|running|waiting|done) → (pending|running|waiting|done)( \(again\))?$/);
      if (!match) return [];
      const [, name, before, after, again] = match;
      const action = again ? "restarted" : after === "done" ? "completed" : after === "waiting" ? "is waiting" : after === "pending" ? "reset to pending" : before === "waiting" ? "resumed" : "started";
      return [`${name} ${action}`];
    });
    // Do not infer approval from a completed step or an agent report.
    return steps.length ? steps.join("; ") : "Workflow state updated";
  }
  if (kind === "spawn") {
    const builder = message.match(/^spawned builder \S+ for (.+) \([^)]*\)$/);
    if (builder) return `Started ${builder[1]} agent`;
    const step = message.match(/^spawned (.+) thr_[\w-]+$/);
    if (step) return `Started ${step[1]}${/ agent \d+$/.test(step[1]!) ? "" : " agent"}`;
    return "Started an agent";
  }
  return message.replace(/\bthread thr_[\w-]+/g, "thread").replace(/\bthr_[\w-]+/g, "thread");
}
