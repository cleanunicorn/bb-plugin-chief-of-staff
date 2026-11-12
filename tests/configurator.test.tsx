// @vitest-environment jsdom
// Configuration saves, validation, invalid-document protection, persistent drafts and failed reads.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  /** A failed read. Like the SDK, an error after a first load keeps the data. */
  failed: { config: null as string | null, settings: null as string | null },
  /** Reads that never loaded, so they have an error and no data. */
  neverLoaded: { config: false, settings: false },
}));
/** The SDK's query state: a refresh error keeps `data`; a failed first load has none. */
const query = (key: "config" | "settings", data: unknown, refetch: () => unknown) => ({
  data: mocks.neverLoaded[key] ? undefined : data,
  error: mocks.failed[key] ? new Error(mocks.failed[key]) : null,
  refetch,
});
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: mocks.call }),
  useRealtime: (event: string, handler: () => void) => { mocks.realtime.set(event, handler); },
  experimental_useRpcQuery: ({ method }: { method: string }) =>
    method === "cos_get_config" ? query("config", mocks.config, mocks.refetchConfig)
    : method === "cos_get_settings" ? query("settings", mocks.settings, mocks.refetchSettings)
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
  mocks.failed = { config: null, settings: null };
  mocks.neverLoaded = { config: false, settings: false };
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

