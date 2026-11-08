import { describe, expect, it } from "vitest";
import { attentionKind, matchesTaskFilter } from "../components/cos/dashboardModel";

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
    expect(matchesTaskFilter(task("queued"), "agent")).toBe(false);
    expect(matchesTaskFilter(task("failed"), "all")).toBe(true);
  });
});
