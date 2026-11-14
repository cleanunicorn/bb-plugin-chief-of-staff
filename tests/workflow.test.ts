import { describe, expect, it } from "vitest";
import { DEFAULT_DOCUMENT, DEFAULT_WORKFLOW, blankStep, normalizeWorkflow, problemKey, parseWorkflows, serializeWorkflows, validateDocument, workflowProblems, workflowSchema, type Workflow, type WorkflowsDocument } from "../src/workflow";

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

// ---------- workflowProblems: every reason the server would reject a draft ----------

type Draft = WorkflowsDocument & { workflows: (Workflow & { steps: Raw[] })[] };
const BASE = {
  default: "default",
  workflows: [
    workflowSchema.parse({
      id: "default",
      name: "Delivery",
      steps: [
        { id: "plan", name: "Plan", type: "agent", next: ["build"], chooses: [{ id: "fast", when: "small tasks", model: "haiku" }] },
        { id: "build", name: "Build", type: "agent", writes: true, next: ["test"] },
        { id: "test", name: "Test", type: "check", command: "npm test", onFail: "build", next: ["ship"] },
        { id: "ship", name: "Ship", type: "ship" },
      ],
    }),
  ],
} as WorkflowsDocument;
/** A copy of BASE with `edit` applied to it. */
const draft = (edit: (d: Draft) => void): WorkflowsDocument => {
  const d = structuredClone(BASE) as Draft;
  edit(d);
  return d;
};
const plan = (d: Draft) => d.workflows[0]!.steps[0]!;
const choice = (d: Draft) => (plan(d).chooses as Raw[])[0]!;
const choices = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, when: "x", model: "m" }));

const CASES: [string, (d: Draft) => void, Record<string, unknown>][] = [
  ["an empty workflow name", (d) => (d.workflows[0]!.name = ""), { workflow: 0, field: "name", message: "Name must not be empty", text: "Workflow 1: name must not be empty" }],
  ["a workflow name over 80 characters", (d) => (d.workflows[0]!.name = "x".repeat(81)), { workflow: 0, field: "name", message: "Name must be at most 80 characters" }],
  ["an empty step name", (d) => (d.workflows[0]!.steps[1]!.name = ""), { workflow: 0, step: 1, field: "name", message: "Name must not be empty", text: 'Workflow "Delivery" › step 2 (build): name must not be empty' }],
  ["a step name over 80 characters", (d) => (plan(d).name = "Plan (copy)".repeat(8)), { workflow: 0, step: 0, field: "name", message: "Name must be at most 80 characters" }],
  ["an empty “Use when”", (d) => (choice(d).when = ""), { workflow: 0, step: 0, choice: 0, field: "when", message: "“Use when” must not be empty", text: 'Workflow "Delivery" › step "Plan" › model choice 1: “Use when” must not be empty' }],
  ["a “Use when” over 1000 characters", (d) => (choice(d).when = "x".repeat(1001)), { step: 0, choice: 0, field: "when", message: "“Use when” must be at most 1,000 characters" }],
  ["an empty choice id", (d) => (choice(d).id = ""), { step: 0, choice: 0, field: "id", message: "Choice id must not be empty" }],
  ["a choice id starting with -", (d) => (choice(d).id = "-fast"), { step: 0, choice: 0, field: "id", message: "Choice id must start with a lowercase letter or digit, and use only lowercase letters, digits, - and _ (at most 40)" }],
  ["more than 12 model choices", (d) => (plan(d).chooses = choices(13)), { step: 0, field: "chooses", message: "Must have at most 12 model choices", text: 'Workflow "Delivery" › step "Plan": must have at most 12 model choices' }],
  ["an empty check command", (d) => (d.workflows[0]!.steps[2]!.command = ""), { step: 2, field: "command", message: "Command must not be empty" }],
  ["instructions over 20,000 characters", (d) => (plan(d).instructions = "x".repeat(20_001)), { step: 0, field: "instructions", message: "Instructions must be at most 20,000 characters" }],
  ["a choice model over 200 characters", (d) => (choice(d).model = "m".repeat(201)), { step: 0, choice: 0, field: "model", message: "Model must be at most 200 characters" }],
  ["a choice reasoning level over 50 characters", (d) => (choice(d).reasoningLevel = "r".repeat(51)), { step: 0, choice: 0, field: "reasoningLevel", message: "Reasoning level must be at most 50 characters" }],
  ["too many agents", (d) => (plan(d).agents = 5), { step: 0, field: "agents", message: "Agents in parallel must be at most 4" }],
  ["no agents", (d) => (plan(d).agents = 0), { step: 0, field: "agents", message: "Agents in parallel must be at least 1" }],
  ["agents that are not a number", (d) => (plan(d).agents = NaN), { step: 0, field: "agents", message: "Agents in parallel must be a number" }],
  ["a timeout over 240 minutes", (d) => (d.workflows[0]!.steps[2]!.timeoutMinutes = 300), { step: 2, field: "timeoutMinutes", message: "Timeout (minutes) must be at most 240" }],
  ["fractional rounds", (d) => (plan(d).maxRounds = 1.5), { step: 0, field: "maxRounds", message: "Rounds must be a whole number" }],
  ["too many attempts", (d) => (d.workflows[0]!.steps[2]!.maxAttempts = 11), { step: 2, field: "maxAttempts", message: "Attempts must be at most 10" }],
];

