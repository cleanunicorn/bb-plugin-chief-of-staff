// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { container, mount, unmount } from "./dom";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import { MARKED_FAILED, PR_CLOSED_ERROR } from "../src/outcome";

vi.mock("@get-bb/plugin-sdk/app", () => ({ Markdown: () => null, UrlLink: () => null, useBbNavigate: () => ({ toThread: vi.fn() }), useRpc: () => ({ call: vi.fn() }) }));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
import { TaskOverview, TaskSummary } from "../components/cos/taskRunView";
import type { TaskDetail } from "../components/cos/runModel";

afterEach(unmount);

const NOW = Date.parse("2026-11-06T10:00:00Z");
const FINISHED = "2026-11-05T12:00:00.000Z";
const task = (status: string, finishedAt: string | null, extra: Partial<TaskDetail> = {}): TaskDetail => ({ repo: "acme/app", issueNumber: 1, issueUrl: null, body: "Fix it", status, branch: null, prNumber: null, prUrl: null, threadId: null, waitingReason: null, lastError: null, createdAt: "2026-11-05T10:00:00.000Z", lastActivityAt: null, finishedAt, outcome: null, ...extra } as TaskDetail);
const loops = { total: 0, loops: [], approximate: false };
const render = (t: TaskDetail, now = NOW) => mount(<TaskOverview itemId="one" title="Fix login" workflow={DEFAULT_WORKFLOW} task={t} loops={loops} journal={[]} now={now} />);
/** The callout that says how the task ended: the paragraph opening with the outcome's label. */
const ending = (label: string) => Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.startsWith(label))?.textContent ?? null;
const at = (iso: string) => new Date(iso).toLocaleString();

it.each(["done", "failed"])("does not promise history that will never come on a %s task", async (status) => {
  await render(task(status, FINISHED));
  expect(container.textContent).toContain("No step history was recorded for this task.");
  expect(container.textContent).not.toContain("No history yet");
});

it("keeps the waiting text on an active task", async () => {
  await render(task("agent", null));
  expect(container.textContent).toContain("No history yet. Steps are recorded as they start, report, pass, fail or get sent back.");
});

describe("how a finished task ended", () => {
  it("labels why a failed task ended, and when", async () => {
    await render(task("failed", FINISHED, { outcome: "failed", lastError: "thread archived" }));
    const text = ending("Failed");
    expect(text).toContain(`ended ${at(FINISHED)}`);
    expect(text).toContain("Why it ended: thread archived");
    // The bare error box is gone: the reason appears once, labelled.
    expect(container.textContent!.split("thread archived").length - 1).toBe(1);
    await render(task("failed", FINISHED, { outcome: "failed", lastError: "thread archived" }), NOW + 3 * 86_400_000);
    expect(ending("Failed")).toBe(text);
  });

  it("does not repeat the label of a task failed by hand", async () => {
    await render(task("failed", FINISHED, { outcome: "marked_failed", lastError: MARKED_FAILED }));
    expect(ending("Marked failed")).toBe(`Marked failed · ended ${at(FINISHED)}`);
  });

  it("calls an older error on a task failed by hand the last error, not the cause", async () => {
    await render(task("failed", FINISHED, { outcome: "marked_failed", lastError: "push rejected" }));
    expect(ending("Marked failed")).toContain("Last error: push rejected");
    expect(container.textContent).not.toContain("Why it ended");
  });

  it("says a pull request was closed without merging", async () => {
    await render(task("failed", FINISHED, { outcome: "pr_closed", lastError: PR_CLOSED_ERROR, prNumber: 7 }));
    // The reason already says it: one line, not "PR closed" and then "PR closed without merge".
    expect(ending("PR closed")).toBe(`${PR_CLOSED_ERROR} · ended ${at(FINISHED)}`);
  });

  it("says how a done task ended, without a stale error", async () => {
    await render(task("done", FINISHED, { outcome: "merged", lastError: "flaky CI", prNumber: 7 }));
    expect(ending("Merged")).toBe(`Merged · ended ${at(FINISHED)}`);
    expect(container.textContent).not.toContain("flaky CI");
  });

  it("puts the finish time next to the start and last activity", async () => {
    await render(task("failed", FINISHED, { outcome: "failed", lastError: "thread archived", lastActivityAt: "2026-11-05T11:00:00.000Z" }));
    expect(container.textContent).toContain(`last activity 23h ago · finished ${at(FINISHED)}`);
  });

  it("takes the last activity as the end of a legacy row without a finish time", async () => {
    const last = "2026-11-05T11:00:00.000Z";
    await render(task("failed", null, { outcome: "failed", lastError: "thread archived", lastActivityAt: last }));
    expect(ending("Failed")).toBe(`Failed · ended ${at(last)}Why it ended: thread archived`);
    expect(container.textContent).toContain(`finished ${at(last)}`);
  });

  it("says no end time when neither is known", async () => {
    await render(task("failed", null, { outcome: "failed", lastError: "thread archived" }));
    expect(ending("Failed")).toBe("FailedWhy it ended: thread archived");
    expect(container.textContent).not.toContain("finished ");
  });

  it("keeps the plain error callout on an active task", async () => {
    await render(task("agent", null, { lastError: "push rejected" }));
    expect(Array.from(container.querySelectorAll("p")).some((p) => p.textContent === "push rejected")).toBe(true);
    expect(container.textContent).not.toContain("Why it ended");
    expect(container.textContent).not.toContain("finished ");
  });
});

describe("the summary strip's timer", () => {
  const summary = async (t: TaskDetail, now: number) => {
    await mount(<TaskSummary task={t} workflow={DEFAULT_WORKFLOW} live={{}} loops={loops} now={now} />);
    return container.querySelector("dl")!.textContent;
  };

  it("measures a finished task to its finish and does not tick", async () => {
    const t = task("failed", FINISHED, { outcome: "failed" });
    const first = await summary(t, NOW);
    expect(first).toContain("Took2.0h");
    expect(await summary(t, NOW + 86_400_000)).toBe(first);
  });

  it("falls back to the last activity on a legacy row without a finish time", async () => {
    const t = task("done", null, { outcome: "completed", lastActivityAt: "2026-11-05T11:00:00.000Z" });
    const first = await summary(t, NOW);
    expect(first).toContain("Took1.0h");
    expect(await summary(t, NOW + 86_400_000)).toBe(first);
  });

  it("shows no duration when neither time is known", async () => {
    const t = task("failed", null, { outcome: "failed" });
    expect(await summary(t, NOW)).toContain("Took–");
    expect(await summary(t, NOW + 86_400_000)).toContain("Took–");
  });

  it("keeps counting on an active task", async () => {
    expect(await summary(task("agent", null), NOW)).toContain("Running for24h");
  });
});
