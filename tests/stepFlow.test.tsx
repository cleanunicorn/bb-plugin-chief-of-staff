import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RosterStep } from "../src/roster";

vi.mock("../components/cos/viz", () => ({ STATUS: { good: "green", warning: "orange", serious: "red" }, usePalette: () => ({ accent: "blue" }) }));
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} /> }));

import { StepFlow, StepProgress } from "../components/cos/stepFlow";

function step(id: string, depth: number, status: RosterStep["status"], extra: Partial<RosterStep> = {}): RosterStep {
  return { id, name: id, depth, status, type: "agent", phase: null, agents: 1, reported: 0, nudged: 0, attempts: 0, round: 1, waitingKind: null, retrying: false, ...extra };
}

describe("StepFlow", () => {
  const steps = [step("Plan", 0, "done"), step("A long unbroken step name".replaceAll(" ", ""), 1, "running", { agents: 2, reported: 1 }), step("Review plan", 1, "waiting"), step("Ship", 2, "pending")];

  it("lists every step in workflow order with a visible status", () => {
    const html = renderToStaticMarkup(<StepFlow entry={{ workflowName: "Delivery", steps }} />);
    expect(html).toContain('aria-label="Workflow Delivery"');
    const order = ["Plan", "Alongunbrokenstepname", "Review plan", "Ship"].map((name) => html.indexOf(`>${name}<`));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(html).toMatch(/>Plan<[^]*?>Done</);
    expect(html).toMatch(/>Alongunbrokenstepname<[^]*?>Running</);
    expect(html).toMatch(/>Review plan<[^]*?>Waiting</);
    expect(html).toMatch(/>Ship<[^]*?>Pending</);
    expect(html).toContain("1/2 agents");
  });

  it("groups steps that share a stage as running in parallel", () => {
    const html = renderToStaticMarkup(<StepFlow entry={{ workflowName: "Delivery", steps }} />);
    expect(html).toContain('aria-label="Parallel steps, stage 2"');
    expect(html).toContain("In parallel");
    expect(html).toContain('aria-label="Stage 1"');
  });

  it("wraps long names instead of truncating or scrolling", () => {
    const html = renderToStaticMarkup(<StepFlow entry={{ workflowName: "Delivery", steps }} />);
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).not.toContain("truncate");
    expect(html).not.toContain("overflow-x-auto");
  });

  it("uses distinct glyphs for done, waiting and retrying steps", () => {
    const html = renderToStaticMarkup(<StepFlow entry={{ workflowName: "Delivery", steps: [step("Plan", 0, "done"), step("Ask", 1, "waiting"), step("Ship", 2, "running", { retrying: true })] }} />);
    expect(html).toContain('data-icon="Check"');
    expect(html).toContain('data-icon="Hand"');
    expect(html).toContain('data-icon="RefreshCw"');
  });

  it("preserves retry, phase and failure details as readable text", () => {
    const html = renderToStaticMarkup(<StepFlow entry={{ workflowName: "Delivery", steps: [step("Ship", 0, "running", { retrying: true, phase: "ci", attempts: 2 })] }} />);
    expect(html).toContain("Retrying");
    expect(html).toContain("ci");
    expect(html).toContain("failed 2×");
  });
});

describe("StepProgress", () => {
  it("renders one titled segment per step without claiming to be a progressbar", () => {
    const html = renderToStaticMarkup(<StepProgress steps={[step("Plan", 0, "done"), step("Build", 1, "running"), step("Review", 2, "waiting"), step("Ship", 3, "pending"), step("Fix", 4, "running", { retrying: true })]} />);
    for (const [name, status] of [["Plan", "done"], ["Build", "running"], ["Review", "waiting"], ["Ship", "pending"], ["Fix", "retrying"]]) {
      expect(html).toContain(`title="${name}: ${status}"`);
    }
    expect(html).not.toContain("progressbar");
  });

  it("keeps every step even for long workflows", () => {
    const html = renderToStaticMarkup(<StepProgress steps={Array.from({ length: 15 }, (_, i) => step(`Step ${i}`, i, "pending"))} />);
    expect(html.match(/title="Step \d+: pending"/g)).toHaveLength(15);
  });
});
