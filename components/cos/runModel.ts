// What happened in one task's run, derived from its step journal (or, for
// tasks started before the journal existed, approximated from step state):
// the loop-backs between steps, per-arrow counts for the canvas, and what each
// step received from the steps before it.
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../rpcContract";
import { agentWork, predecessors, stepById, type Workflow } from "../../src/workflow";

export type ItemWorkflowView = PluginRpcResult<(typeof rpcContract)["cos_item_workflow"]>;
export type JournalRecord = NonNullable<ItemWorkflowView["journal"]>[number];
export type StepDetail = NonNullable<ItemWorkflowView["steps"]>[string];
export type TaskDetail = NonNullable<ItemWorkflowView["task"]>;
type Live = ItemWorkflowView["live"];

/** Work sent from one step back to another, `count` times. `from` null: you re-ran it. */
export interface LoopBack {
  from: string | null;
  to: string;
  count: number;
  /** Why, most recent first (failure detail or your feedback). */
  reasons: string[];
}

export interface LoopSummary {
  total: number;
  loops: LoopBack[];
  /** The journal does not cover the whole run: fail arrows count at least the steps' failure counts, which reset when you send a step back. */
  approximate: boolean;
}

/** Whether the journal covers the whole run: every step that has run has its first start recorded. */
export function journalComplete(wf: Workflow, journal: readonly JournalRecord[] | undefined, live: Live): boolean {
  const firstStarts = new Set((journal ?? []).filter((e) => e.kind === "started" && e.round === 1).map((e) => e.step));
  return wf.steps.every((s) => (live[s.id]?.round ?? 0) < 1 || firstStarts.has(s.id));
}

/**
 * Loop-backs: failures that sent work back, and your revisions and re-runs.
 * For a task whose journal began mid-run (it started before the journal
 * existed), each fail arrow counts at least the step's failure count.
 */
export function loopBacks(wf: Workflow, journal: readonly JournalRecord[] | undefined, live: Live): LoopSummary {
  const map = new Map<string, LoopBack>();
  const add = (from: string | null, to: string, reason: string | null, n = 1) => {
    const key = `${from ?? ""}>${to}`;
    const cur = map.get(key) ?? { from, to, count: 0, reasons: [] };
    cur.count += n;
    if (reason) cur.reasons.unshift(reason);
    map.set(key, cur);
  };
  for (const e of journal ?? []) {
    if (e.kind === "failed" && e.to) add(e.step, e.to, e.detail);
    else if (e.kind === "revised" && e.to) add(e.step, e.to, e.detail);
    else if (e.kind === "rerun") add(null, e.to ?? e.step, e.detail);
  }
  const approximate = !journalComplete(wf, journal, live);
  if (approximate) {
    for (const s of wf.steps) {
      const attempts = live[s.id]?.attempts ?? 0;
      const seen = map.get(`${s.id}>${s.onFail}`)?.count ?? 0;
      if (s.onFail && attempts > seen) add(s.id, s.onFail, null, attempts - seen);
    }
  }
  const loops = [...map.values()].sort((a, b) => b.count - a.count);
  return { total: loops.reduce((n, l) => n + l.count, 0), loops, approximate };
}

/** Counts for the canvas arrows: fail arrows taken, and handoffs made more than once. */
export function edgeCounts(wf: Workflow, journal: readonly JournalRecord[] | undefined, summary: LoopSummary): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of summary.loops) if (l.from && stepById(wf, l.from)?.onFail === l.to) out[`fail:${l.from}:${l.to}`] = (out[`fail:${l.from}:${l.to}`] ?? 0) + l.count;
  if (journal?.length) {
    const passed = new Map<string, number>();
    for (const e of journal) if (e.kind === "passed") passed.set(e.step, (passed.get(e.step) ?? 0) + 1);
    for (const s of wf.steps) {
      const n = passed.get(s.id) ?? 0;
      if (n > 1) for (const next of s.next) out[`next:${s.id}:${next}`] = n;
    }
  }
  return out;
}

/** The current inputs of a step: the latest reports (or check output) of the steps feeding into it. */
export function stepInputs(wf: Workflow, steps: Record<string, StepDetail> | undefined, id: string): { from: string; name: string; reports: { agent: number; summary: string }[]; output: string | null }[] {
  return predecessors(wf, id).map((p) => {
    const d = steps?.[p];
    const s = stepById(wf, p);
    return { from: p, name: s?.name ?? p, reports: d?.reports.map((r) => ({ agent: r.agent, summary: r.summary })) ?? [], output: s?.type === "check" ? (d?.output ?? null) : null };
  });
}

/** How a journal entry reads in the timeline. */
export function journalLine(wf: Workflow, e: JournalRecord): string {
  const name = (id: string | undefined) => (id ? (stepById(wf, id)?.name ?? id) : "");
  const step = name(e.step);
  switch (e.kind) {
    case "started":
      return e.round > 1 ? `${step} started again (run ${e.round})` : `${step} started`;
    case "reported": {
      const agents = agentWork(stepById(wf, e.step))?.agents ?? 1;
      return `${step}${agents > 1 && e.agent !== undefined ? ` agent ${e.agent + 1}` : ""} reported`;
    }
    case "passed":
      return `${step} passed`;
    case "failed":
      return e.to ? `${step} failed, sent back to ${name(e.to)}` : `${step} failed`;
    case "waiting":
      return `${step} is waiting on you`;
    case "revised":
      return `You sent ${step} back${e.to && e.to !== e.step ? ` to ${name(e.to)}` : ""} with feedback`;
    case "rerun":
      return `You ran ${name(e.to ?? e.step)} again`;
    case "interrupted":
      return `${step} was cut short: ${e.from ? `${name(e.from)} sent work back to ${name(e.to)}` : `${name(e.to)} runs again`}`;
    case "stopped":
      return `${step} stopped: the task failed`;
  }
}

/** Kinds of timeline entry that change the run's course (the rest are progress). */
export const PIVOTAL_KINDS: ReadonlySet<JournalRecord["kind"]> = new Set(["failed", "revised", "rerun", "waiting", "interrupted", "stopped"]);

/**
 * Whether the task has finished (done or failed), and when: its finish time, or its last activity on legacy rows
 * without one; null when neither is known. Durations on a finished task's sheet are measured to `end`, never to now.
 */
export function taskEnd(task: Pick<TaskDetail, "status" | "finishedAt" | "lastActivityAt"> | undefined): { finished: boolean; end: string | null } {
  const finished = task?.status === "done" || task?.status === "failed";
  return { finished, end: finished ? (task!.finishedAt ?? task!.lastActivityAt ?? null) : null };
}
