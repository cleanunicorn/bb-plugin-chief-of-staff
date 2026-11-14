// @vitest-environment jsdom
// The selected step's panel in the workflow sheet: on a finished task it reads as a record, with no timer that
// keeps counting and nothing that says work is in progress (#117).
import { afterEach, describe, expect, it, vi } from "vitest";
import { container, mount, unmount } from "./dom";
import { DEFAULT_WORKFLOW, stepById, workflowSchema, type Step, type Workflow } from "../src/workflow";

vi.mock("@get-bb/plugin-sdk/app", () => ({ Markdown: () => null, UrlLink: () => null, useBbNavigate: () => ({ toThread: vi.fn() }), useRpc: () => ({ call: vi.fn() }) }));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
import { StepPanel } from "../components/cos/taskRunView";
import type { StepDetail, TaskDetail } from "../components/cos/runModel";
import type { LiveStatus } from "../components/cos/workflowCanvas";

afterEach(unmount);

const NOW = Date.parse("2026-11-10T10:00:00Z");
const FINISHED = "2026-11-05T12:00:00.000Z";
const task = (status: string, finishedAt: string | null, extra: Partial<TaskDetail> = {}): TaskDetail => ({ repo: "acme/app", issueNumber: 1, issueUrl: null, body: "Fix it", status, branch: null, prNumber: null, prUrl: null, threadId: null, waitingReason: null, lastError: null, createdAt: "2026-11-05T09:00:00.000Z", lastActivityAt: null, finishedAt, outcome: null, ...extra } as TaskDetail);
const detail = (extra: Partial<StepDetail> = {}): StepDetail => ({ startedAt: null, finishedAt: null, feedback: null, output: null, waitingReason: null, reports: [], threads: [], ...extra });
const live = (status: LiveStatus["status"]): LiveStatus => ({ status, phase: null, reported: 0, agents: 1, waitingKind: null, retrying: false, attempts: 0, round: status === "pending" ? 0 : 1 });

async function render({ wf = DEFAULT_WORKFLOW, stepId, t, l, d, steps = {}, now = NOW }: { wf?: Workflow; stepId: string; t: TaskDetail; l: LiveStatus | undefined; d: StepDetail | undefined; steps?: Record<string, StepDetail>; now?: number }) {
  await mount(<StepPanel itemId="one" workflow={wf} step={stepById(wf, stepId) as Step} task={t} live={l} detail={d} steps={{ ...steps, [stepId]: d ?? detail() }} journal={[]} now={now} />);
  return container.textContent!;
}
/** A fact under the step's title, by its label ("Took", "Ran for", "Running for"). */
const fact = (label: string) => Array.from(container.querySelectorAll("dt")).find((dt) => dt.textContent === label)?.nextElementSibling?.textContent ?? null;
const failed = task("failed", FINISHED, { outcome: "failed", lastError: "thread archived" });

describe("a step the task stopped in", () => {
  const stopped = detail({ startedAt: "2026-11-05T11:00:00.000Z" });

  it("says how long it ran before the task ended, and stops counting", async () => {
    const first = await render({ stepId: "ship", t: failed, l: live("stopped"), d: stopped });
    expect(fact("Ran for")).toBe("1.0h before the task ended");
    expect(fact("Running for")).toBeNull();
    await render({ stepId: "ship", t: failed, l: live("stopped"), d: stopped, now: NOW + 3 * 86_400_000 });
    expect(fact("Ran for")).toBe("1.0h before the task ended");
    expect(first).not.toContain("Running for");
  });

  it("says it did not finish instead of that work is going on", async () => {
    const text = await render({ stepId: "ship", t: failed, l: live("stopped"), d: stopped });
    expect(text).toContain("Did not finish.");
    expect(text).toContain("No runs recorded for this step.");
    // Received from Review: nothing, and nothing more will come.
    expect(text).toContain("Nothing.");
    expect(text).not.toMatch(/Working on it|\byet\b/);
  });

  it("does not claim a duration when the task's end is not known", async () => {
    await render({ stepId: "ship", t: task("failed", null, { outcome: "failed" }), l: live("stopped"), d: stopped });
    expect(fact("Ran for")).toBe("–");
  });

  it("measures to the last activity on a legacy row without a finish time", async () => {
    await render({ stepId: "ship", t: task("failed", null, { outcome: "failed", lastActivityAt: "2026-11-05T11:30:00.000Z" }), l: live("stopped"), d: stopped });
    expect(fact("Ran for")).toBe("30m before the task ended");
  });

  it("reads a step that was left pending after it had started as one that did not finish", async () => {
    // Closing a task sends in-flight steps back to pending; they keep startedAt.
    const text = await render({ stepId: "ship", t: failed, l: live("pending"), d: stopped });
    expect(text).toContain("Did not finish.");
    expect(fact("Ran for")).toBe("1.0h before the task ended");
  });
});

it("says a step the task never reached did not run", async () => {
  const text = await render({ stepId: "review", t: failed, l: live("pending"), d: detail() });
  expect(text).toContain("Did not run.");
  expect(text).not.toMatch(/Working on it|Running for|\byet\b/);
});

it("keeps the time a finished step took, and says it produced nothing when it did", async () => {
  const done = task("done", FINISHED, { outcome: "pr_opened", prNumber: 7 });
  const text = await render({ stepId: "ship", t: done, l: live("done"), d: detail({ startedAt: "2026-11-05T11:00:00.000Z", finishedAt: "2026-11-05T11:20:00.000Z" }) });
  expect(fact("Took")).toBe("20m");
  const produced = Array.from(container.querySelectorAll("section")).find((sec) => sec.querySelector("h4")?.textContent === "Produced")!;
  expect(produced.textContent).toBe("ProducedNothing.");
  expect(text).not.toContain("Did not finish.");
  expect(text).not.toMatch(/Working on it|Running for|\byet\b/);
});

it("says no model was picked when the task ended first", async () => {
  const wf = workflowSchema.parse({ id: "m", name: "M", steps: [{ id: "model", name: "Select model", type: "model", mode: "auto", instructions: "Pick one.", next: [] }] });
  const text = await render({ wf, stepId: "model", t: failed, l: live("stopped"), d: detail({ startedAt: "2026-11-05T11:00:00.000Z" }) });
  expect(text).toContain("nothing (the task ended before a model was picked)");
  expect(text).not.toMatch(/\byet\b/);
});

describe("on an active task", () => {
  const active = task("agent", null);

  it("keeps counting and says the step is being worked on", async () => {
    const text = await render({ stepId: "ship", t: active, l: live("running"), d: detail({ startedAt: "2026-11-10T09:00:00.000Z" }) });
    expect(fact("Running for")).toBe("1.0h");
    expect(text).toContain("Working on it.");
    expect(text).toContain("Nothing yet.");
    expect(text).toContain("No runs recorded for this step yet.");
    await render({ stepId: "ship", t: active, l: live("running"), d: detail({ startedAt: "2026-11-10T09:00:00.000Z" }), now: NOW + 60 * 60_000 });
    expect(fact("Running for")).toBe("2.0h");
  });

  it("keeps the model step's promise of a pick", async () => {
    const wf = workflowSchema.parse({ id: "m", name: "M", steps: [{ id: "model", name: "Select model", type: "model", mode: "auto", instructions: "Pick one.", next: [] }] });
    expect(await render({ wf, stepId: "model", t: active, l: live("running"), d: detail() })).toContain("not yet: an agent picks the best model for the task");
  });
});
