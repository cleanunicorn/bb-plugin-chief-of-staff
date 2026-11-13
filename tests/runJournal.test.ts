// The step journal: what the engine records, how it is stored, and how the
// workflow view counts loop-backs from it.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, initialNodes, transition, type JournalEntry, type MachineEvent, type StepReport } from "../src/machine";
import { MIGRATIONS, StateStore, type WorkItem } from "../src/state";
import { workflowSchema, type Workflow } from "../src/workflow";
import { edgeCounts, journalLine, loopBacks, stepInputs, type JournalRecord } from "../components/cos/runModel";

const NOW = new Date("2026-11-07T10:00:00.000Z");
const w = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, next: ["test"] },
  { id: "test", name: "Tests", type: "check", command: "npm test", onFail: "build", maxAttempts: 2, next: ["review"] },
  { id: "review", name: "Review", type: "agent", verdict: true, onFail: "build", maxRounds: 2, approval: true },
] });
const item = (wf: Workflow): WorkItem => ({ id: "w1", repo: "acme/app", issueNumber: 12, issueTitle: "Fix login", threadId: null, environmentId: null, branch: null, prNumber: null, prUrl: null, status: "queued", providerId: null, model: null, fixAttempts: 0, retryCount: 0, lastError: null, source: "intake", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), lastActivityAt: null, finishedAt: null, waitingReason: null, waitingKind: null, jobStartedAt: null, taskBody: null, workflow: wf, nodes: initialNodes(wf), prState: null });
const report = (outcome: StepReport["outcome"], summary: string): StepReport => ({ outcome, summary, at: NOW.toISOString(), via: "tool" });

/** Run events in order; returns every journal entry they produced. */
function play(events: ((cur: WorkItem) => MachineEvent)[]): { item: WorkItem; journal: JournalEntry[] } {
  let cur = item(w);
  const journal: JournalEntry[] = [];
  for (const make of events) {
    const t = transition(cur, make(cur), DEFAULT_POLICY, NOW);
    cur = { ...cur, ...t.patch, nodes: t.nodes };
    journal.push(...t.journal);
  }
  return { item: cur, journal };
}
const ended = (step: string, r: StepReport) => (cur: WorkItem): MachineEvent => ({ type: "turn_ended", step, agent: 0, round: cur.nodes[step]!.round, report: r, question: null });
const records = (journal: JournalEntry[]): JournalRecord[] => journal.map((e, i) => ({ ...e, id: i + 1, at: NOW.toISOString(), actor: "test" }));

