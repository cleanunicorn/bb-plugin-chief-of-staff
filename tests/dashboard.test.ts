import { describe, expect, it } from "vitest";
import { attentionKind, matchesTaskFilter, recentTasks, splitThreadIds, taskLabel } from "../components/cos/dashboardModel";

const task = (detail: string, waitingKind: string | null = null, stalled = false) => ({ detail, waitingKind, stalled });

describe("dashboard attention and filtering", () => {
  it("keeps historical failures and recovered errors out of actionable failures", () => {
    expect(attentionKind(task("failed", "escalation", true))).toBe(null);
    expect(attentionKind(task("done", "cos_error"))).toBe(null);
    expect(attentionKind(task("agent", "escalation"))).toBe(null);
    expect(attentionKind(task("retrying", "cos_error"))).toBe(null);
  });
  it("separates failure decisions, ordinary human input, and stalled work", () => {
    for (const kind of ["escalation", "cos_error", "no_report"]) expect(attentionKind(task("waiting_on_human", kind))).toBe("failures");
    for (const kind of ["question", "approval"]) expect(attentionKind(task("waiting_on_human", kind))).toBe("human");
    expect(attentionKind(task("agent", null, true))).toBe("stalled");
    expect(attentionKind(task("blocked"))).toBe("stalled");
    expect(attentionKind(task("waiting_on_human", "stalled"))).toBe("stalled");
  });
  it("filters exactly the attention group while retaining stage and finished filters", () => {
    expect(matchesTaskFilter(task("waiting_on_human", "cos_error"), "failures")).toBe(true);
    expect(matchesTaskFilter(task("failed"), "failures")).toBe(false);
    expect(matchesTaskFilter(task("waiting_on_human", "cos_error"), "human")).toBe(true);
    expect(matchesTaskFilter(task("agent", null, true), "stalled")).toBe(true);
    expect(matchesTaskFilter(task("ci"), "pr")).toBe(true);
    expect(matchesTaskFilter(task("waiting_on_human", "approval"), "input")).toBe(true);
    expect(matchesTaskFilter(task("waiting_on_human", "cos_error"), "input")).toBe(false);
    expect(matchesTaskFilter(task("queued"), "agent")).toBe(false);
    expect(matchesTaskFilter(task("failed"), "all")).toBe(true);
  });
});

describe("activity rows", () => {
  it("names a row's task by number and title, number, title, or Untitled task, and not at all without one", () => {
    expect(taskLabel({ workItemId: "a", issueNumber: 7, issueTitle: "Fix login" })).toBe("#7 Fix login");
    expect(taskLabel({ workItemId: "a", issueNumber: 7, issueTitle: "" })).toBe("#7");
    expect(taskLabel({ workItemId: "a", issueNumber: null, issueTitle: "Tidy the docs" })).toBe("Tidy the docs");
    expect(taskLabel({ workItemId: "a", issueNumber: null, issueTitle: "" })).toBe("Untitled task");
    expect(taskLabel({ workItemId: "gone", issueNumber: null, issueTitle: null })).toBe(null);
    expect(taskLabel({ workItemId: null, issueNumber: null, issueTitle: null })).toBe(null);
  });

  it("offers the tasks named in the feed, newest first, then those seen before, once each", () => {
    const row = (workItemId: string | null, issueNumber: number | null, issueTitle: string | null) => ({ workItemId, issueNumber, issueTitle });
    const rows = [row("b", 8, "Repair deploy"), row(null, null, null), row("a", 7, "Fix login"), row("b", 8, "Repair deploy"), row("gone", null, null)];
    expect(recentTasks(rows)).toEqual([{ id: "b", label: "#8 Repair deploy" }, { id: "a", label: "#7 Fix login" }]);
    expect(recentTasks([row("a", 7, "Fix login")], [{ id: "c", label: "Old" }, { id: "a", label: "#7 stale" }])).toEqual([{ id: "a", label: "#7 Fix login" }, { id: "c", label: "Old" }]);
    expect(recentTasks([], [{ id: "a", label: "A" }, { id: "b", label: "B" }], 1)).toEqual([{ id: "a", label: "A" }]);
  });

  it("splits thread ids out of messages and actors, keeping the text around them verbatim", () => {
    const cases: [string, (string | { thread: string })[]][] = [
      ["spawned Review thr_abc", ["spawned Review ", { thread: "thr_abc" }]],
      ["archived 2 threads: thr_a, thr_b", ["archived 2 threads: ", { thread: "thr_a" }, ", ", { thread: "thr_b" }]],
      ["could not archive thread thr_x: not found", ["could not archive thread ", { thread: "thr_x" }, ": not found"]],
      ["tool:thr_x", ["tool:", { thread: "thr_x" }]],
      ["thr_9Z", [{ thread: "thr_9Z" }]],
      ["Build failed (exit 1)", ["Build failed (exit 1)"]],
      ["author_thr_x is not a thread", ["author_thr_x is not a thread"]],
      ["", []],
    ];
    for (const [text, parts] of cases) {
      expect(splitThreadIds(text)).toEqual(parts);
      expect(splitThreadIds(text).map((p) => (typeof p === "string" ? p : p.thread)).join("")).toBe(text);
    }
  });
});
