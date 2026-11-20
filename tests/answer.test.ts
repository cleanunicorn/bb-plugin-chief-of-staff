import { describe, expect, it } from "vitest";
import { earlierReports, markdownTail, textQuestion, toOpenQuestion } from "../src/answer";
import { initialNodes } from "../src/machine";
import { REMOVED_SUMMARY } from "../src/state";
import { DEFAULT_WORKFLOW } from "../src/workflow";

describe("markdownTail", () => {
  it("leaves short text alone", () => {
    expect(markdownTail("# hi\n\nshort", 100)).toBe("# hi\n\nshort");
  });

  it("cuts at a line break so the tail starts on a whole line", () => {
    const text = `${"intro line\n".repeat(50)}## Findings\n\n- one\n- two`;
    const out = markdownTail(text, 60)!;
    expect(out.startsWith("…\n\n")).toBe(true);
    expect(out).toContain("## Findings");
    expect(out.split("\n")[2]).toMatch(/^(intro line|## Findings|- one|)$/);
  });

  it("reopens a code fence when the cut lands inside one", () => {
    const text = `Before\n\n\`\`\`ts\n${"const x = 1;\n".repeat(40)}\`\`\`\n\nAfter`;
    const out = markdownTail(text, 80)!;
    expect(out.startsWith("…\n\n```\n")).toBe(true);
    expect(out.endsWith("```\n\nAfter")).toBe(true);
  });

  it("does not add a fence when the cut is outside one", () => {
    const text = `\`\`\`\ncode\n\`\`\`\n${"plain text line\n".repeat(40)}end`;
    expect(markdownTail(text, 80)!.startsWith("…\n\n```")).toBe(false);
  });
});

describe("toOpenQuestion", () => {
  it("marks plan approvals as Markdown and commands as plain", () => {
    const plan = toOpenQuestion({ id: "a", payload: { kind: "approval", subject: { kind: "plan", plan: "## Plan\n\n1. Do it" } } });
    const cmd = toOpenQuestion({ id: "b", payload: { kind: "approval", subject: { kind: "command", command: "ls" } } });
    expect(plan).toMatchObject({ kind: "approval", detailMarkdown: true, detail: "## Plan\n\n1. Do it" });
    expect(cmd).toMatchObject({ kind: "approval", detailMarkdown: false, detail: "ls" });
  });
});

describe("earlierReports", () => {
  const at = "2026-11-20T10:00:00.000Z";
  const done = (summaries: (string | null)[]) => ({ status: "done" as const, reports: summaries.map((summary) => (summary === null ? null : { outcome: "done" as const, summary, at, via: "tool" as const })) });

  it("lists finished steps' reports in workflow order, without the waiting step's own", () => {
    const nodes = initialNodes(DEFAULT_WORKFLOW);
    const [first, second] = DEFAULT_WORKFLOW.steps;
    Object.assign(nodes[first!.id]!, done(["## Plan\n\nUse Postgres."]));
    Object.assign(nodes[second!.id]!, { status: "waiting", reports: [{ outcome: "done", summary: "half done", at, via: "tool" }] });
    expect(earlierReports({ workflow: DEFAULT_WORKFLOW, nodes }, second!.id)).toEqual([{ step: first!.name, summary: "## Plan\n\nUse Postgres." }]);
  });

  it("labels each agent of a multi-agent step and skips removed summaries", () => {
    const nodes = initialNodes(DEFAULT_WORKFLOW);
    const [first, second] = DEFAULT_WORKFLOW.steps;
    Object.assign(nodes[first!.id]!, done(["one", null, "two"]));
    Object.assign(nodes[second!.id]!, done([REMOVED_SUMMARY]));
    expect(earlierReports({ workflow: DEFAULT_WORKFLOW, nodes }, null)).toEqual([{ step: first!.name, summary: "### Agent 1\none\n\n### Agent 2\ntwo" }]);
  });
});

describe("textQuestion", () => {
  it("prefers the full question the step kept", () => {
    expect(textQuestion({ kind: "question", reason: "Which…", question: "Which database, and why?" }, "Done?")).toBe("Which database, and why?");
  });

  it("otherwise asks what the step recorded, not a later question in the agent's last message", () => {
    expect(textQuestion({ kind: "question", reason: "Question: Which DB?" }, "I looked around.\n\nShould I keep v1?")).toBe("Which DB?");
    expect(textQuestion({ kind: "question", reason: "Keep v1 or drop it" }, "Reported. Anything else?")).toBe("Keep v1 or drop it");
    expect(textQuestion({ kind: "question", reason: "" }, "I looked around.\n\nShould I keep v1?")).toBe("Should I keep v1?");
  });

  it("asks nothing for an interaction that is gone: its summary is not a question to reply to", () => {
    expect(textQuestion({ kind: "question", reason: "Run npm install?", interaction: true }, "Should I keep v1?")).toBeNull();
  });
});
