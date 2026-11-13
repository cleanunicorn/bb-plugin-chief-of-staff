// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RosterStep } from "../src/roster";
import { container, mount, unmount } from "./dom";

vi.mock("../components/cos/viz", () => ({ STATUS: { good: "green", warning: "orange", serious: "red" }, usePalette: () => ({ accent: "blue" }) }));
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} /> }));

import { StepFlow, StepProgress } from "../components/cos/stepFlow";

afterEach(unmount);

function step(id: string, depth: number, status: RosterStep["status"], extra: Partial<RosterStep> = {}): RosterStep {
  return { id, name: id, depth, status, type: "agent", phase: null, agents: 1, reported: 0, nudged: 0, attempts: 0, round: 1, waitingKind: null, retrying: false, ...extra };
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** One row per step: [name, status label, details line, whether the status label is visible]. */
function rows() {
  return Array.from(container.querySelectorAll("ol li li")).map((li) => {
    const [, body, status] = Array.from(li.children);
    return { name: text(body?.firstElementChild), details: text(body?.children[1]), status: text(status), statusVisible: !status?.classList.contains("sr-only"), icon: li.querySelector("[data-icon]")?.getAttribute("data-icon") ?? null };
  });
}

describe("StepFlow", () => {
  const steps = [step("Plan", 0, "done"), step("A long unbroken step name".replaceAll(" ", ""), 1, "running", { agents: 2, reported: 1 }), step("Review plan", 1, "waiting"), step("Ship", 2, "pending")];

  it("lists every step in workflow order with its status; pending is announced, not shown", async () => {
    await mount(<StepFlow entry={{ workflowName: "Delivery", steps }} />);
    expect(container.querySelector("ol")!.getAttribute("aria-label")).toBe("Workflow Delivery");
    expect(rows().map(({ name, status, statusVisible }) => [name, status, statusVisible])).toEqual([
      ["Plan", "Done", true],
      ["Alongunbrokenstepname", "Running", true],
      ["Review plan", "Waiting", true],
      ["Ship", "Pending", false],
    ]);
    expect(rows()[1]!.details).toBe("1/2 agents");
  });

  it("groups steps that share a stage under an 'In parallel' box", async () => {
    await mount(<StepFlow entry={{ workflowName: "Delivery", steps }} />);
    const groups = Array.from(container.querySelectorAll("ol > li > div > ul, ol > li > ul")).map((ul) => [ul.getAttribute("aria-label"), ul.children.length]);
    expect(groups).toEqual([["Stage 1", 1], ["Parallel steps, stage 2", 2], ["Stage 3", 1]]);
    const parallel = container.querySelector('[aria-label="Parallel steps, stage 2"]')!.parentElement!;
    expect(text(parallel.firstElementChild)).toBe("In parallel");
  });

  it("wraps long names instead of truncating or scrolling", async () => {
    await mount(<StepFlow entry={{ workflowName: "Delivery", steps }} />);
    const name = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "Alongunbrokenstepname")!;
    expect(name.className).toContain("[overflow-wrap:anywhere]");
    expect(container.querySelector(".truncate, .overflow-x-auto")).toBeNull();
  });

  it("uses distinct glyphs for done, waiting and retrying steps", async () => {
    await mount(<StepFlow entry={{ workflowName: "Delivery", steps: [step("Plan", 0, "done"), step("Ask", 1, "waiting"), step("Ship", 2, "running", { retrying: true }), step("Docs", 3, "pending")] }} />);
    expect(rows().map((r) => r.icon)).toEqual(["Check", "Hand", "RefreshCw", null]);
  });

  it("shows a step a finished task left behind as stopped, not live", async () => {
    await mount(<StepFlow entry={{ workflowName: "Delivery", steps: [step("Build", 0, "done"), step("Ship", 1, "stopped")] }} />);
    expect(rows()[1]).toMatchObject({ name: "Ship", status: "Stopped", statusVisible: true, icon: "Square", details: "" });
    const name = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "Ship")!;
    expect(name.className).not.toContain("font-semibold");
    expect(rows().map((r) => r.icon)).toEqual(["Check", "Square"]);
  });

  it("shows retry, ship phase and failure details as readable text", async () => {
    await mount(<StepFlow entry={{ workflowName: "Delivery", steps: [step("Ship", 0, "running", { retrying: true, phase: "ci", attempts: 2 })] }} />);
    expect(rows()).toMatchObject([{ name: "Ship", status: "Retrying", details: "Waiting for CI · failed 2×" }]);
  });
});

describe("StepProgress", () => {
  const segments = () => Array.from(container.querySelectorAll<HTMLElement>("[data-state]"));

  it("renders one titled segment per step without claiming to be a progressbar", async () => {
    await mount(<StepProgress steps={[step("Plan", 0, "done"), step("Build", 1, "running"), step("Review", 2, "waiting"), step("Ship", 3, "pending"), step("Fix", 4, "running", { retrying: true })]} />);
    expect(segments().map((s) => s.title)).toEqual(["Plan: done", "Build: running", "Review: waiting", "Ship: pending", "Fix: retrying"]);
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("keeps every step even for long workflows", async () => {
    await mount(<StepProgress steps={Array.from({ length: 15 }, (_, i) => step(`Step ${i}`, i, "pending"))} />);
    expect(segments()).toHaveLength(15);
  });

  it("tells states apart by shape, not only by color", async () => {
    await mount(<StepProgress steps={[step("Plan", 0, "done"), step("Build", 1, "running"), step("Review", 2, "waiting"), step("Ship", 3, "pending")]} />);
    const [done, running, waiting, pending] = segments();
    // Live steps stand taller than finished and pending ones.
    expect(done!.classList).toContain("h-1.5");
    expect(running!.classList).toContain("h-2.5");
    expect(waiting!.classList).toContain("h-2.5");
    expect(pending!.classList).toContain("h-1.5");
    // Done is solid, waiting is striped, pending is a hollow outline.
    expect(done!.getAttribute("style")).toMatch(/background:\s*green/);
    expect(waiting!.getAttribute("style")).toContain("repeating-linear-gradient");
    expect(pending!.getAttribute("style")).toContain("inset 0 0 0 1px");
    expect(pending!.getAttribute("style")).not.toContain("background");
  });

  it("draws a stopped step as a short, still, muted bar", async () => {
    await mount(<StepProgress steps={[step("Build", 0, "done"), step("Ship", 1, "stopped"), step("Docs", 2, "pending")]} />);
    const [done, stopped] = segments();
    expect(stopped!.dataset.state).toBe("stopped");
    expect(stopped!.title).toBe("Ship: stopped");
    // Shorter than done and pending; never tall, pulsing or striped like a live step.
    expect(stopped!.classList).toContain("h-1");
    expect(stopped!.classList).not.toContain("h-2.5");
    expect(stopped!.classList).not.toContain("motion-safe:animate-pulse");
    expect(stopped!.getAttribute("style")).toContain("var(--muted-foreground)");
    expect(stopped!.getAttribute("style")).not.toContain("repeating-linear-gradient");
    expect(done!.classList).toContain("h-1.5");
  });
});
