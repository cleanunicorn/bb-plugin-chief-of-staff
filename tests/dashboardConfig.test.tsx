// @vitest-environment jsdom
// The dashboard keeps unsaved configuration drafts while you switch tabs, marks
// the Configure tab while any draft is pending, and warns before a reload.
// Configure's sections live in the page address (#126).
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
    cos_stats: () => ({ doneInWindow: 0, failedInWindow: 0, medianCycleMinutes: null, daily: [], usage: { totalTokens: null, cost: [], counted: 0, unreported: 0, pending: 0, medianTokensPerDone: null } }),
    cos_since: () => ({ shipped: 0, failed: 0, failures: [] }),
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
  mocks.navigate.toPluginPanel.mockReset();
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

// ---------- Configure sections in the page address (#126) ----------

const sectionButton = (label: string) => Array.from(container.querySelectorAll('nav[aria-label="Configuration sections"] button')).find((b) => b.textContent?.includes(label))!;
const currentSection = () => container.querySelector('nav[aria-label="Configuration sections"] [aria-current="page"]')!.textContent;
const pushed = () => mocks.navigate.toPluginPanel.mock.calls.map(([path, opts]) => `${path}/${(opts as { subPath: string }).subPath}`);
/** Do what the host does after a push: show the dashboard at the address it was sent to. */
const follow = async () => {
  const last = mocks.navigate.toPluginPanel.mock.calls.at(-1)!;
  await show((last[1] as { subPath: string }).subPath);
};
const BAD_REPOS = '{"repos": [';

it("pushes the section's address when a section is picked, and shows the section the address names", async () => {
  await show("config");
  expect(currentSection()).toContain("Workflows");
  await click(sectionButton("Repositories"));
  expect(mocks.navigate.toPluginPanel).toHaveBeenCalledExactlyOnceWith("cos", { subPath: "config/repos" });
  // The address decides: nothing changes until the host shows the new one.
  expect(currentSection()).toContain("Workflows");

  await follow();
  expect(currentSection()).toContain("Repositories");
  // Back: the host shows the previous address again.
  await show("config");
  expect(currentSection()).toContain("Workflows");
});

it("pushes nothing on load, on a click of the current section, or on Add repository", async () => {
  await show("config");
  await click(sectionButton("Workflows"));
  await show("config/repos");
  await click(sectionButton("Repositories"));
  await click(button("Add repository"));
  expect(text()).toContain("1 to fix before saving");
  expect(mocks.navigate.toPluginPanel).not.toHaveBeenCalled();
});

it("follows a problem link to its section and opens the repository it names", async () => {
  await show("config/repos");
  // With one BB project the new entry duplicates acme/app, and opens.
  await click(button("Add repository"));
  const cards = () => Array.from(container.querySelectorAll("article button[aria-expanded]"));
  await click(cards()[1]!);
  expect(cards().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  await click(sectionButton("General"));
  await follow();
  expect(currentSection()).toContain("General");

  // The save bar lists the sections with problems that are not on screen (#123), each leading to its problem.
  await click(button("Show"));
  await click(button("Repositories · acme/app · 1 to fix"));
  expect(pushed().at(-1)).toBe("cos/config/repos");
  await follow();
  expect(currentSection()).toContain("Repositories");
  expect(cards().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
});

it("pushes config/advanced from Open Advanced JSON", async () => {
  mocks.config = { ...mocks.config, repos: BAD_REPOS };
  await show("config/repos");
  await click(button("Open Advanced JSON"));
  expect(mocks.navigate.toPluginPanel).toHaveBeenCalledExactlyOnceWith("cos", { subPath: "config/advanced" });
  await follow();
  expect((field("Repositories") as HTMLTextAreaElement).value).toBe(BAD_REPOS);
});

it("still loads Pipeline when the address has a malformed escape after the tab", async () => {
  await show("agents/%E0");
  const tabs = Array.from(container.querySelectorAll('nav[aria-label="Dashboard tabs"] button'));
  expect(tabs.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
});

it("keeps a General draft while moving between section addresses, and back", async () => {
  await show("config/general");
  await setValue(field(MAX_TASKS), "5");
  await click(sectionButton("Repositories"));
  await follow();
  expect(currentSection()).toContain("Repositories");
  expect(configureTabDot()).not.toBeNull();
  await show("config/general"); // Back

  expect((field(MAX_TASKS) as HTMLInputElement).value).toBe("5");
  expect(unsavedSections()).toEqual(["General"]);
  expect(configureTabDot()).not.toBeNull();
  expect(pushed()).toEqual(["cos/config/repos"]);
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
