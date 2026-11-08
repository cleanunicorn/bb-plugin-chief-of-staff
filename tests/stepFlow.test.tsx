import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RosterStep } from "../src/roster";

vi.mock("../components/cos/viz", () => ({ STATUS: { good: "green", warning: "orange", serious: "red" }, usePalette: () => ({ accent: "blue" }) }));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));

import { StepFlow } from "../components/cos/stepFlow";

function step(id: string, depth: number, status: RosterStep["status"], extra: Partial<RosterStep> = {}): RosterStep {
  return { id, name: id, depth, status, type: "agent", phase: null, agents: 1, reported: 0, nudged: 0, attempts: 0, round: 1, waitingKind: null, retrying: false, ...extra };
}

describe("StepFlow", () => {
  it("renders complete names and visible statuses in ordered parallel groups", () => {
    const steps = [step("Plan", 0, "done"), step("A long unbroken step name".replaceAll(" ", ""), 1, "running", { agents: 2, reported: 1 }), step("Review plan", 1, "waiting"), step("Ship", 2, "pending")];
    const html = renderToStaticMarkup(<StepFlow entry={{ workflowName: "Delivery", steps }} />);
    expect(html).toContain('aria-label="Workflow Delivery"');
    expect(html).toContain('aria-label="Parallel steps, stage 2"');
    expect(html).toMatch(/Plan<\/span> · <span>Done/);
    expect(html).toMatch(/Alongunbrokenstepname<\/span> · <span>Running/);
    expect(html).toContain("1/2 agents");
    expect(html).toMatch(/Review plan<\/span> · <span>Waiting/);
    expect(html).toMatch(/Ship<\/span> · <span>Pending/);
    expect(html).toContain("flex-wrap");
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).not.toContain("truncate");
    expect(html).not.toContain("overflow-x-auto");
  });

  it("preserves retry, phase and failure details as readable text", () => {
    const html = renderToStaticMarkup(<StepFlow entry={{ workflowName: "Delivery", steps: [step("Ship", 0, "running", { retrying: true, phase: "ci", attempts: 2 })] }} />);
    expect(html).toContain("Retrying");
    expect(html).toContain("(ci)");
    expect(html).toContain("failed 2×");
  });
});
