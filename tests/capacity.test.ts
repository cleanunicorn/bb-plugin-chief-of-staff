import { describe, expect, it } from "vitest";
import { occupiesCapacity, type WorkItem } from "../src/state";
import { freshNode } from "../src/machine";
import { workflowSchema } from "../src/workflow";

const workflow = workflowSchema.parse({ id: "test", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
  { id: "ship", name: "Ship", type: "ship", action: "merge" },
  { id: "docs", name: "Docs", type: "agent" },
] });
function item(phase: "ci" | "ready" | "merging" | "pushing", parallel = false): WorkItem {
  return { status: "ready", workflow, nodes: {
    build: { ...freshNode(), status: "done" },
    ship: { ...freshNode(), status: "running", phase },
    docs: { ...freshNode(), status: parallel ? "running" : "done" },
  } } as WorkItem;
}

describe("capacity reservations", () => {
  it.each(["ci", "ready", "merging"] as const)("releases a task waiting in ship phase %s", (phase) => {
    expect(occupiesCapacity(item(phase))).toBe(false);
    expect(occupiesCapacity(item(phase, true))).toBe(true);
  });
  it("keeps pushing reserved, but releases ship human decisions", () => {
    const waiting = item("pushing");
    expect(occupiesCapacity(waiting)).toBe(true);
    waiting.nodes.ship = { ...waiting.nodes.ship!, status: "waiting" };
    expect(occupiesCapacity(waiting)).toBe(false);
    waiting.nodes.build = { ...freshNode(), status: "waiting" };
    expect(occupiesCapacity(waiting)).toBe(true);
  });
});
