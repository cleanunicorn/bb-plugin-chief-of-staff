// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { entry } from "./helpers/roster";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import type { WorkflowCanvasProps } from "../components/cos/workflowCanvas";

const mocks = vi.hoisted(() => ({ entries: [] as unknown[], call: vi.fn(), navigate: { toThread: vi.fn() }, question: {} as Record<string, unknown>, workflow: {} as Record<string, unknown> }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method }: { method: string }) => ({
    data: method === "cos_roster" ? { entries: mocks.entries } : method === "cos_item_workflow" ? mocks.workflow : method === "cos_question" ? mocks.question : method === "cos_stats" ? { doneInWindow: 0, failedInWindow: 0, medianCycleMinutes: null, daily: [] } : { paused: false, repos: [], occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 } },
    error: null, refetch: vi.fn(),
  }),
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
  ThreadTitle: () => null, UrlLink: () => null,
}));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
// The canvas itself is covered in workflowCanvas.test.tsx; here it is a step and the full-screen control.
vi.mock("../components/cos/workflowCanvas", async (original) => ({
  ...(await original<typeof import("../components/cos/workflowCanvas")>()),
  WorkflowCanvas: ({ onSelect, onToggleExpanded, expanded, selected }: WorkflowCanvasProps) => (
    <div data-canvas>
      <button type="button" className={`react-flow__node${selected === "plan" ? " selected" : ""}`} onClick={() => onSelect?.("plan")}>Plan node</button>
      <button type="button" className="react-flow__node">Build node</button>
      <button type="button" onClick={onToggleExpanded}>{expanded ? "Exit full screen" : "Full screen"}</button>
    </div>
  ),
}));
import { PipelineTab } from "../app";

