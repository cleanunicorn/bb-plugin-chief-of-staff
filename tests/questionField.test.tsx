// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn(), question: {} as Record<string, unknown> }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ toThread: vi.fn() }),
  useRpc: () => ({ call: mocks.call }),
  experimental_useRpcQuery: () => ({ data: mocks.question, error: null, refetch: vi.fn() }),
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
import { QuestionSheet } from "../components/cos/question";

const option = (value: string) => ({ label: value, value, description: null });
let root: ReturnType<typeof createRoot>;
const radios = () => Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'));
const boxes = () => Array.from(document.querySelectorAll<HTMLElement>('[role="checkbox"]'));
const press = (key: string) => act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const state = (els: HTMLElement[]) => els.map((el) => `${el.tabIndex}${el.getAttribute("aria-checked") === "true" ? "✓" : ""}`);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.call.mockReset().mockResolvedValue({});
  mocks.question = {
    itemId: "one", repo: "acme/app", issueNumber: 1, issueTitle: "Fix login", threadId: null, threadUrl: null, status: "waiting on human", stepId: "build", stepName: "Build", waitingKind: "question", waitingReason: null, report: null, decidable: false, lastMessage: null, checkOutput: null, lastError: null,
    open: [{ kind: "question", interactionId: "int-1", questions: [
      { id: "db", prompt: "Which database should it use?", shortLabel: "Database", options: ["postgres", "sqlite", "mysql"].map(option), allowFreeText: false, multiSelect: false, required: true },
      { id: "extras", prompt: "Which extras?", shortLabel: null, options: ["cache", "queue"].map(option), allowFreeText: false, multiSelect: true, required: false },
    ] }],
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<QuestionSheet itemId="one" onClose={() => {}} onAnswered={() => {}} />); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("makes a single-select group one tab stop that arrow keys move through", async () => {
  expect(document.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Database");
  expect(state(radios())).toEqual(["0", "-1", "-1"]);

  radios()[0]!.focus();
  await press("ArrowDown");
  expect(document.activeElement).toBe(radios()[1]);
  expect(state(radios())).toEqual(["-1", "0✓", "-1"]);
  await press("ArrowRight");
  await press("ArrowDown");
  expect(document.activeElement).toBe(radios()[0]);
  expect(state(radios())).toEqual(["0✓", "-1", "-1"]);
  await press("ArrowUp");
  expect(document.activeElement).toBe(radios()[2]);
  await press("ArrowLeft");
  expect(state(radios())).toEqual(["-1", "0✓", "-1"]);

  // Activating the checked option still clears it, as a click always has.
  await act(async () => { radios()[1]!.click(); });
  expect(state(radios())).toEqual(["0", "-1", "-1"]);
});

it("leaves every multi-select option a tab stop and sends what was picked", async () => {
  expect(document.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("Which extras?");
  expect(state(boxes())).toEqual(["0", "0"]);
  boxes()[1]!.focus();
  await press("ArrowUp");
  expect(document.activeElement).toBe(boxes()[1]);
  await act(async () => { boxes()[1]!.click(); });
  expect(state(boxes())).toEqual(["0", "0✓"]);

  radios()[0]!.focus();
  await press("ArrowDown");
  await act(async () => { Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Send answer"))!.click(); });
  expect(mocks.call).toHaveBeenCalledWith("cos_answer", { id: "one", answer: { kind: "question", interactionId: "int-1", answers: { db: { selected: ["sqlite"] }, extras: { selected: ["queue"] } } } });
});
