// @vitest-environment jsdom
// Throughput chart and view toggle on touch (#116). On a coarse pointer the 14 day columns are too narrow to tap,
// so the chart becomes one target that opens the table. jsdom has no layout: sizes are measured in a browser.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
import { ColumnChart, ViewToggle } from "../components/cos/viz";
import { POINTER_COARSE_QUERY } from "../components/ui/hooks/use-pointer-coarse";

let coarse = false;
function matchMedia(query: string) {
  return {
    get matches() { return query === POINTER_COARSE_QUERY && coarse; },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList;
}

const rows = Array.from({ length: 14 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, done: i % 3, failed: i % 2 }));
const series = [
  { key: "done", label: "Done", color: "#0c0" },
  { key: "failed", label: "Failed", color: "#c00" },
];

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | null = null;
async function mount(onShowTable?: () => void, onSelect?: (x: string) => void) {
  root = createRoot(container);
  await act(async () => { root!.render(<ColumnChart label="Throughput" rows={rows} series={series} xKey="date" formatX={(d) => d.slice(5)} onShowTable={onShowTable} onSelect={onSelect} />); });
}
const dayButtons = () => Array.from(container.querySelectorAll("button")).filter((b) => /^\d\d-\d\d: /.test(b.getAttribute("aria-label") ?? ""));
const showTable = () => container.querySelector<HTMLButtonElement>('button[aria-label="Show throughput as a table"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", matchMedia);
  document.body.append(container);
});
// Unmount every time: use-media-query caches a query's answer until its last subscriber leaves.
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; coarse = false; container.remove(); vi.unstubAllGlobals(); });

it("on a coarse pointer, makes the whole chart one button that opens the table", async () => {
  coarse = true;
  const onShowTable = vi.fn();
  await mount(onShowTable);
  expect(dayButtons()).toHaveLength(0);
  expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
  const button = showTable()!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
  expect(onShowTable).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="tooltip"]')).toBeNull();
});

it("on a coarse pointer, drops the hover and cursor styles from the inert columns", async () => {
  coarse = true;
  await mount(vi.fn());
  const plot = showTable()!.parentElement!;
  expect(plot.querySelector(".hover\\:bg-state-hover, .cursor-default")).toBeNull();
});

it("on a fine pointer, keeps one named image per day with its hover tooltip", async () => {
  await mount(vi.fn());
  // Days are images, not buttons: activating one would do nothing (#115). The table view has the same numbers.
  expect(dayButtons()).toHaveLength(0);
  const days = Array.from(container.querySelectorAll('[role="img"]')).filter((d) => /^\d\d-\d\d: /.test(d.getAttribute("aria-label") ?? ""));
  expect(days).toHaveLength(14);
  expect(days[0]!.getAttribute("aria-label")).toBe("11-01: Done 0, Failed 0");
  expect(showTable()).toBeNull();
  await act(async () => { days[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("11-02");
});

it("on a coarse pointer without onShowTable, leaves the columns inert and adds no chart button", async () => {
  coarse = true;
  await mount();
  expect(dayButtons()).toHaveLength(0);
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("spaces and enlarges the view toggle buttons on a coarse pointer, keeping the fine-pointer padding", async () => {
  root = createRoot(container);
  await act(async () => { root!.render(<ViewToggle table={false} onChange={() => {}} />); });
  const group = container.querySelector('[role="group"]')!;
  expect(group.className.split(/\s+/)).toContain("pointer-coarse:gap-1");
  for (const b of Array.from(group.querySelectorAll("button"))) {
    expect(b.className.split(/\s+/)).toEqual(expect.arrayContaining(["p-1", "pointer-coarse:p-2.5", "focus-visible:ring-1"]));
  }
});

it("with onSelect, makes each day a mouse-only button that selects it, named with its numbers", async () => {
  const onSelect = vi.fn();
  await mount(vi.fn(), onSelect);
  const days = dayButtons();
  expect(days).toHaveLength(14);
  // Not tab stops: keyboard users pick a day from the table view (#115).
  expect(days.every((b) => b.tabIndex === -1)).toBe(true);
  expect(days[2]!.getAttribute("aria-label")).toBe("11-03: Done 2, Failed 0");
  await act(async () => days[2]!.click());
  expect(onSelect).toHaveBeenCalledWith("2026-11-03");
  await act(async () => { days[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("11-02");
});

it("on a coarse pointer, keeps the columns inert even with onSelect, and the chart one button for the table", async () => {
  coarse = true;
  await mount(vi.fn(), vi.fn());
  expect(dayButtons()).toHaveLength(0);
  expect(showTable()).not.toBeNull();
});

it("names a selectable day by what clicking it does, then its numbers", async () => {
  root = createRoot(container);
  await act(async () => { root!.render(<ColumnChart label="Throughput" rows={rows} series={series} xKey="date" formatX={(d) => d.slice(5)} onSelect={vi.fn()} selectLabel={(d) => `Show tasks finished ${d.slice(5)}`} />); });
  const day = container.querySelectorAll("button[aria-label]")[2]!;
  expect(day.getAttribute("aria-label")).toBe("Show tasks finished 11-03 (Done 2, Failed 0)");
});