describe("step journal", () => {
  it("records reports, failures that loop back, re-runs with their feedback, and approvals", () => {
    const { journal } = play([
      () => ({ type: "start" }),
      ended("build", report("done", "Built it")),
      () => ({ type: "check_result", step: "test", ok: false, output: "1 failing" }),
      ended("build", report("done", "Fixed the test")),
      () => ({ type: "check_result", step: "test", ok: true, output: "12 passing" }),
      ended("review", report("failed", "Missing a null check")),
      ended("build", report("done", "Added the check")),
      () => ({ type: "check_result", step: "test", ok: true, output: "13 passing" }),
      ended("review", report("done", "Looks good")),
      () => ({ type: "approve" }),
    ]);
    const brief = journal.map((e) => [e.kind, e.step, e.round, e.to ?? null]);
    expect(brief).toEqual([
      ["started", "build", 1, null],
      ["reported", "build", 1, null], ["passed", "build", 1, null], ["started", "test", 1, null],
      ["failed", "test", 1, "build"], ["started", "build", 2, null],
      ["reported", "build", 2, null], ["passed", "build", 2, null], ["started", "test", 2, null],
      ["passed", "test", 2, null], ["started", "review", 1, null],
      ["reported", "review", 1, null], ["failed", "review", 1, "build"], ["started", "build", 3, null],
      ["reported", "build", 3, null], ["passed", "build", 3, null], ["started", "test", 3, null],
      ["passed", "test", 3, null], ["started", "review", 2, null],
      ["reported", "review", 2, null], ["waiting", "review", 2, null],
      ["passed", "review", 2, null],
    ]);
    // A re-run starts with the feedback that sent it back.
    expect(journal[5]!.detail).toBe("Tests failed:\n\n1 failing");
    expect(journal[13]!.detail).toBe("Review failed:\n\nMissing a null check");
    expect(journal.at(-1)!.detail).toBe("Approved");
    expect(journal[9]!.detail).toBe("12 passing");
  });

  it("records your revisions and re-runs as loop-backs", () => {
    const { journal } = play([
      () => ({ type: "start" }),
      ended("build", report("done", "Built")),
      () => ({ type: "check_result", step: "test", ok: true, output: "ok" }),
      ended("review", report("done", "Fine")),
      () => ({ type: "revise", feedback: "Also handle empty passwords" }),
      ended("review", report("done", "Fine again")),
      () => ({ type: "rerun", step: "build", feedback: "Rename the helper" }),
    ]);
    expect(journal.find((e) => e.kind === "revised")).toMatchObject({ step: "review", from: "review", to: "review", detail: "Also handle empty passwords" });
    expect(journal.find((e) => e.kind === "rerun")).toMatchObject({ step: "build", to: "build", detail: "Rename the helper" });
    const summary = loopBacks(w, records(journal), {});
    expect(summary).toMatchObject({ total: 2, approximate: false });
    expect(summary.loops.map((l) => [l.from, l.to, l.count])).toEqual([["review", "review", 1], [null, "build", 1]]);
  });

  it("records runs cut short by a loop-back, and why a task stopped", () => {
    const parallel = workflowSchema.parse({ id: "p", name: "P", steps: [
      { id: "build", name: "Build", type: "agent", writes: true, next: ["review", "docs"] },
      { id: "review", name: "Review", type: "agent", verdict: true, onFail: "build", next: ["ship"] },
      { id: "docs", name: "Docs", type: "agent", next: ["ship"] },
      { id: "ship", name: "Ship", type: "ship", action: "merge", onFail: "build" },
    ] });
    let cur = item(parallel);
    const journal: JournalEntry[] = [];
    const apply = (event: MachineEvent) => {
      const t = transition(cur, event, DEFAULT_POLICY, NOW);
      cur = { ...cur, ...t.patch, nodes: t.nodes };
      journal.push(...t.journal);
    };
    apply({ type: "start" });
    apply(ended("build", report("done", "Built"))(cur));
    // Review fails while Docs is still working: Docs' run is thrown away.
    apply(ended("review", report("failed", "Wrong"))(cur));
    expect(journal.filter((e) => e.kind === "interrupted").map((e) => [e.step, e.from, e.to])).toEqual([["docs", "review", "build"]]);
    // You re-run Build while it works: no entry for Build itself, only for what runs after it (nothing does).
    apply({ type: "rerun", step: "build" });
    expect(journal.filter((e) => e.kind === "interrupted")).toHaveLength(1);

    apply(ended("build", report("done", "Built"))(cur));
    apply(ended("review", report("done", "Fine"))(cur));
    apply(ended("docs", report("done", "Fine"))(cur));
    apply({ type: "pr_opened", step: "ship", prNumber: 7, prUrl: "https://example.test/7" });
    cur = { ...cur, prNumber: 7, status: "ci" };
    apply({ type: "pr_closed" });
    expect(journal.at(-1)).toMatchObject({ kind: "stopped", step: "ship", detail: "Pull request #7 was closed without merging" });

    let lost = item(parallel);
    const t1 = transition(lost, { type: "start" }, DEFAULT_POLICY, NOW);
    lost = { ...lost, nodes: t1.nodes, status: "agent" };
    const t2 = transition(lost, { type: "thread_failed", step: null, agent: 0, error: "thread deleted" }, DEFAULT_POLICY, NOW);
    expect(t2.journal).toEqual([{ kind: "stopped", step: "build", round: 1, detail: "The builder thread failed: thread deleted" }]);
  });

  it("clips long details", () => {
    const { journal } = play([() => ({ type: "start" }), ended("build", report("done", "x".repeat(10_000)))]);
    expect(journal.find((e) => e.kind === "reported")!.detail!.length).toBe(4_001);
    const failed = play([() => ({ type: "start" }), ended("build", report("done", "Built")), () => ({ type: "check_result", step: "test", ok: false, output: "x".repeat(10_000) + "THE ERROR" })]);
    expect(failed.journal.find((e) => e.kind === "failed")!.detail!.endsWith("THE ERROR")).toBe(true);
  });
});