describe("workflowProblems", () => {
  it("finds nothing in the default document or a valid one", () => {
    expect(workflowProblems(DEFAULT_DOCUMENT)).toEqual([]);
    expect(workflowProblems(BASE)).toEqual([]);
  });

  it.each(CASES)("locates %s in readable words", (_, edit, expected) => {
    const problems = workflowProblems(draft(edit));
    expect(problems).toContainEqual(expect.objectContaining(expected));
    for (const p of problems) expect(p.text).not.toMatch(/workflows\.\d/);
  });

  it("names a step without a name by its number in the graph checks too", () => {
    const problems = workflowProblems(draft((d) => Object.assign(d.workflows[0]!.steps[2]!, { name: "", onFail: "ship" })));
    expect(problems).toContainEqual({ workflow: 0, step: 2, message: "step 3 (test): on fail must go back to a step before it (Ship is not)", text: 'Workflow "Delivery": step 3 (test): on fail must go back to a step before it (Ship is not)' });
  });

  it("locates every problem of an unconnected Check at that step", () => {
    const problems = workflowProblems({ default: "default", workflows: [{ ...DEFAULT_WORKFLOW, steps: [...DEFAULT_WORKFLOW.steps, blankStep("check", "new-check", "New check")] }] });
    expect(problems.map((p) => [p.step, p.message])).toEqual([
      [4, "New check: needs a step that writes code before it"],
      // A pair is located at its later step: the one just added, not the step it was always next to.
      [4, "Build and New check could run at the same time, but both change the worktree; connect one after the other"],
      [4, "Ship and New check could run at the same time, but both change the worktree; connect one after the other"],
    ]);
  });

  it("keys the same words at two steps as two problems", () => {
    const doc = draft((d) => {
      d.workflows[0]!.steps[1]!.name = "Same";
      d.workflows[0]!.steps[2]!.name = "Same";
      d.workflows[0]!.steps[1]!.instructions = "x".repeat(20_001);
      d.workflows[0]!.steps[2]!.instructions = "x".repeat(20_001);
    });
    const long = workflowProblems(doc).filter((p) => p.field === "instructions");
    expect(new Set(long.map((p) => p.text)).size).toBe(1);
    expect(new Set(long.map(problemKey)).size).toBe(2);
  });

  it("locates a duplicate step id at the second step and a loop at none", () => {
    const duplicate = workflowProblems(draft((d) => (d.workflows[0]!.steps[3]!.id = "build")));
    expect(duplicate).toContainEqual(expect.objectContaining({ workflow: 0, step: 3, message: 'two steps have the id "build"' }));
    const loop = workflowProblems(draft((d) => (d.workflows[0]!.steps[3]!.next = ["build"])));
    const arrows = loop.find((p) => p.message.startsWith("the arrows form a loop"))!;
    expect(arrows).toBeDefined();
    expect(arrows).not.toHaveProperty("step");
  });

  it("reports graph and document problems with the workflow they belong to", () => {
    const second = { ...structuredClone(BASE.workflows[0]!), name: "Copy" };
    const problems = workflowProblems({ default: "nope", workflows: [BASE.workflows[0]!, second] });
    expect(problems).toEqual([
      { message: 'Two workflows have the id "default"', text: 'Two workflows have the id "default"' },
      { message: 'The default workflow "nope" does not exist', text: 'The default workflow "nope" does not exist' },
    ]);
    const loop = draft((d) => (d.workflows[0]!.steps[3]!.next = ["build"]));
    expect(workflowProblems(loop)).toContainEqual(expect.objectContaining({ workflow: 0, text: expect.stringMatching(/^Workflow "Delivery": the arrows form a loop/) }));
  });

  it("keeps any issue it has no words for, with its path", () => {
    const problems = workflowProblems(draft((d) => (d.workflows[0]!.steps[3]!.action = "fly")));
    expect(problems).toContainEqual(expect.objectContaining({ workflow: 0, step: 3, field: "action", text: expect.stringMatching(/^Workflow "Delivery" › step "Ship": action: Invalid option/) }));
  });

  it("never throws, even on a document that is not one", () => {
    expect(workflowProblems({ workflows: "x", default: 1 } as unknown as WorkflowsDocument).length).toBeGreaterThan(0);
  });

  it("is empty exactly when the server accepts the document", () => {
    const fixtures: WorkflowsDocument[] = [
      DEFAULT_DOCUMENT,
      BASE,
      ...CASES.map(([, edit]) => draft(edit)),
      draft((d) => (d.workflows[0]!.steps[3]!.next = ["build"])),
      draft((d) => (d.default = "nope")),
      { default: "default", workflows: [BASE.workflows[0]!, { ...BASE.workflows[0]!, name: "Copy" }] },
      draft((d) => (choice(d).model = undefined)),
    ];
    for (const doc of fixtures) expect(workflowProblems(doc).length === 0).toBe(parseWorkflows(serializeWorkflows(doc)).ok);
  });
});

describe("validateDocument", () => {
  it("lists each duplicate id before that workflow's problems and the missing default last", () => {
    const loop = { ...structuredClone(BASE.workflows[0]!), name: "Loop" };
    (loop.steps[3] as Raw).next = ["build"];
    expect(validateDocument({ default: "nope", workflows: [BASE.workflows[0]!, loop] })).toEqual([
      'two workflows have the id "default"',
      "Loop: the arrows form a loop; use “on fail” to go back to an earlier step",
      'the default workflow "nope" does not exist',
    ]);
  });
});
