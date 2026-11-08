import { expect, it } from "vitest";
import { activitySummary } from "../components/cos/activitySummary";

it("describes recorded transitions without inventing approval", () => {
  expect(activitySummary({ kind: "transition", message: "agent → agent; Plan: running → done; Build: pending → running (turn_end)" })).toBe("Plan completed; Build started");
  expect(activitySummary({ kind: "transition", message: "waiting_on_human → agent; Build: waiting → running (approve)" })).toBe("Build resumed");
  expect(activitySummary({ kind: "report", message: "Plan reported done" })).toBe("Plan reported done");
});
it("keeps repeat runs accurate and falls back for unknown transition formats", () => {
  expect(activitySummary({ kind: "transition", message: "Build: running → running (again) (retry)" })).toBe("Build restarted");
  expect(activitySummary({ kind: "transition", message: "new internal representation" })).toBe("Workflow state updated");
});
it("summarizes spawned threads without internal ids or provider plumbing", () => {
  expect(activitySummary({ kind: "spawn", message: "spawned builder thr_abc for Build (codex / model)" })).toBe("Started Build agent");
  expect(activitySummary({ kind: "spawn", message: "spawned Review plan agent 2 thr_abc" })).toBe("Started Review plan agent 2");
  expect(activitySummary({ kind: "effect", message: "could not archive thread thr_abc: permission denied" })).toBe("could not archive thread: permission denied");
});
