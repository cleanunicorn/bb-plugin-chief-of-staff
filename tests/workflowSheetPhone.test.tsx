// @vitest-environment jsdom
// Below Tailwind's `sm` the workflow sheet gives the task line its own row, shows the view switch as icons,
// and scrolls the canvas and the overview as one column (#118). jsdom has no layout, so this checks the
// structure and classes; the real bounds at 390×844 are measured in a browser (docs/dashboard-validation.md).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import { stubReactFlowDom } from "./helpers/reactFlow";

const mocks = vi.hoisted(() => ({ entries: [] as unknown[], workflow: {} as unknown, call: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: () => ({}),
  useBbNavigate: () => ({ toThread: vi.fn() }),
  useRpc: () => ({ call: mocks.call }),
  useRealtime: () => {},
  experimental_useRpcQuery: ({ method }: { method: string }) => ({
    data: method === "cos_roster" ? { entries: mocks.entries } : method === "cos_item_workflow" ? mocks.workflow : method === "cos_stats" ? { doneInWindow: 0, failedInWindow: 0, medianCycleMinutes: null, daily: [] } : { paused: false, repos: [], occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 } },
    error: null, refetch: vi.fn(),
  }),
  ThreadTitle: () => null, UrlLink: () => null, Markdown: ({ content }: { content: string }) => content,
}));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("@xyflow/react/dist/style.css", () => ({}));
import { PHONE_VIEWPORT_QUERY, PipelineTab, SHORT_VIEWPORT_QUERY } from "../app";
import { entry } from "./helpers/roster";

const TITLE = "cleanunicorn/bb-plugin-chief-of-staff#118 Workflow sheet header hides the task name at phone width";

