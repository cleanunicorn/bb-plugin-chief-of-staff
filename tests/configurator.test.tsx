// @vitest-environment jsdom
// The configurator's save path: dirty tracking, Save, Discard, the realtime
// refetch, the problems that keep Save off, and a save that fails halfway.
// Load failures are left out on purpose; they are changed by another open issue.
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
  refetchConfig: vi.fn(),
  refetchSettings: vi.fn(),
  realtime: new Map<string, () => void>(),
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: mocks.call }),
  useRealtime: (event: string, handler: () => void) => { mocks.realtime.set(event, handler); },
  experimental_useRpcQuery: ({ method }: { method: string }) =>
    method === "cos_get_config" ? { data: mocks.config, error: null, refetch: mocks.refetchConfig }
    : method === "cos_get_settings" ? { data: mocks.settings, error: null, refetch: mocks.refetchSettings }
    : { data: { skills: [] }, error: null, refetch: vi.fn() },
}));
vi.mock("../components/ui/icon", () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} aria-hidden="true" /> }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({ ...(await original<typeof import("../components/cos/workflowCanvas")>()), WorkflowCanvas: () => null }));
import { Configurator } from "../components/cos/configurator";

const MAX_TASKS = "Max tasks across all repos";
const SAVED = "Saved. Changes apply on the next intake and sweep.";
const text = () => container.textContent ?? "";
const number = (label: string) => (field(label) as HTMLInputElement).value;
/** The section buttons that carry the unsaved dot. */
const unsavedSections = () => Array.from(container.querySelectorAll('nav [aria-label="unsaved"]')).map((dot) => dot.closest("button")!.textContent);

const VALUES = { ...mocks.settings.values };
beforeEach(() => {
  mocks.settings.values = { ...VALUES };
  mocks.config = { repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1" }] }), workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  mocks.call.mockResolvedValue({ ok: true, warnings: [], changed: [] });
});
afterEach(async () => {
  await unmount();
  mocks.call.mockReset();
  mocks.refetchConfig.mockReset();
  mocks.refetchSettings.mockReset();
  mocks.realtime.clear();
});

it("shows no save bar and no unsaved dot on a clean load", async () => {
  await mount(<Configurator initialSection="general" />);
  expect(number(MAX_TASKS)).toBe("8");
  expect(text()).not.toContain("Unsaved changes");
  expect(unsavedSections()).toEqual([]);
});

it("marks the edited section as unsaved, and Discard restores the loaded values", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  expect(text()).toContain("Unsaved changes");
  expect(unsavedSections()).toEqual(["General"]);

  await click(button("Discard"));
  expect(number(MAX_TASKS)).toBe("8");
  expect(text()).not.toContain("Unsaved changes");
  expect(unsavedSections()).toEqual([]);
  expect(mocks.call).not.toHaveBeenCalled();
});

it("is clean again when a general setting is typed back to its loaded value", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  await setValue(field(MAX_TASKS), "8");
  expect(text()).not.toContain("Unsaved changes");
  expect(unsavedSections()).toEqual([]);
});

it("saves only the changed general settings, refetches and clears the draft", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  await click(button("BB push notifications"));
  await click(button("Save changes"));

  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_settings", { maxConcurrentTotal: 5, notifyPush: false });
  expect(mocks.refetchConfig).toHaveBeenCalledTimes(1);
  expect(mocks.refetchSettings).toHaveBeenCalledTimes(1);
  expect(text()).not.toContain("Unsaved changes");
  expect(text()).toContain(SAVED);
  expect(unsavedSections()).toEqual([]);
});

it("saves a repository edit as the repos document only, and shows the server's warnings", async () => {
  mocks.call.mockResolvedValue({ ok: true, warnings: ["acme/app: project not found", "check the token"] });
  await mount(<Configurator initialSection="repos" />);
  await click(container.querySelector("article button[aria-expanded]")!);
  await setValue(field("Model"), "opus");
  expect(unsavedSections()).toEqual(["Repositories1"]);
  await click(button("Save changes"));

  expect(mocks.call).toHaveBeenCalledTimes(1);
  const [method, input] = mocks.call.mock.calls[0] as [string, { repos: string }];
  expect(method).toBe("cos_set_config");
  expect(Object.keys(input)).toEqual(["repos"]);
  const saved = JSON.parse(input.repos) as { repos: Record<string, unknown>[] };
  expect(saved.repos).toHaveLength(1);
  expect(saved.repos[0]).toMatchObject({ owner: "acme", repo: "app", projectId: "proj_1", model: "opus" });
  expect(mocks.refetchConfig).toHaveBeenCalledTimes(1);
  expect(mocks.refetchSettings).toHaveBeenCalledTimes(1);
  expect(text()).toContain("Saved. acme/app: project not found; check the token");
  expect(text()).not.toContain("Unsaved changes");
});

it("saves a workflow edit as the workflow document only", async () => {
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "Delivery");
  expect(unsavedSections()).toEqual(["Workflows"]);
  await click(button("Save changes"));

  expect(mocks.call).toHaveBeenCalledTimes(1);
  const [method, input] = mocks.call.mock.calls[0] as [string, { workflow: string }];
  expect(method).toBe("cos_set_config");
  expect(Object.keys(input)).toEqual(["workflow"]);
  expect(input.workflow).toBe(serializeWorkflows({ ...DEFAULT_DOCUMENT, workflows: [{ ...DEFAULT_DOCUMENT.workflows[0]!, name: "Delivery" }] }));
});

