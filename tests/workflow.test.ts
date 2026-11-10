import { describe, expect, it } from "vitest";
import { normalizeWorkflow, type Workflow } from "../src/workflow";

type Raw = Record<string, unknown>;
const wf = (steps: unknown[]) => ({ id: "w", name: "w", steps }) as unknown as Workflow;
const steps = (raw: unknown[]) => normalizeWorkflow(wf(raw)).steps as unknown as Raw[];

describe("normalizeWorkflow", () => {
  it("adds chooses and next to an old agent step", () => {
    const [s] = steps([{ id: "a", name: "A", type: "agent" }]);
    expect(s.chooses).toEqual([]);
    expect(s.next).toEqual([]);
  });

  it("repairs a step that fails the schema, keeping its valid values, without mutating the input", () => {
    const raw: Raw = { id: "a", name: "A", type: "agent", instructions: "x".repeat(20_001), next: ["b"] };
    const [s] = steps([raw]);
    expect(s).toMatchObject({ chooses: [], next: ["b"], agents: 1, writes: false, maxRounds: 2 });
    expect(s.instructions).toBe(raw.instructions); // too long, but still a string: kept
    expect(raw.chooses).toBeUndefined();
  });

  it("replaces wrongly typed fields with their defaults and drops invalid list entries", () => {
    const choice = { id: "fast", when: "small tasks" };
    const [s] = steps([{ id: "a", name: "A", type: "agent", instructions: 5, agents: "two", onFail: 5, position: "top", next: ["b", null, "Bad Id"], chooses: [null, choice, { id: "x" }] }]);
    expect(s).toMatchObject({ instructions: "", agents: 1, next: ["b"], chooses: [choice] });
    expect(s).not.toHaveProperty("onFail");
    expect(s).not.toHaveProperty("position");
  });

  it("repairs check and ship steps from their own schemas", () => {
    const [check, ship] = steps([
      { id: "c", name: "C", type: "check", command: "npm test", timeoutMinutes: 999, next: null },
      { id: "s", name: "S", type: "ship", action: "teleport" },
    ]);
    expect(check).toMatchObject({ next: [], timeoutMinutes: 999, maxAttempts: 2 });
    expect(ship).toMatchObject({ next: [], instructions: "", draft: false, requireApproval: true });
  });

  it("writes down the mode of legacy model steps", () => {
    const [fixed, auto] = steps([
      { id: "m", name: "M", type: "model", model: "opus" },
      { id: "n", name: "N", type: "model" },
    ]);
    expect(fixed.mode).toBe("fixed");
    expect(auto.mode).toBe("auto");
  });

  it("coerces next on unknown types and leaves other fields alone", () => {
    const [s] = steps([{ id: "a", name: "A", type: "future", foo: 1 }]);
    expect(s.next).toEqual([]);
    expect(s.chooses).toBeUndefined();
    expect(s.foo).toBe(1);
  });

  it("returns non-object steps unchanged", () => {
    expect(normalizeWorkflow(wf([null, "x"])).steps).toEqual([null, "x"]);
  });
});