/** A matchMedia whose answer for PHONE_VIEWPORT_QUERY the test flips, firing "change" like a resize does. */
let phone = true;
const listeners = new Set<() => void>();
function matchMedia(query: string) {
  return {
    get matches() { return query === PHONE_VIEWPORT_QUERY && phone; },
    media: query,
    addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
  } as unknown as MediaQueryList;
}
const resize = (to: boolean) => act(async () => { phone = to; for (const fn of [...listeners]) fn(); });

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const taskLine = () => dialog().querySelector<HTMLElement>("header p[title]")!;
const title = () => Array.from(dialog().querySelectorAll<HTMLElement>("header *")).find((el) => el.textContent === "Where this task is")!;
const close = () => dialog().querySelector<HTMLElement>('button[aria-label="Close"]')!;
const button = (text: string) => Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!;
const canvas = () => dialog().querySelector<HTMLElement>(".react-flow")!.parentElement!.parentElement!;
const aside = () => dialog().querySelector<HTMLElement>("aside")!;
const row = () => aside().parentElement!;
const footer = () => dialog().querySelector<HTMLElement>("footer");
const classes = (el: HTMLElement) => el.className.split(/\s+/);
const click = (el: HTMLElement) => act(async () => { el.click(); });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubReactFlowDom();
  phone = true;
  listeners.clear();
  vi.stubGlobal("matchMedia", matchMedia);
  mocks.entries = [entry()];
  mocks.workflow = { title: TITLE, workflow: DEFAULT_WORKFLOW, live: {} };
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<PipelineTab />); });
  await click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Workflow")!);
});
afterEach(async () => { await act(async () => { root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("never matches together with the short-viewport query", () => {
  expect(PHONE_VIEWPORT_QUERY).toBe("not all and (min-width: 40rem)");
  expect(SHORT_VIEWPORT_QUERY).toContain("(min-width: 40rem)");
});

it("gives the task line its own full-width row below the title and the controls", () => {
  const line = taskLine();
  expect(line.textContent).toContain(TITLE);
  expect(line.title).toContain(TITLE);
  expect(classes(line)).toEqual(expect.arrayContaining(["line-clamp-3", "[overflow-wrap:anywhere]"]));
  expect(classes(line)).not.toContain("line-clamp-2");
  // The title shares its row with Close; the task line is not in that row.
  const titleRow = title().parentElement!;
  expect(titleRow.contains(close())).toBe(true);
  expect(titleRow.contains(line)).toBe(false);
  expect(classes(titleRow)).toContain("flex-wrap");
  // Basis auto: the controls drop to a second line before the title is squeezed.
  expect(classes(title())).toEqual(expect.arrayContaining(["min-w-0", "flex-auto"]));
  expect(titleRow.nextElementSibling).toBe(line);
});

it("restores the wide header when the viewport grows past sm", async () => {
  await resize(false);
  const line = taskLine();
  expect(classes(line)).toContain("line-clamp-2");
  expect(line.nextElementSibling).toBe(title());
  expect(line.parentElement!.contains(close())).toBe(false);
  expect(button("Canvas").querySelector(".sr-only")).toBeNull();
});

it("shows the view switch as icons, named by their text", async () => {
  for (const name of ["Canvas", "List"]) {
    const b = button(name);
    expect(b.querySelector(".sr-only")?.textContent).toBe(name);
    expect(b.hasAttribute("aria-label")).toBe(false);
    expect(classes(b)).toEqual(expect.arrayContaining(["size-9", "justify-center"]));
  }
  expect(button("Canvas").getAttribute("aria-pressed")).toBe("true");
  await click(button("List"));
  expect(button("List").getAttribute("aria-pressed")).toBe("true");
  expect(button("Canvas").getAttribute("aria-pressed")).toBe("false");
});

it("scrolls the canvas and the overview as one column, with no footer until a step is selected", async () => {
  expect(classes(row())).toEqual(expect.arrayContaining(["flex-col", "overflow-y-auto", "overscroll-contain"]));
  expect(classes(row()).some((c) => c.startsWith("md:"))).toBe(false);
  expect(classes(canvas())).toEqual(expect.arrayContaining(["h-[min(45dvh,24rem)]", "min-h-[16rem]", "flex-none"]));
  expect(classes(canvas())).not.toContain("flex-1");
  expect(classes(aside()).some((c) => c.startsWith("max-h-") || c.startsWith("md:") || c === "overflow-y-auto")).toBe(false);
  expect(classes(aside())).toContain("shrink-0");
  expect(footer()).toBeNull();

  await click(button("List"));
  const list = dialog().querySelector<HTMLElement>('ol[aria-label="Workflow steps"]')!;
  expect(classes(list)).toContain("flex-none");
  expect(classes(list)).not.toContain("overflow-y-auto");
  await click(Array.from(list.querySelectorAll("button"))[0]);
  expect(footer()).not.toBeNull();
  expect(footer()!.textContent).toContain("Run again from here");
  expect(row().contains(footer())).toBe(false);
});

it("brings the step panel into view when a selection puts it below the visible part of the column", async () => {
  // jsdom does not implement scrollIntoView.
  const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
  const original = proto.scrollIntoView;
  const scrollIntoView = vi.fn();
  proto.scrollIntoView = scrollIntoView;
  let asideTop = 900;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "ASIDE") return { top: asideTop, bottom: asideTop + 400 } as DOMRect;
    if (this === row()) return { top: 200, bottom: 800 } as DOMRect;
    return { top: 0, bottom: 0 } as DOMRect;
  });
  await click(button("List"));
  const steps = () => Array.from(dialog().querySelectorAll<HTMLElement>('ol[aria-label="Workflow steps"] button'));
  await click(steps().at(-1)!);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  // Already visible: leave the scroll position alone.
  asideTop = 500;
  await click(steps()[0]);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  proto.scrollIntoView = original;
});

it("keeps the fill layout in Full screen, with only the phone header and no footer hint", async () => {
  await click(button("Full screen"));
  expect(classes(canvas())).toEqual(expect.arrayContaining(["flex-1", "min-h-[16rem]"]));
  expect(classes(canvas())).not.toContain("h-[min(45dvh,24rem)]");
  expect(classes(row())).toEqual(expect.arrayContaining(["flex-col", "md:flex-row"]));
  expect(classes(row())).not.toContain("overflow-y-auto");
  expect(classes(aside())).toEqual(expect.arrayContaining(["max-h-[45%]", "overflow-y-auto"]));
  expect(classes(taskLine())).toContain("line-clamp-3");
  expect(title().parentElement!.contains(button("Exit full screen"))).toBe(true);
  expect(footer()).toBeNull();
  await click(button("Exit full screen"));
  expect(classes(canvas())).toContain("h-[min(45dvh,24rem)]");
});