it("keeps the draft and shows the error when the save is rejected", async () => {
  mocks.call.mockRejectedValue(new Error("settings are locked"));
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  await click(button("Save changes"));

  expect(text()).toContain("settings are locked");
  expect(text()).toContain("Unsaved changes");
  expect(text()).not.toContain("Saved.");
  expect(number(MAX_TASKS)).toBe("5");
  expect(mocks.refetchConfig).not.toHaveBeenCalled();
  expect(mocks.refetchSettings).not.toHaveBeenCalled();
  expect(button("Save changes").disabled).toBe(false);
});

it("disables Save and lists the problem while a repository is invalid", async () => {
  await mount(<Configurator initialSection="repos" />);
  // With one BB project the new entry points at it, so it duplicates acme/app.
  await click(button("Add repository"));

  expect(text()).toContain("1 to fix before saving");
  expect(text()).toContain("Repositories · acme/app: duplicate of entry 1");
  expect(container.querySelector('nav [aria-label="1 to fix"]')!.closest("button")!.textContent).toContain("Repositories");
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Save changes"));
  expect(mocks.call).not.toHaveBeenCalled();
});

it("refetches on cos-changed when clean, and leaves an unsaved draft alone", async () => {
  await mount(<Configurator initialSection="general" />);
  mocks.realtime.get("cos-changed")!();
  expect(mocks.refetchConfig).toHaveBeenCalledTimes(1);
  expect(mocks.refetchSettings).toHaveBeenCalledTimes(1);

  await setValue(field(MAX_TASKS), "5");
  mocks.realtime.get("cos-changed")!();
  expect(mocks.refetchConfig).toHaveBeenCalledTimes(1);
  expect(mocks.refetchSettings).toHaveBeenCalledTimes(1);
  expect(number(MAX_TASKS)).toBe("5");
});

// ---------- problems the server would reject, and partial saves ----------

const STALL = "Stalled after (minutes)";
const fieldText = (label: string) => field(label).parentElement!.textContent ?? "";
const badge = (section: string) => container.querySelector(`nav button:has([aria-label$="to fix"])`)?.textContent?.startsWith(section) ?? false;

it("lists an empty “Use when” of a new model choice, keeps Save off and calls nothing", async () => {
  await mount(<Configurator initialSection="workflow" />);
  await click(button("List"));
  await click(Array.from(container.querySelectorAll("button[aria-expanded]"))[2]!);
  await click(button("Add a model choice"));
  await setValue(field("Model"), "haiku");

  expect(text()).toContain("1 to fix before saving");
  expect(text()).toContain('Workflows · Workflow "Plan, build, review, ship" › step "Review" › model choice 1: “Use when” must not be empty');
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Save changes"));
  expect(mocks.call).not.toHaveBeenCalled();
});

it("lists an over-long default model under General and next to the field, and keeps Save off", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field("Model"), "m".repeat(201));

  expect(text()).toContain("General · Default model is longer than 200 characters");
  expect(fieldText("Model")).toContain("Default model is longer than 200 characters");
  expect(badge("General")).toBe(true);
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Save changes"));
  expect(mocks.call).not.toHaveBeenCalled();
});

it("sends neither document while a workflow is invalid, even with a valid general change", async () => {
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "");
  await click(button("General"));
  await setValue(field(MAX_TASKS), "5");

  expect(text()).toContain("Workflows · Workflow 1: name must not be empty");
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Save changes"));
  expect(mocks.call).not.toHaveBeenCalled();
});

it("saves a stall threshold typed over the limit as the limit", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(STALL), "5000");
  await click(button("Save changes"));
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_settings", { stallThresholdMinutes: 1440 });
});

it("saves an unrelated edit while a loaded value is out of range, sending only the change", async () => {
  mocks.settings.values = { ...VALUES, stallThresholdMinutes: 5000 };
  await mount(<Configurator initialSection="general" />);
  expect(number(STALL)).toBe("5000");
  await setValue(field(MAX_TASKS), "5");

  expect(text()).not.toContain("to fix before saving");
  expect(button("Save changes").disabled).toBe(false);
  await click(button("Save changes"));
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_settings", { maxConcurrentTotal: 5 });
});

it("says what was saved when the general settings fail after the workflows were written", async () => {
  mocks.call.mockImplementation(async (method: string) => {
    if (method === "cos_set_settings") throw new Error("host unavailable");
    return { ok: true, warnings: ["check the token"] };
  });
  mocks.refetchConfig.mockRejectedValue(new Error("offline"));
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "Delivery");
  await click(button("General"));
  await setValue(field(MAX_TASKS), "5");
  await click(button("Save changes"));

  expect(mocks.call.mock.calls.map(([method]) => method)).toEqual(["cos_set_config", "cos_set_settings"]);
  expect(text()).toContain("Workflows saved (check the token); general settings were not: host unavailable");
  expect(unsavedSections()).toEqual(["General"]);
  expect(number(MAX_TASKS)).toBe("5");
  expect(mocks.refetchConfig).toHaveBeenCalledTimes(1);
});
