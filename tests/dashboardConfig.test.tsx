// @vitest-environment jsdom
// The dashboard keeps unsaved configuration drafts while you switch tabs, marks
// the Configure tab while any draft is pending, and warns before a reload.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_DOCUMENT, serializeWorkflows } from "../src/workflow";
import { button, click, container, dialog, dialogButton, field, mount, setValue, tick, unmount } from "./dom";

const mocks = vi.hoisted(() => ({
  config: { repos: "", workflow: "" },
  settings: {
    values: { maxConcurrentTotal: 8, stallThresholdMinutes: 30, intakeIntervalMinutes: 5, defaultProviderId: "", defaultModel: "", notifyPush: true, archiveThreadsOnDone: false },
    token: { stored: false, source: "gh-cli" },
    projects: [{ id: "proj_1", name: "App", remote: "https://github.com/acme/app.git" }],
    providers: [],
  },
  call: vi.fn(),
  navigate: { toThread: vi.fn(), toPluginPanel: vi.fn() },
}));
vi.mock("@get-bb/plugin-sdk/app", () => {
  const data: Record<string, () => unknown> = {
    cos_get_config: () => mocks.config,
    cos_get_settings: () => mocks.settings,
    cos_skills: () => ({ skills: [] }),
    cos_roster: () => ({ entries: [] }),
    cos_log: () => ({ entries: [] }),
    cos_stats: () => ({ doneInWindow: 0, failedInWindow: 0, medianCycleMinutes: null, daily: [] }),
    cos_overview: () => ({ paused: false, repos: [], occupiedCapacity: 0, settings: { maxConcurrentTotal: 8 }, errors: [], warnings: [], tokenSource: "gh-cli" }),
  };
  return {
    definePluginApp: () => ({}),
    useBbNavigate: () => mocks.navigate,
    useRpc: () => ({ call: mocks.call }),
    useRealtime: () => {},
    experimental_useRpcQuery: ({ method }: { method: string }) => {
      if (!data[method]) throw new Error(`unmocked query ${method}`);
      return { data: data[method](), error: null, refetch: vi.fn() };
    },
    ThreadTitle: () => null,
    UrlLink: () => null,
  };
});
vi.mock("../components/ui/icon", () => ({ Icon: ({ name, className }: { name: string; className?: string }) => <svg data-icon={name} className={className} aria-hidden="true" /> }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({ ...(await original<typeof import("../components/cos/workflowCanvas")>()), WorkflowCanvas: () => null }));
import { Dashboard } from "../app";

const MAX_TASKS = "Max tasks across all repos";
const text = () => container.textContent ?? "";
const unsavedSections = () => Array.from(container.querySelectorAll('nav[aria-label="Configuration sections"] [aria-label="unsaved"]')).map((dot) => dot.closest("button")!.textContent);
const show = (subPath: string) => mount(<Dashboard subPath={subPath} />);
/** Discard in the save bar, confirmed in the dialog it opens. */
async function confirmDiscard() {
  await click(button("Discard"));
  expect(dialog()?.textContent).toContain("Discard changes to General?");
  await click(dialogButton("Discard"));
  await tick();
}

beforeEach(() => {
  mocks.config = { repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1" }] }), workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  mocks.call.mockResolvedValue({ ok: true, warnings: [], changed: [] });
});
afterEach(async () => {
  await unmount();
  mocks.call.mockReset();
});

it("keeps a general settings draft across a switch to Pipeline and back", async () => {
  await show("config/general");
  await setValue(field(MAX_TASKS), "5");
  await show("agents");
  expect(text()).not.toContain("Configuration sections");
  await show("config/general");

  expect((field(MAX_TASKS) as HTMLInputElement).value).toBe("5");
  expect(text()).toContain("Unsaved changes");
  expect(unsavedSections()).toEqual(["General"]);
});

it("keeps a repository draft across a tab switch", async () => {
  await show("config/repos");
  expect(container.querySelector('nav[aria-label="Configuration sections"] [aria-current="page"]')!.textContent).toContain("Repositories");
  await click(container.querySelector("article button[aria-expanded]")!);
  await setValue(field("Model"), "opus");
  await show("issues");
  await show("config/repos");
  await click(container.querySelector("article button[aria-expanded]")!);

  expect((field("Model") as HTMLInputElement).value).toBe("opus");
  expect(unsavedSections()).toEqual(["Repositories1"]);
});

it("keeps a workflow draft across a tab switch", async () => {
  await show("config");
  await setValue(field("Name"), "Delivery");
  await show("agents");
  await show("config");

  expect((field("Name") as HTMLInputElement).value).toBe("Delivery");
  expect(unsavedSections()).toEqual(["Workflows"]);
});

it("shows neither unsaved changes nor a stale Saved. after saving and switching tabs", async () => {
  await show("config/general");
  await setValue(field(MAX_TASKS), "5");
  await click(button("Save changes"));
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_settings", { maxConcurrentTotal: 5 });
  expect(text()).toContain("Saved.");

  await show("agents");
  await show("config/general");
  expect(text()).not.toContain("Unsaved changes");
  expect(text()).not.toContain("Saved.");
});

it("Discard clears the lifted drafts", async () => {
  await show("config/general");
  await setValue(field(MAX_TASKS), "5");
  await confirmDiscard();
  await show("agents");
  await show("config/general");

  expect((field(MAX_TASKS) as HTMLInputElement).value).toBe("8");
  expect(text()).not.toContain("Unsaved changes");
});

it("keeps an Advanced JSON draft across a tab switch", async () => {
  await show("config/advanced");
  await setValue(field("Workflow"), "{}");
  await show("agents");
  await show("config/advanced");

  expect((field("Workflow") as HTMLTextAreaElement).value).toBe("{}");
  expect(unsavedSections()).toEqual(["Advanced JSON"]);
});

// ---------- Configure tab marker and leave-page warning ----------

const configureTabDot = () => Array.from(container.querySelectorAll('nav[aria-label="Dashboard tabs"] button')).find((b) => b.textContent === "Configure")!.querySelector('[aria-label="unsaved"]');
/** Whether a reload would ask before leaving. */
const leaveWarns = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

it("marks the Configure tab on every tab while a draft is pending, and warns before a reload", async () => {
  await show("config/general");
  expect(configureTabDot()).toBeNull();
  expect(leaveWarns()).toBe(false);
  await setValue(field(MAX_TASKS), "5");
  expect(configureTabDot()).not.toBeNull();
  await show("agents");
  expect(configureTabDot()).not.toBeNull();
  await show("issues");
  expect(configureTabDot()).not.toBeNull();
  expect(leaveWarns()).toBe(true);

  await show("config/general");
  await confirmDiscard();
  expect(configureTabDot()).toBeNull();
  expect(leaveWarns()).toBe(false);
});

it("marks the Configure tab for an Advanced JSON draft and clears it after Save", async () => {
  await show("config/advanced");
  await setValue(field("Workflow"), "{}");
  expect(configureTabDot()).not.toBeNull();
  await click(button("Save changes"));
  expect(configureTabDot()).toBeNull();
  expect(leaveWarns()).toBe(false);
});

it("neither marks nor warns after a general value is typed back to its loaded value", async () => {
  await show("config/general");
  await setValue(field(MAX_TASKS), "5");
  await setValue(field(MAX_TASKS), "8");
  await show("agents");
  expect(configureTabDot()).toBeNull();
  expect(leaveWarns()).toBe(false);
});

// ---------- Dashboard tabs on narrow screens (#96) ----------

const dashboardNav = () => container.querySelector<HTMLElement>('nav[aria-label="Dashboard tabs"]')!;
const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

it("keeps the dashboard tabs reachable on narrow screens: text-only below sm, scrolling inside the nav as a fallback", async () => {
  await show("config/general");
  const nav = dashboardNav();
  expect(classes(nav)).toEqual(expect.arrayContaining(["min-w-0", "overflow-x-auto"]));

  const tabs = Array.from(nav.querySelectorAll("button"));
  expect(tabs.map((b) => b.textContent)).toEqual(["Pipeline", "Repos & PRs", "Configure"]);
  expect(tabs.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
  for (const tab of tabs) {
    expect(classes(tab)).toContain("shrink-0");
    expect(classes(tab.querySelector("svg")!)).toEqual(expect.arrayContaining(["hidden", "sm:block"]));
  }

  await setValue(field(MAX_TASKS), "5");
  const dot = configureTabDot()!;
  expect(dot.closest("nav")).toBe(nav);
  expect(classes(dot)).toContain("shrink-0");
});
