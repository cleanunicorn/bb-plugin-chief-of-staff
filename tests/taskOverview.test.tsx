// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { container, mount, unmount } from "./dom";
import { DEFAULT_WORKFLOW } from "../src/workflow";

vi.mock("@get-bb/plugin-sdk/app", () => ({ Markdown: () => null, UrlLink: () => null, useBbNavigate: () => ({ toThread: vi.fn() }), useRpc: () => ({ call: vi.fn() }) }));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
import { TaskOverview, TaskSummary } from "../components/cos/taskRunView";
import type { TaskDetail, TaskUsage } from "../components/cos/runModel";

afterEach(unmount);

const task = (status: string, finishedAt: string | null): TaskDetail => ({ repo: "acme/app", issueNumber: 1, issueUrl: null, body: "Fix it", status, branch: null, prNumber: null, prUrl: null, threadId: null, waitingReason: null, lastError: null, createdAt: "2026-11-05T10:00:00.000Z", lastActivityAt: null, finishedAt } as TaskDetail);
const render = (t: TaskDetail) => mount(<TaskOverview itemId="one" title="Fix login" workflow={DEFAULT_WORKFLOW} task={t} loops={{ total: 0, loops: [], approximate: false }} journal={[]} now={Date.parse("2026-11-06T10:00:00Z")} />);

it.each(["done", "failed"])("does not promise history that will never come on a %s task", async (status) => {
  await render(task(status, "2026-11-05T12:00:00.000Z"));
  expect(container.textContent).toContain("No step history was recorded for this task.");
  expect(container.textContent).not.toContain("No history yet");
});

it("keeps the waiting text on an active task", async () => {
  await render(task("agent", null));
  expect(container.textContent).toContain("No history yet. Steps are recorded as they start, report, pass, fail or get sent back.");
});

describe("usage in the task summary", () => {
  const usage = (over: Partial<TaskUsage> = {}): TaskUsage => ({ inputTokens: 1, outputTokens: 2, totalTokens: 4_200_000, cost: { amount: 12.5, currency: "USD" }, threads: 5, reportedThreads: 4, counted: true, ...over });
  const summary = (t: TaskDetail, u: TaskUsage | null, oneLine = false) => mount(<TaskSummary task={{ ...t, branch: "cos/issue-1", prUrl: "https://github.com/acme/app/pull/3", prNumber: 3 }} workflow={DEFAULT_WORKFLOW} live={{}} loops={{ total: 0, loops: [], approximate: false }} now={Date.parse("2026-11-06T10:00:00Z")} usage={u} oneLine={oneLine} />);
  const facts = () => Array.from(container.querySelectorAll("dl > div")).map((d) => d.textContent);

  it("shows a finished task's tokens and cost over all threads, before PR and Branch, keeping Branch the one that shrinks", async () => {
    await summary(task("done", "2026-11-05T12:00:00.000Z"), usage(), true);
    expect(facts().slice(-4)).toEqual(["Tokens · all threads4.2M", "Cost12.50 USD", "PR", "Branchcos/issue-1"]);
    const rows = Array.from(container.querySelectorAll<HTMLElement>("dl > div"));
    expect(rows[rows.length - 4]!.getAttribute("title")).toBe("Sum over 5 agent threads (4 reported usage)");
    expect(rows.slice(0, -1).every((r) => r.className.includes("shrink-0"))).toBe(true);
    expect(rows.at(-1)!.className).not.toContain("shrink-0");
  });

  it("says an active task's figure is so far, a finished one's is being counted, and hides a task that reported nothing", async () => {
    await summary(task("agent", null), usage({ cost: null }));
    expect(facts()).toContain("Tokens so far · all threads4.2M");
    expect(facts().some((f) => f?.startsWith("Cost"))).toBe(false);
    // A legacy finished row without a finish time is still finished.
    await summary(task("done", null), usage());
    expect(facts()).toContain("Tokens · all threads4.2M");
    await summary(task("done", "2026-11-05T12:00:00.000Z"), usage({ totalTokens: null, cost: null, counted: false, reportedThreads: 0 }));
    expect(facts()).toContain("Tokens · all threadscounting…");
    await summary(task("done", "2026-11-05T12:00:00.000Z"), usage({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null, reportedThreads: 0 }));
    expect(facts().some((f) => f?.includes("Tokens"))).toBe(false);
    await summary(task("done", "2026-11-05T12:00:00.000Z"), null);
    expect(facts().some((f) => f?.includes("Tokens"))).toBe(false);
  });
});