describe("journal storage", () => {
  it("stores entries with their actor, oldest first, keeping the most recent", () => {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS) db.exec(m);
    const store = new StateStore(db, () => NOW);
    store.appendJournal("w1", [{ kind: "started", step: "build", round: 1, detail: null }, { kind: "failed", step: "test", round: 1, from: "test", to: "build", detail: "1 failing" }], "rpc:client");
    store.appendJournal("w2", [{ kind: "started", step: "plan", round: 1, detail: null }], "intake");
    store.appendJournal("w1", [{ kind: "reported", step: "build", round: 2, agent: 0, detail: "Fixed" }], "tool:thr_1");
    expect(store.listJournal("w1").map((e) => [e.kind, e.step, e.from ?? null, e.to ?? null, e.agent ?? null, e.actor])).toEqual([
      ["started", "build", null, null, null, "rpc:client"],
      ["failed", "test", "test", "build", null, "rpc:client"],
      ["reported", "build", null, null, 0, "tool:thr_1"],
    ]);
    expect(store.listJournal("w1", 2).map((e) => e.kind)).toEqual(["failed", "reported"]);
    expect(store.listJournal("w1")[0]).toMatchObject({ at: NOW.toISOString() });
  });
});

describe("run model", () => {
  const live = (attempts: Record<string, number>) => Object.fromEntries(w.steps.map((s) => [s.id, { status: "done" as const, phase: null, reported: 1, agents: 1, waitingKind: null, retrying: false, attempts: attempts[s.id] ?? 0, round: 1 }]));

  it("counts loop-backs per arrow from the journal, and handoffs made more than once", () => {
    const journal = records([
      { kind: "failed", step: "test", round: 1, from: "test", to: "build", detail: "1 failing" },
      { kind: "failed", step: "test", round: 2, from: "test", to: "build", detail: "2 failing" },
      { kind: "failed", step: "review", round: 1, from: "review", to: "build", detail: "Null check" },
      { kind: "failed", step: "review", round: 2, detail: "Still wrong" },
      { kind: "passed", step: "build", round: 1, detail: null },
      { kind: "passed", step: "build", round: 2, detail: null },
    ]);
    const summary = loopBacks(w, journal, live({}));
    expect(summary.total).toBe(3);
    expect(summary.loops[0]).toEqual({ from: "test", to: "build", count: 2, reasons: ["2 failing", "1 failing"] });
    expect(edgeCounts(w, journal, summary)).toEqual({ "fail:test:build": 2, "fail:review:build": 1, "next:build:test": 2 });
  });

  it("counts at least the failure counts when the journal began mid-run", () => {
    // Started before the journal: only the latest Tests failure was recorded, and Build's first start was not.
    const started = live({ test: 2 });
    const journal = records([{ kind: "started", step: "test", round: 1, detail: null }, { kind: "failed", step: "test", round: 2, from: "test", to: "build", detail: "2 failing" }]);
    const summary = loopBacks(w, journal, started);
    expect(summary).toMatchObject({ total: 2, approximate: true });
    expect(summary.loops).toEqual([{ from: "test", to: "build", count: 2, reasons: ["2 failing"] }]);
    // A journal with every step's first start is complete.
    const full = records(w.steps.map((s) => ({ kind: "started" as const, step: s.id, round: 1, detail: null })));
    expect(loopBacks(w, full, started)).toMatchObject({ total: 0, approximate: false });
  });

  it("approximates loop-backs from failure counts when a task has no journal", () => {
    const summary = loopBacks(w, [], live({ test: 2, review: 1 }));
    expect(summary).toMatchObject({ total: 3, approximate: true });
    expect(edgeCounts(w, [], summary)).toEqual({ "fail:test:build": 2, "fail:review:build": 1 });
  });

  it("lists what a step received from the steps before it", () => {
    const steps = { build: { startedAt: null, finishedAt: null, feedback: null, output: null, waitingReason: null, reports: [{ agent: 0, outcome: "done", summary: "Built", at: NOW.toISOString() }], threads: [] }, test: { startedAt: null, finishedAt: null, feedback: null, output: "12 passing", waitingReason: null, reports: [], threads: [] } };
    expect(stepInputs(w, steps, "test")).toEqual([{ from: "build", name: "Build", reports: [{ agent: 0, summary: "Built" }], output: null }]);
    expect(stepInputs(w, steps, "review")).toEqual([{ from: "test", name: "Tests", reports: [], output: "12 passing" }]);
    expect(stepInputs(w, steps, "build")).toEqual([]);
  });

  it("words timeline entries", () => {
    const [failed, rerun] = records([{ kind: "failed", step: "test", round: 1, from: "test", to: "build", detail: null }, { kind: "rerun", step: "review", round: 1, to: "review", detail: null }]);
    expect(journalLine(w, failed!)).toBe("Tests failed, sent back to Build");
    expect(journalLine(w, rerun!)).toBe("You ran Review again");
  });
});
