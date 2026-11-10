// @vitest-environment jsdom
// The answer sheet on its own: a sent reply clears so it cannot go twice.
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount, setValue, tick, unmount } from "./dom";

const mocks = vi.hoisted(() => ({ question: {} as Record<string, unknown>, call: vi.fn(), navigate: { toThread: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => mocks.navigate,
  useRpc: () => ({ call: mocks.call }),
  experimental_useRpcQuery: () => ({ data: mocks.question, error: null, refetch: vi.fn() }),
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
import { QuestionSheet } from "../components/cos/question";

const onClose = vi.fn();
const base = { itemId: "one", repo: "acme/app", issueNumber: 1, issueTitle: "Fix login", threadId: "thread-1", threadUrl: null, status: "waiting on human", stepId: "build", stepName: "Build", waitingKind: null, waitingReason: null, report: null, decidable: false, open: [], lastMessage: null, checkOutput: null, lastError: null };

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const dialogs = () => document.querySelectorAll('[role="dialog"]');
const textarea = (index = 0) => sheet()!.querySelectorAll("textarea")[index]!;
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label)!;
const answers = () => mocks.call.mock.calls.filter(([method]) => method === "cos_answer");
const ctrlEnter = (el: Element) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })); });

beforeEach(() => {
  mocks.question = { ...base };
  mocks.call.mockReset().mockResolvedValue({});
  onClose.mockReset();
  mocks.navigate.toThread.mockReset();
});
afterEach(async () => { await unmount(); await tick(5); document.body.replaceChildren(); });

const open = () => mount(<QuestionSheet itemId="one" onClose={onClose} onAnswered={() => {}} />);

it("clears a sent message, so neither Send nor Ctrl+Enter can send it again", async () => {
  await open();
  await setValue(textarea(), "Use Postgres");
  await act(async () => button("Send").click());
  expect(answers()).toEqual([["cos_answer", { id: "one", answer: { kind: "text", text: "Use Postgres" } }]]);
  expect(textarea().value).toBe("");
  expect(button("Send").disabled).toBe(true);
  await ctrlEnter(textarea());
  await act(async () => button("Send").click());
  expect(answers()).toHaveLength(1);
});

it("keeps the message when sending fails", async () => {
  mocks.call.mockRejectedValue(new Error("thread is gone"));
  await open();
  await setValue(textarea(), "Use Postgres");
  await ctrlEnter(textarea());
  expect(answers()).toHaveLength(1);
  expect(textarea().value).toBe("Use Postgres");
  expect(sheet()!.textContent).toContain("thread is gone");
});

it("clears a reply to the agent's question once it is sent", async () => {
  mocks.question = { ...base, open: [{ kind: "text", question: "Which database?" }] };
  await open();
  await setValue(textarea(), "Postgres");
  await act(async () => button("Send").click());
  expect(answers()).toHaveLength(1);
  expect(textarea().value).toBe("");
});

it("resets a question form once its answers are sent", async () => {
  mocks.question = { ...base, open: [{ kind: "question", interactionId: "i-1", questions: [{ id: "db", prompt: "Which database?", options: [{ value: "pg", label: "Postgres" }], multiSelect: false, allowFreeText: true, required: true }] }] };
  await open();
  await act(async () => button("Postgres").click());
  await setValue(textarea(), "and add an index");
  await act(async () => button("Send answer").click());
  expect(answers()).toEqual([["cos_answer", { id: "one", answer: { kind: "question", interactionId: "i-1", answers: { db: { selected: ["pg"], freeText: "and add an index" } } } }]]);
  expect(textarea().value).toBe("");
  expect(button("Postgres").getAttribute("aria-checked")).toBe("false");
  expect(button("Send answer").disabled).toBe(true);
});

it("clears feedback once it is sent back, and keeps it when sending fails", async () => {
  mocks.question = { ...base, decidable: true, waitingKind: "approval", report: "Plan" };
  mocks.call.mockRejectedValueOnce(new Error("offline"));
  await open();
  await setValue(textarea(), "Split the migration");
  await act(async () => button("Send back").click());
  expect(textarea().value).toBe("Split the migration");
  await act(async () => button("Send back").click());
  expect(answers()).toHaveLength(2);
  expect(answers()[1]).toEqual(["cos_answer", { id: "one", answer: { kind: "revise", feedback: "Split the migration" } }]);
});

it("approves on one click, without asking", async () => {
  mocks.question = { ...base, decidable: true, waitingKind: "approval", report: "Plan" };
  await open();
  await act(async () => button("Approve").click());
  expect(dialogs()).toHaveLength(1);
  expect(answers()).toEqual([["cos_answer", { id: "one", answer: { kind: "approve" } }]]);
});
