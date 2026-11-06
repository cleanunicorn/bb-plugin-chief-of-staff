import { describe, expect, it } from "vitest";
import { markdownTail, toOpenQuestion } from "../src/answer";

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