it("shows the issue comments switch on and saves it off", async () => {
  await mount(<Configurator initialSection="repos" />);
  await click(container.querySelector("article button[aria-expanded]")!);
  expect(button("Comment on issues").getAttribute("aria-checked")).toBe("true");
  await click(button("Comment on issues"));
  await click(button("Save changes"));

  const [method, input] = mocks.call.mock.calls[0] as [string, { repos: string }];
  expect(method).toBe("cos_set_config");
  expect((JSON.parse(input.repos) as { repos: Record<string, unknown>[] }).repos[0]).toMatchObject({ owner: "acme", repo: "app", issueComments: false });
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

// ---------- a stored document that fails to load ----------

const GOOD_REPOS = JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", workflow: "custom" }] });
/** Parses as JSON but fails validation: one on-fail points at a missing step. */
const BAD_WORKFLOW = JSON.stringify({
  workflows: [{ ...DEFAULT_DOCUMENT.workflows[0]!, id: "custom", steps: DEFAULT_DOCUMENT.workflows[0]!.steps.map((s) => (s.id === "review" ? { ...s, onFail: "nowhere" } : s)) }],
  default: "custom",
});
const BAD_REPOS = '{"repos": [';
const has = (selector: string) => container.querySelector(selector) !== null;
const hasButton = (name: string) => Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.trim() === name);
const navButton = (label: string) => Array.from(container.querySelectorAll("nav button")).find((b) => b.textContent?.includes(label))!;

it("blocks the workflow editor while the stored workflow fails validation, and leaves repositories saveable on their own", async () => {
  mocks.config = { repos: GOOD_REPOS, workflow: BAD_WORKFLOW };
  await mount(<Configurator initialSection="workflow" />);

  expect(text()).toContain("on fail goes to a missing step");
  expect(text()).not.toContain("last valid parts only");
  expect(hasButton("Open Advanced JSON")).toBe(true);
  expect(has("label")).toBe(false); // no workflow editor, so nothing to edit
  expect(hasButton("Save changes")).toBe(false);

  await click(navButton("Repositories"));
  await click(container.querySelector("article button[aria-expanded]")!);
  // The workflow picker cannot offer the default document, so it is read-only and shows what is stored.
  const picker = field("Workflow for this repository") as HTMLSelectElement;
  expect(picker.disabled).toBe(true);
  expect(picker.value).toBe("custom");
  expect(text()).not.toContain("Default (Delivery)");
  await setValue(field("Model"), "opus");
  await click(button("Save changes"));

  expect(mocks.call).toHaveBeenCalledTimes(1);
  const [method, input] = mocks.call.mock.calls[0] as [string, Record<string, string>];
  expect(method).toBe("cos_set_config");
  expect(Object.keys(input)).toEqual(["repos"]);
  expect(JSON.parse(input.repos!).repos[0]).toMatchObject({ workflow: "custom", model: "opus" });
});

it("blocks the repositories editor while the stored repos JSON is invalid, and leaves workflows saveable on their own", async () => {
  mocks.config = { repos: BAD_REPOS, workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  await mount(<Configurator initialSection="repos" />);

  expect(text()).toContain("Repositories JSON does not load");
  expect(hasButton("Add repository")).toBe(false);
  expect(text()).not.toContain("No repositories yet");
  expect(navButton("Repositories").querySelector("span.tabular-nums")).toBeNull(); // no "0" count

  await click(navButton("Workflows"));
  await setValue(field("Name"), "Delivery");
  await click(button("Save changes"));

  expect(mocks.call).toHaveBeenCalledTimes(1);
  const [, input] = mocks.call.mock.calls[0] as [string, Record<string, string>];
  expect(Object.keys(input)).toEqual(["workflow"]);
});

it("blocks both sections when both documents fail, and the banner names the failure on other sections", async () => {
  mocks.config = { repos: BAD_REPOS, workflow: BAD_WORKFLOW };
  await mount(<Configurator initialSection="general" />);

  expect(text()).toContain("Repositories JSON does not load");
  expect(text()).toContain("Workflows JSON does not load");
  expect(text()).toContain("Repair it in Advanced JSON");
  expect(text()).not.toContain("last valid parts only");
  await click(navButton("Repositories"));
  expect(hasButton("Add repository")).toBe(false);
  await click(navButton("Workflows"));
  expect(has("label")).toBe(false);
});

it("sends the operator to Advanced JSON, where the broken document is editable", async () => {
  mocks.config = { repos: BAD_REPOS, workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  await mount(<Configurator initialSection="repos" />);
  await click(button("Open Advanced JSON"));

  expect((field("Repositories") as HTMLTextAreaElement).value).toBe(BAD_REPOS);
  expect((field("Repositories") as HTMLTextAreaElement).disabled).toBe(false);
});

it("keeps other documents editable when repos is empty or half-filled", async () => {
  mocks.config = { repos: "", workflow: "" };
  await mount(<Configurator initialSection="repos" />);
  expect(hasButton("Add repository")).toBe(true);
  expect(text()).toContain("No repositories yet");
  await click(navButton("Workflows"));
  expect(field("Name")).toBeTruthy();

  mocks.config = { repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app" }] }), workflow: "" };
  await mount(<Configurator initialSection="repos" />);
  await click(navButton("Repositories"));
  expect(hasButton("Add repository")).toBe(true);
  expect(has("article")).toBe(true);
});

it("tells the operator to save or discard first when unsaved edits lock Advanced JSON", async () => {
  mocks.config = { repos: BAD_REPOS, workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "Delivery");
  await click(navButton("Repositories"));

  expect(text()).toContain("Save or discard your other changes first");
  await click(button("Open Advanced JSON"));
  expect((field("Repositories") as HTMLTextAreaElement).disabled).toBe(true);
});

it("drops a draft whose document stops loading, so repairing it does not bring the old draft back", async () => {
  mocks.config = { repos: GOOD_REPOS, workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  await mount(<Configurator initialSection="repos" />);
  await click(container.querySelector("article button[aria-expanded]")!);
  await setValue(field("Model"), "opus");
  expect(text()).toContain("Unsaved changes");

  // A CLI edit breaks the document; the draft must neither count as dirty nor lock Advanced JSON.
  mocks.config = { repos: BAD_REPOS, workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  await mount(<Configurator initialSection="repos" />);
  expect(text()).not.toContain("Unsaved changes");
  await click(button("Open Advanced JSON"));
  expect((field("Repositories") as HTMLTextAreaElement).disabled).toBe(false);

  // The operator repairs it; the refetch brings a valid document back, with no draft over it.
  mocks.config = { repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", model: "fixed" }] }), workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  await mount(<Configurator initialSection="repos" />);
  expect(text()).not.toContain("Unsaved changes");
  expect(unsavedSections()).toEqual([]);
  await click(navButton("Repositories")); // the repository was left expanded
  expect((field("Model") as HTMLInputElement).value).toBe("fixed");
});

it("drops a workflow draft whose document stops loading as well", async () => {
  mocks.config = { repos: GOOD_REPOS, workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "Delivery");
  mocks.config = { repos: GOOD_REPOS, workflow: BAD_WORKFLOW };
  await mount(<Configurator initialSection="workflow" />);
  expect(text()).not.toContain("Unsaved changes");
  mocks.config = { repos: GOOD_REPOS, workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  await mount(<Configurator initialSection="workflow" />);
  expect(text()).not.toContain("Unsaved changes");
  expect((field("Name") as HTMLInputElement).value).not.toBe("Delivery");
});

// ---------- Advanced JSON drafts ----------

const JSON_NOTICE = "You have unsaved Advanced JSON edits. Save or discard them before editing here.";
const textarea = (label: "Repositories" | "Workflow") => field(label) as HTMLTextAreaElement;
const EDITED_REPOS = JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", model: "opus" }] });

it("counts an Advanced JSON edit as unsaved, and typing it back is clean again", async () => {
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Repositories"), EDITED_REPOS);
  expect(unsavedSections()).toEqual(["Advanced JSON"]);
  expect(text()).toContain("Unsaved changes");
  expect(textarea("Repositories").disabled).toBe(false);

  await setValue(textarea("Repositories"), mocks.config.repos);
  expect(unsavedSections()).toEqual([]);
  expect(text()).not.toContain("Unsaved changes");
});

it("keeps an Advanced JSON draft across a section switch, and Discard restores the loaded text", async () => {
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Workflow"), "{}");
  await click(button("General"));
  await click(button("Advanced JSON"));
  expect(textarea("Workflow").value).toBe("{}");

  await click(button("Discard"));
  expect(textarea("Workflow").value).toBe(mocks.config.workflow);
  expect(unsavedSections()).toEqual([]);
  expect(mocks.call).not.toHaveBeenCalled();
});

it("locks the visual sections while an Advanced JSON draft is pending", async () => {
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Repositories"), EDITED_REPOS);
  await click(button("General"));
  expect(text()).toContain(JSON_NOTICE);
  expect(field(MAX_TASKS).closest("[inert]")).not.toBeNull();

  await click(button("Repositories1"));
  expect(button("Add repository").closest("[inert]")).not.toBeNull();

  await click(button("Discard"));
  expect(text()).not.toContain(JSON_NOTICE);
  expect(container.querySelector("[inert]")).toBeNull();
});

it("leaves an Advanced JSON draft alone on cos-changed", async () => {
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Repositories"), EDITED_REPOS);
  mocks.realtime.get("cos-changed")!();
  expect(mocks.refetchConfig).not.toHaveBeenCalled();
  expect(textarea("Repositories").value).toBe(EDITED_REPOS);
});

it("sends Save JSON once on a double click, and disables both Save buttons while it runs", async () => {
  mocks.call.mockReturnValue(new Promise(() => {}));
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Workflow"), "{}");
  const saveJson = button("Save JSON");
  await act(async () => {
    saveJson.click();
    saveJson.click();
  });

  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_config", { workflow: "{}" });
  expect(saveJson.disabled).toBe(true);
  // "Save JSON" and the save bar's Save.
  const busy = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Saving…");
  expect(busy).toHaveLength(2);
  expect(busy.every((b) => b.disabled)).toBe(true);
  expect(button("Discard").disabled).toBe(true);
  expect(button("Revert").disabled).toBe(true);
});

it("keeps the Advanced JSON draft and shows the error when the save is rejected", async () => {
  mocks.call.mockRejectedValue(new Error("Workflow JSON: Unexpected token"));
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Workflow"), "{");
  await click(button("Save JSON"));

  expect(text()).toContain("Workflow JSON: Unexpected token");
  expect(textarea("Workflow").value).toBe("{");
  expect(unsavedSections()).toEqual(["Advanced JSON"]);
  expect(mocks.refetchConfig).not.toHaveBeenCalled();
});

it("clears the Advanced JSON draft and shows the warnings after a save", async () => {
  mocks.call.mockResolvedValue({ ok: true, warnings: ["check the token"], changed: [] });
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Repositories"), EDITED_REPOS);
  await click(button("Save JSON"));

  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_config", { repos: EDITED_REPOS });
  expect(mocks.refetchConfig).toHaveBeenCalledTimes(1);
  expect(textarea("Repositories").value).toBe(mocks.config.repos);
  expect(unsavedSections()).toEqual([]);
  expect(text()).toContain("Saved. check the token");
  expect(text()).not.toContain("Unsaved changes");
});

it("saves an Advanced JSON draft from the save bar even when the loaded config fails visual validation", async () => {
  // No BB project: the visual editor flags this entry.
  mocks.config.repos = JSON.stringify({ repos: [{ owner: "acme", repo: "app" }] });
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Workflow"), "{}");

  expect(text()).not.toContain("to fix");
  expect(button("Save changes").disabled).toBe(false);
  await click(button("Save changes"));
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_config", { workflow: "{}" });
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

/** Edit the workflow name and a general setting, then save with cos_set_settings failing. */
async function halfSave() {
  mocks.call.mockImplementation(async (method: string) => {
    if (method === "cos_set_settings") throw new Error("host unavailable");
    return { ok: true, warnings: ["check the token"] };
  });
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "Delivery");
  await click(button("General"));
  await setValue(field(MAX_TASKS), "5");
  await click(button("Save changes"));
  expect(mocks.call.mock.calls.map(([method]) => method)).toEqual(["cos_set_config", "cos_set_settings"]);
}

it("says what was saved when the general settings fail after the workflows were written", async () => {
  await halfSave();
  expect(text()).toContain("Workflows saved (check the token); general settings were not: host unavailable");
  expect(unsavedSections()).toEqual(["General"]);
  expect(number(MAX_TASKS)).toBe("5");
  expect(mocks.refetchConfig).toHaveBeenCalledTimes(1);
});

it("keeps the sent drafts unsaved after a half save when the saved data cannot be reloaded", async () => {
  mocks.refetchConfig.mockRejectedValue(new Error("offline"));
  await halfSave();
  expect(text()).toContain("Workflows saved (check the token); general settings were not: host unavailable");
  expect(unsavedSections()).toEqual(["Workflows", "General"]);
  await click(button("Workflows"));
  expect((field("Name") as HTMLInputElement).value).toBe("Delivery");
});

const reload = () => mount(<Configurator initialSection="general" />);

it("keeps the editor, the draft and the save bar when a refetch fails, and shows a banner with Retry", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  mocks.failed.config = "cos_get_config timed out";
  await reload();

  expect(text()).toContain("cos_get_config timed out");
  expect(number(MAX_TASKS)).toBe("5");
  expect(text()).toContain("Unsaved changes");
  expect(button("Save changes").disabled).toBe(false);
  expect(button("Retry").disabled).toBe(false);
});

it("Retry refetches both reads, clears the banner and leaves the draft alone", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  mocks.failed.settings = "settings unavailable";
  await reload();
  const clearError = () => { mocks.failed.settings = null; return Promise.resolve(); };
  mocks.refetchSettings.mockImplementation(clearError);

  await click(button("Retry"));

  expect(mocks.refetchConfig).toHaveBeenCalledTimes(1);
  expect(mocks.refetchSettings).toHaveBeenCalledTimes(1);
  expect(text()).not.toContain("settings unavailable");
  expect(container.textContent).not.toContain("Retry");
  expect(number(MAX_TASKS)).toBe("5");
  expect(text()).toContain("Unsaved changes");
});

it("holds Retry disabled while it is refetching, and keeps the banner if the read fails again", async () => {
  await mount(<Configurator initialSection="general" />);
  mocks.failed.config = "still down";
  await reload();
  let finish!: () => void;
  mocks.refetchConfig.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  mocks.refetchSettings.mockResolvedValue(undefined);

  await click(button("Retry"));
  expect(button("Retry").disabled).toBe(true);
  await act(async () => { finish(); });

  expect(button("Retry").disabled).toBe(false);
  expect(text()).toContain("still down");
  expect(number(MAX_TASKS)).toBe("8");
});

it("does not leak an unhandled rejection when Retry's refetch throws", async () => {
  await mount(<Configurator initialSection="general" />);
  mocks.failed.config = "still down";
  await reload();
  mocks.refetchConfig.mockRejectedValue(new Error("transport closed"));
  mocks.refetchSettings.mockResolvedValue(undefined);

  await click(button("Retry"));

  expect(button("Retry").disabled).toBe(false);
  expect(text()).toContain("still down");
});

it("shows only the error, with Retry, when nothing has loaded", async () => {
  mocks.failed.config = "cos_get_config failed";
  mocks.neverLoaded.config = true;
  await mount(<Configurator initialSection="general" />);

  expect(text()).toContain("cos_get_config failed");
  expect(container.querySelector("nav")).toBeNull();
  expect(text()).not.toContain("Save changes");
  mocks.refetchConfig.mockImplementation(() => { mocks.failed.config = null; mocks.neverLoaded.config = false; return Promise.resolve(); });
  await click(button("Retry"));
  expect(number(MAX_TASKS)).toBe("8");
  expect(text()).not.toContain("cos_get_config failed");
});

it("shows the full-page error when only one of the two reads ever loaded", async () => {
  mocks.failed.settings = "settings unavailable";
  mocks.neverLoaded.settings = true;
  await mount(<Configurator initialSection="general" />);

  expect(text()).toContain("settings unavailable");
  expect(container.querySelector("nav")).toBeNull();
  expect(button("Retry")).toBeDefined();
});

it("clears the draft after a save even if the reload then fails, and shows the banner", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  mocks.refetchConfig.mockImplementation(() => { mocks.failed.config = "reload failed"; return Promise.resolve(); });
  mocks.refetchSettings.mockResolvedValue(undefined);
  await click(button("Save changes"));

  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_settings", { maxConcurrentTotal: 5 });
  expect(text()).toContain(SAVED);
  expect(text()).toContain("reload failed");
  expect(text()).not.toContain("Unsaved changes");
  expect(button("Retry")).toBeDefined();
});

describe("removing items and workflows (#66)", () => {
  const repo = (name: string, workflow?: string) => ({ owner: "acme", repo: name, projectId: `proj_${name}`, ...(workflow ? { workflow } : {}) });
  const fast = { ...DEFAULT_DOCUMENT.workflows[0]!, id: "fast", name: "Fast" };
  const load = (repos: string | object[], workflows = [DEFAULT_DOCUMENT.workflows[0]!, fast]) => {
    mocks.config = { repos: typeof repos === "string" ? repos : JSON.stringify({ repos }), workflow: serializeWorkflows({ workflows, default: DEFAULT_DOCUMENT.default }) };
  };
  const repoWorkflow = () => field("Workflow for this repository") as HTMLSelectElement;

  it("keeps a repository's armed confirmation with that repository when one above it is removed", async () => {
    load([repo("a"), repo("b"), repo("c")]);
    await mount(<Configurator initialSection="repos" />);
    await click(button("Remove acme/b"));
    await click(button("Remove acme/a"));
    await click(button("Remove"));
    // acme/b moved up but is still the armed one; acme/c is not armed.
    expect(() => button("Remove acme/a")).toThrow();
    expect(() => button("Remove acme/b")).toThrow();
    expect(button("Remove acme/c")).toBeTruthy();
    expect(text().match(/Remove\?/g)).toHaveLength(1);
  });

  it("keeps a repository card mounted while it is edited and across a refetch of the same config", async () => {
    load([repo("a"), repo("b")]);
    await mount(<Configurator initialSection="repos" />);
    await click(container.querySelector("article button[aria-expanded]")!);
    const model = field("Model");
    await setValue(field("GitHub repository"), "acme/renamed");
    await setValue(model, "opus");
    expect(field("Model")).toBe(model);
    await click(button("Discard"));

    // A refetch hands over a new result object with the same JSON: the rows are the same rows.
    await click(button("Remove acme/b"));
    mocks.config = { ...mocks.config };
    await mount(<Configurator initialSection="repos" />);
    expect(text().match(/Remove\?/g)).toHaveLength(1);
    expect(() => button("Remove acme/b")).toThrow();
  });

  it("points repositories back at the default when their workflow is deleted, and saves both", async () => {
    load([repo("a", "fast"), repo("b")]);
    await mount(<Configurator initialSection="workflow" />);
    await click(button("Fast"));
    await click(button("Delete Fast"));
    expect(text()).toContain("acme/a will use the default workflow.");
    await click(button("Remove"));
    expect(unsavedSections()).toEqual(["Workflows", "Repositories2"]);

    await click(button("Repositories2"));
    await click(container.querySelector("article button[aria-expanded]")!);
    expect(repoWorkflow().value).toBe("");
    expect(repoWorkflow().textContent).not.toContain("Missing");

    await click(button("Save changes"));
    const [, input] = mocks.call.mock.calls[0] as [string, { repos: string; workflow: string }];
    expect((JSON.parse(input.repos) as { repos: Record<string, unknown>[] }).repos.map((r) => r.workflow)).toEqual([undefined, undefined]);
    expect((JSON.parse(input.workflow) as { workflows: { id: string }[] }).workflows.map((w) => w.id)).toEqual([DEFAULT_DOCUMENT.default]);
  });

  it("restores the workflow and the repository's choice of it on Discard", async () => {
    load([repo("a", "fast")]);
    await mount(<Configurator initialSection="workflow" />);
    await click(button("Fast"));
    await click(button("Delete Fast"));
    await click(button("Remove"));
    await click(button("Discard"));
    expect(unsavedSections()).toEqual([]);
    expect(button("Fast")).toBeTruthy();

    await click(button("Repositories1"));
    await click(container.querySelector("article button[aria-expanded]")!);
    expect(repoWorkflow().value).toBe("fast");
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("leaves the repositories alone when their JSON could not be loaded", async () => {
    load("{not json");
    await mount(<Configurator initialSection="workflow" />);
    await click(button("Fast"));
    await click(button("Delete Fast"));
    await click(button("Remove"));
    expect(unsavedSections()).toEqual(["Workflows"]);
  });

  it("shows a repository's deleted workflow as missing instead of as the default", async () => {
    load([repo("a", "gone")]);
    await mount(<Configurator initialSection="repos" />);
    await click(container.querySelector("article button[aria-expanded]")!);
    expect(repoWorkflow().value).toBe("gone");
    expect(repoWorkflow().selectedOptions[0]!.textContent).toBe("Missing: gone (runs the default)");
  });
});
