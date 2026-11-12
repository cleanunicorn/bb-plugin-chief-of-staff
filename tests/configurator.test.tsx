// @vitest-environment jsdom
// The configurator's save path: dirty tracking, Save, Discard and the realtime
// refetch, and the rule that a stored document that fails to load is never
// edited or saved from the visual editor. Range validation and partial saves
// are left out on purpose; they are changed by other open issues.
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

beforeEach(() => {
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
