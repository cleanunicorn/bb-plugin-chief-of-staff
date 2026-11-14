// @vitest-environment jsdom
// The workflow sheet switches to its short-height layout (phone landscape) from a media query, and back.
// jsdom has no layout, so this checks the switch; the real bounds are measured in a browser (see #98).
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
    data: method === "cos_roster" ? { entries: mocks.entries } : method === "cos_item_workflow" ? mocks.workflow : method === "cos_since" ? { shipped: 0, failed: 0, failures: [] } : method === "cos_stats" ? { doneInWindow: 0, failedInWindow: 0, medianCycleMinutes: null, daily: [] } : { paused: false, repos: [], occupiedCapacity: 1, settings: { maxConcurrentTotal: 8 } },
    error: null, refetch: vi.fn(),
  }),
  ThreadTitle: () => null, UrlLink: () => null, Markdown: ({ content }: { content: string }) => content,
}));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("../components/cos/configurator", () => ({ Configurator: () => null }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("@xyflow/react/dist/style.css", () => ({}));
import { PipelineTab, SHORT_VIEWPORT_QUERY } from "../app";
import { entry } from "./helpers/roster";

/** A matchMedia whose answer for SHORT_VIEWPORT_QUERY the test flips, firing "change" like a rotation does. */
let short = false;
const listeners = new Set<() => void>();
function matchMedia(query: string) {
  return {
    get matches() { return query === SHORT_VIEWPORT_QUERY && short; },
    media: query,
    addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
  } as unknown as MediaQueryList;
}
const rotate = (to: boolean) => act(async () => { short = to; for (const fn of [...listeners]) fn(); });

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const canvas = () => dialog().querySelector<HTMLElement>(".react-flow")!.parentElement!.parentElement!;
const row = () => canvas().parentElement!;
const aside = () => dialog().querySelector<HTMLElement>("aside")!;
const classes = (el: HTMLElement) => el.className.split(/\s+/);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubReactFlowDom();
  short = false;
  listeners.clear();
  vi.stubGlobal("matchMedia", matchMedia);
  mocks.entries = [entry()];
  mocks.workflow = { title: "Fix login", workflow: DEFAULT_WORKFLOW, live: {} };
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<PipelineTab />); });
  await act(async () => { Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Workflow")!.click(); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("keeps the stacked layout and the canvas floor on a tall viewport", () => {
  expect(classes(canvas())).toContain("min-h-[16rem]");
  expect(classes(row())).toEqual(expect.arrayContaining(["flex-col", "md:flex-row"]));
  expect(classes(aside())).toEqual(expect.arrayContaining(["max-h-[45%]", "md:w-[26rem]"]));
  expect(classes(dialog())).toContain("h-[90dvh]");
});

it("fits the canvas beside the details on a short viewport, and switches back on rotation", async () => {
  await rotate(true);
  expect(classes(canvas())).not.toContain("min-h-[16rem]");
  expect(classes(canvas())).toContain("min-h-0");
  expect(classes(row())).toContain("flex-row");
  expect(classes(row()).some((c) => c.startsWith("md:"))).toBe(false);
  expect(classes(aside()).some((c) => c.startsWith("md:") || c.startsWith("max-h-[45"))).toBe(false);
  expect(classes(dialog())).toEqual(expect.arrayContaining(["h-[calc(100dvh-1rem)]", "max-h-[calc(100dvh-1rem)]"]));
  await rotate(false);
  expect(classes(canvas())).toContain("min-h-[16rem]");
  expect(classes(row())).toContain("flex-col");
});
