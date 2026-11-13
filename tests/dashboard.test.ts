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

describe("activity task labels", () => {
  it("names an issue task by number and title, and a standalone task by title", () => {
    expect(taskLabel({ workItemId: "abcdef123456", issueNumber: 109, issueTitle: "Activity rows" })).toEqual({ id: "abcdef123456", label: "#109 Activity rows" });
    expect(taskLabel({ workItemId: "abcdef123456", issueNumber: null, issueTitle: "Tidy the README" })).toEqual({ id: "abcdef123456", label: "Tidy the README" });
    expect(taskLabel({ workItemId: "abcdef123456", issueNumber: 7, issueTitle: "" })).toEqual({ id: "abcdef123456", label: "#7" });
  });
  it("falls back to the short id for a found task with no title, and to nothing when the task is unknown", () => {
    expect(taskLabel({ workItemId: "abcdef123456", issueNumber: null, issueTitle: "" })).toEqual({ id: "abcdef123456", label: "abcdef12" });
    expect(taskLabel({ workItemId: "gone", issueNumber: null, issueTitle: null })).toBeNull();
    expect(taskLabel({ workItemId: null, issueNumber: null, issueTitle: null })).toBeNull();
  });
});

describe("thread ids in activity text", () => {
  const join = (parts: ReturnType<typeof splitThreadIds>) => parts.map((p) => ("thread" in p ? p.thread : p.text)).join("");
  it.each([
    ["spawned Review thr_abc", [{ text: "spawned Review " }, { thread: "thr_abc" }]],
    ["archived 2 threads: thr_a1, thr_B2", [{ text: "archived 2 threads: " }, { thread: "thr_a1" }, { text: ", " }, { thread: "thr_B2" }]],
    ["could not archive thread thr_x: gone", [{ text: "could not archive thread " }, { thread: "thr_x" }, { text: ": gone" }]],
    ["tool:thr_x", [{ text: "tool:" }, { thread: "thr_x" }]],
    ["Build failed (exit 1)", [{ text: "Build failed (exit 1)" }]],
    ["mythr_abc is not an id", [{ text: "mythr_abc is not an id" }]],
  ])("splits %j into text and thread ids, keeping the text verbatim", (text, parts) => {
    expect(splitThreadIds(text)).toEqual(parts);
    expect(join(splitThreadIds(text))).toBe(text);
  });
});

describe("tasks offered by the activity filter", () => {
  const row = (workItemId: string | null, issueNumber: number | null, issueTitle: string | null) => ({ workItemId, issueNumber, issueTitle });
  it("lists each named task once, newest first, then the ones seen before", () => {
    const previous = [{ id: "old", label: "Old task" }, { id: "a", label: "#1 Stale title" }];
    const list = recentTasks([row("a", 1, "Fix login"), row(null, null, null), row("b", null, "Tidy"), row("a", 1, "Fix login"), row("gone", null, null)], previous);
    expect(list).toEqual([{ id: "a", label: "#1 Fix login" }, { id: "b", label: "Tidy" }, { id: "old", label: "Old task" }]);
  });
  it("keeps the previous list when nothing changed, and caps its length", () => {
    const previous = [{ id: "a", label: "#1 Fix login" }];
    expect(recentTasks([row("a", 1, "Fix login")], previous)).toBe(previous);
    const many = Array.from({ length: 30 }, (_, i) => row(`t${i}`, i + 1, "T"));
    expect(recentTasks(many, [], 20)).toHaveLength(20);
  });
});
