import { describe, expect, it } from "vitest";
import { findSkillRefs, isReferenceable, matchSkills, referencedSkills, skillMentions, skillQueryAt } from "../src/skills";

describe("skill references in instructions", () => {
  it("finds /skill tokens at word starts and ignores paths and URLs", () => {
    const text = "/tdd first. Then use (/agents-library:review), not src/app or /usr/bin or https://x.io/a.";
    expect(findSkillRefs(text).map((r) => [r.name, text.slice(r.start, r.end)])).toEqual([
      ["tdd", "/tdd"],
      ["agents-library:review", "/agents-library:review"],
    ]);
  });

  it("drops sentence punctuation after the name", () => {
    expect(referencedSkills("Run /verify. Then /ship: done, and /verify again")).toEqual(["verify", "ship"]);
  });

  it("mentions only known skills, only inside the instructions", () => {
    const instructions = "Use /tdd, then /unknown.";
    const text = `Brief mentions /tdd too\n\n### Instructions\n${instructions}\n\n### Input\nreport says /tdd`;
    const mentions = skillMentions(text, instructions, [{ name: "tdd", scope: "bb-project" }]);
    expect(mentions).toHaveLength(1);
    const [m] = mentions;
    expect(text.slice(m!.start, m!.end)).toBe("/tdd");
    expect(m!.start).toBe(text.indexOf(instructions) + 4);
    expect(m!.resource).toMatchObject({ kind: "command", source: "skill", trigger: "/", name: "tdd", origin: "project" });
  });

  it("has nothing to mention without skills or a reference", () => {
    expect(skillMentions("### Instructions\nUse /tdd", "Use /tdd", [])).toEqual([]);
    expect(skillMentions("### Instructions\nplain", "plain", [{ name: "tdd" }])).toEqual([]);
  });

  it("reads the query the caret is typing", () => {
    expect(skillQueryAt("Use /re", 7)).toEqual({ query: "re", start: 4 });
    expect(skillQueryAt("/", 1)).toEqual({ query: "", start: 0 });
    expect(skillQueryAt("src/re", 6)).toBeNull();
    expect(skillQueryAt("Use re", 6)).toBeNull();
  });

  it("ranks name prefixes before other matches", () => {
    const skills = [{ name: "code-review" }, { name: "review" }, { name: "plan", description: "Review a plan" }];
    expect(matchSkills(skills, "rev").map((s) => s.name)).toEqual(["review", "code-review", "plan"]);
    expect(matchSkills(skills, "").map((s) => s.name)).toEqual(["code-review", "review", "plan"]);
  });

  it("skips names that would not read back as a reference", () => {
    expect(isReferenceable("agents-library:build")).toBe(true);
    expect(isReferenceable(".replaced-123")).toBe(false);
    expect(isReferenceable("weird:")).toBe(false);
  });
});