const waiting = () => entry({ detail: "waiting_on_human", status: "waiting on human", waitingKind: "question", waitingReason: "Which database?" });

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const render = () => act(async () => { root.render(<PipelineTab />); });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (label: string, within: ParentNode = document) => Array.from(within.querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim().startsWith(label))!;
const click = (el: HTMLElement) => act(async () => { el.focus(); el.click(); });
const press = (key: string, target: Element = document.activeElement ?? document.body) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
/** The dialog hands focus back after it has unmounted. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.entries = [waiting()];
  mocks.workflow = { title: "Fix login", workflow: DEFAULT_WORKFLOW, live: { plan: { status: "done", phase: null, reported: 1, agents: 1, waitingKind: null, retrying: false, attempts: 0, round: 1 }, build: { status: "waiting", phase: null, reported: 0, agents: 1, waitingKind: "approval", retrying: false, attempts: 0, round: 1 } } };
  mocks.question = { itemId: "one", repo: "acme/app", issueNumber: 1, issueTitle: "Fix login", threadId: "thread-1", threadUrl: null, status: "waiting on human", stepId: "build", stepName: "Build", waitingKind: "question", waitingReason: "Which database?", report: null, decidable: false, open: [{ kind: "text", question: "Which database?" }], lastMessage: null, checkOutput: null, lastError: null };
  mocks.call.mockReset().mockResolvedValue({});
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => { await act(async () => { root.unmount(); }); await settle(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("moves focus into the workflow sheet, keeps it there, and returns it to the Workflow button", async () => {
  const opener = button("Workflow", container);
  await click(opener);
  const sheet = dialog()!;
  expect(sheet.contains(document.activeElement)).toBe(true);
  expect(document.getElementById(sheet.getAttribute("aria-labelledby")!)?.textContent).toBe("Where this task is");
  expect(container.getAttribute("aria-hidden")).toBe("true");

  // Tab from the last control wraps to the first instead of reaching the page behind.
  const first = button("Canvas", sheet);
  const steps = Array.from(sheet.querySelectorAll<HTMLElement>("button"));
  const last = steps.at(-1)!;
  last.focus();
  await press("Tab");
  expect(document.activeElement).toBe(first);

  await press("Escape");
  await settle();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(container.hasAttribute("aria-hidden")).toBe(false);
});

it("closes the workflow sheet from its Close button", async () => {
  const opener = button("Workflow", container);
  await click(opener);
  await click(button("Close", dialog()!));
  await settle();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("uses Escape to leave full screen, then to clear a focused step, then to close", async () => {
  await click(button("Workflow", container));
  await click(button("Full screen", dialog()!));
  expect(button("Exit full screen", dialog()!)).toBeDefined();
  await press("Escape");
  expect(button("Full screen", dialog()!)).toBeDefined();

  await click(button("Plan node", dialog()!));
  expect(dialog()!.querySelector('[aria-label="Step details"]')).not.toBeNull();
  await press("Escape");
  expect(dialog()).not.toBeNull();
  expect(dialog()!.querySelector('[aria-label="Step details"]')).toBeNull();

  await press("Escape");
  expect(dialog()).toBeNull();
});

it("closes on Escape from a step that is not the selected one, keeping the selection out of it", async () => {
  await click(button("Workflow", container));
  await click(button("Plan node", dialog()!));
  button("Build node", dialog()!).focus();
  await press("Escape");
  expect(dialog()).toBeNull();
});

it("runs a step again from the step list, without the canvas", async () => {
  await click(button("Workflow", container));
  await click(button("List", dialog()!));
  expect(dialog()!.querySelector("[data-canvas]")).toBeNull();
  const rows = Array.from(dialog()!.querySelectorAll<HTMLElement>("ol button"));
  expect(rows.map((row) => row.textContent)).toEqual(["PlanAgentdone", "BuildAgentneeds approval", "ReviewAgentpending", "ShipShippending"]);
  await click(rows[1]!);
  expect(rows[1]!.getAttribute("aria-pressed")).toBe("true");
  expect(dialog()!.querySelector('[aria-label="Step details"]')!.textContent).toContain("needs approval");
  await click(button("Run again from here", dialog()!));
  expect(mocks.call).not.toHaveBeenCalled();
  await click(button("Run again", document.querySelectorAll<HTMLElement>('[role="dialog"]')[1]!));
  expect(mocks.call).toHaveBeenCalledWith("cos_item_action", { id: "one", action: "rerun_step", step: "build" });

  // The selection survives switching views.
  await click(button("Canvas", dialog()!));
  expect(dialog()!.querySelector('[aria-label="Step details"]')!.textContent).toContain("Build");
});

it("moves focus into the question sheet, keeps it there, and returns it to the question button", async () => {
  const opener = button("Open the question", container);
  await click(opener);
  const sheet = dialog()!;
  expect(sheet.contains(document.activeElement)).toBe(true);
  expect(document.getElementById(sheet.getAttribute("aria-labelledby")!)?.textContent).toBe("Fix login");
  expect(container.getAttribute("aria-hidden")).toBe("true");

  const tabbable = Array.from(sheet.querySelectorAll<HTMLElement>("button:not([disabled]), textarea, [tabindex='0']"));
  tabbable.at(-1)!.focus();
  await press("Tab");
  expect(document.activeElement).toBe(tabbable[0]);
  tabbable[0]!.focus();
  await act(async () => { tabbable[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(tabbable.at(-1));

  await press("Escape");
  await settle();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("lands on the Pipeline heading when the question button is gone by the time the sheet closes", async () => {
  await click(button("Open the question", container));
  mocks.entries = [entry()];
  await render();
  await click(button("Close", dialog()!));
  await settle();
  expect(dialog()).toBeNull();
  expect(document.activeElement?.textContent).toBe("Work overview");
});

it("closes the question sheet and opens the thread", async () => {
  await click(button("Open the question", container));
  await click(button("Open thread", dialog()!));
  expect(dialog()).toBeNull();
  expect(mocks.navigate.toThread).toHaveBeenCalledWith("thread-1");
});

it("asks before closing the question sheet over a draft, then returns focus to the question button", async () => {
  const opener = button("Open the question", container);
  await click(opener);
  const reply = dialog()!.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(reply, "Half a th");
    reply.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Escape");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  await click(button("Discard", document));
  await settle();
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.pointerEvents).not.toBe("none");
});
