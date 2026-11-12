// @vitest-environment jsdom
// The dashboard keeps unsaved configuration drafts while you switch tabs, marks
// the Configure tab while any draft is pending, and warns before a reload.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_DOCUMENT, serializeWorkflows } from "../src/workflow";
import { button, click, container, field, mount, setValue, unmount } from "./dom";

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
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} aria-hidden="true" /> }));
vi.mock("../components/cos/question", () => ({ QuestionSheet: () => null }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({ ...(await original<typeof import("../components/cos/workflowCanvas")>()), WorkflowCanvas: () => null }));
import { Dashboard } from "../app";

const MAX_TASKS = "Max tasks across all repos";
const text = () => container.textContent ?? "";
const unsavedSections = () => Array.from(container.querySelectorAll('nav[aria-label="Configuration sections"] [aria-label="unsaved"]')).map((dot) => dot.closest("button")!.textContent);
const show = (subPath: string) => mount(<Dashboard subPath={subPath} />);

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
  await click(button("Discard"));
  await show("agents");
  await show("config/general");

  expect((field(MAX_TASKS) as HTMLInputElement).value).toBe("8");
  expect(text()).not.toContain("Unsaved changes");
});
