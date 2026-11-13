// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { container, mount, unmount } from "./dom";
import { DEFAULT_WORKFLOW } from "../src/workflow";

vi.mock("@get-bb/plugin-sdk/app", () => ({ Markdown: () => null, UrlLink: () => null, useBbNavigate: () => ({ toThread: vi.fn() }), useRpc: () => ({ call: vi.fn() }) }));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
import { TaskOverview } from "../components/cos/taskRunView";
import type { TaskDetail } from "../components/cos/runModel";

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
