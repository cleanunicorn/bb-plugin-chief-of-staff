import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RosterStep } from "../src/roster";
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} /> }));
import { StepMiniMap } from "../components/cos/taskVisuals";

function step(id: string, status: RosterStep["status"], retrying = false): RosterStep {
  return { id, name: id, status, retrying, type: "agent", depth: 0, phase: null, agents: 1, reported: 0, nudged: 0, attempts: 0, round: 1, waitingKind: null };
}
it("uses distinct shapes for actual completed, running, waiting and pending states", () => {
  const html = renderToStaticMarkup(<StepMiniMap steps={[step("Plan", "done"), step("Build", "running"), step("Review", "waiting"), step("Ship", "pending")]} />);
  for (const [name, status, icon] of [["Plan", "done", "Check"], ["Build", "running", "Play"], ["Review", "waiting", "Hand"], ["Ship", "pending", "Circle"]]) {
    expect(html).toMatch(new RegExp(`title="${name}: ${status}"[^]*?data-icon="${icon}"`));
  }
  expect(html).not.toContain("progressbar");
});
it("marks a retry as retrying and explicitly counts omitted steps", () => {
  const html = renderToStaticMarkup(<StepMiniMap steps={Array.from({ length: 15 }, (_, i) => step(`Step ${i}`, "running", true))} />);
  expect(html).toContain('title="Step 0: retrying"');
  expect(html).toContain('data-icon="RefreshCw"');
  expect(html).toContain("+3");
});
