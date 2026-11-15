// @vitest-environment jsdom
// Configuration saves, validation, invalid-document protection, persistent drafts and failed reads.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOCUMENT, serializeWorkflows } from "../src/workflow";
import { button, click, container, dialog, dialogButton, field, keydown, mount, setValue, tick, unmount } from "./dom";

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
  /** Every render of the confirm dialog, to see what it shows while it closes. */
  dialogRenders: [] as { open: boolean; title: string }[],
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
vi.mock("../components/ui/confirm-dialog", async (original) => {
  const actual = await original<typeof import("../components/ui/confirm-dialog")>();
  return {
    ...actual,
    ConfirmDialog: (props: import("../components/ui/confirm-dialog").ConfirmDialogProps) => {
      mocks.dialogRenders.push({ open: props.open, title: props.title });
      return <actual.ConfirmDialog {...props} />;
    },
  };
});
import { Configurator, SECTIONS } from "../components/cos/configurator";
import { CONFIG_SECTIONS } from "../components/cos/configRoute";
import { useConfigDrafts } from "../components/cos/configDrafts";

const MAX_TASKS = "Max tasks across all repos";
const SAVED = "Saved. Changes apply on the next intake and sweep.";
const text = () => container.textContent ?? "";
const number = (label: string) => (field(label) as HTMLInputElement).value;
/** The section buttons that carry the unsaved dot. */
/** The sticky save bar, and the section summaries it lists while expanded. */
const bar = () => container.querySelector<HTMLElement>('[role="region"][aria-label="Save bar"]')!;
const summaries = () => Array.from(bar().querySelectorAll("li")).map((li) => li.textContent);
const unsavedSections = () => Array.from(container.querySelectorAll('nav [aria-label="unsaved"]')).map((dot) => dot.closest("button")!.textContent);
/** Discard in the save bar, confirmed in the dialog it opens. */
async function confirmDiscard() {
  await click(button("Discard"));
  await click(dialogButton("Discard"));
  await tick();
}

const VALUES = { ...mocks.settings.values };
beforeEach(() => {
  mocks.settings.values = { ...VALUES };
  mocks.config = { repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1" }] }), workflow: serializeWorkflows(DEFAULT_DOCUMENT) };
  mocks.call.mockResolvedValue({ ok: true, warnings: [], changed: [] });
  mocks.refetchConfig.mockImplementation(async () => {
    for (const [method, input] of mocks.call.mock.calls) {
      if (method === "cos_set_config") mocks.config = { ...mocks.config, ...input };
    }
  });
});
afterEach(async () => {
  await unmount();
  mocks.call.mockReset();
  mocks.refetchConfig.mockReset();
  mocks.refetchSettings.mockReset();
  mocks.realtime.clear();
  mocks.failed = { config: null, settings: null };
  mocks.neverLoaded = { config: false, settings: false };
  mocks.dialogRenders = [];
});

it("lists exactly the sections the page address can name, in the same order", () => {
  expect(SECTIONS.map((s) => s.id)).toEqual([...CONFIG_SECTIONS]);
});

const currentSection = () => container.querySelector('nav [aria-current="page"]')!.textContent;
const sectionButton = (label: string) => Array.from(container.querySelectorAll("nav button")).find((b) => b.textContent?.includes(label))!;

it("switches sections on its own when nobody controls the section (the settings page)", async () => {
  await mount(<Configurator initialSection="general" />);
  await click(sectionButton("Repositories"));
  expect(currentSection()).toContain("Repositories");
  expect(hasButton("Add repository")).toBe(true);
});

it("asks its owner to change section when the section is controlled, and shows the section it is given", async () => {
  const onSectionChange = vi.fn();
  await mount(<Configurator section="general" onSectionChange={onSectionChange} />);
  await click(sectionButton("General"));
  expect(onSectionChange).not.toHaveBeenCalled();
  await click(sectionButton("Repositories"));
  expect(onSectionChange).toHaveBeenCalledExactlyOnceWith("repos");
  expect(currentSection()).toContain("General");

  await mount(<Configurator section="repos" onSectionChange={onSectionChange} />);
  expect(currentSection()).toContain("Repositories");
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

  await confirmDiscard();
  expect(number(MAX_TASKS)).toBe("8");
  expect(text()).not.toContain("Unsaved changes");
  expect(unsavedSections()).toEqual([]);
  expect(mocks.call).not.toHaveBeenCalled();
});

// ---------- the save bar names the unsaved sections (#124) ----------

/** The save bar's "Unsaved changes …" line. */
const unsavedLine = () => Array.from(container.querySelectorAll("span")).find((s) => s.textContent?.startsWith("Unsaved changes"))?.textContent ?? null;
/** The section labels behind the unsaved dots, without the nav buttons' counts. */
const unsavedLabels = () => unsavedSections().map((t) => t!.replace(/\d+$/, ""));

it("names General in the save bar when only a general setting changed", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  expect(unsavedLine()).toBe("Unsaved changes in General");
  expect(unsavedLabels()).toEqual(["General"]);
});

it("names every section with changes, in the section list's order", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  await click(button("Workflows"));
  await setValue(field("Name"), "Delivery");
  expect(unsavedLine()).toBe("Unsaved changes in Workflows and General");
  expect(unsavedLabels()).toEqual(["Workflows", "General"]);

  await click(navButton("Repositories"));
  await click(container.querySelector("article button[aria-expanded]")!);
  await setValue(field("Model"), "opus");
  expect(unsavedLine()).toBe("Unsaved changes in Workflows, Repositories and General");
  expect(unsavedLabels()).toEqual(["Workflows", "Repositories", "General"]);
});

it("names Advanced JSON in the save bar when only the JSON changed", async () => {
  await mount(<Configurator initialSection="advanced" />);
  await setValue(field("Workflow"), "{}");
  expect(unsavedLine()).toBe("Unsaved changes in Advanced JSON");
  expect(unsavedLabels()).toEqual(["Advanced JSON"]);
});

// ---------- Discard asks first (#124) ----------

const DISCARD_DESCRIPTION = "Your edits go back to the saved values, including in sections not on screen. This cannot be undone.";

it("asks before Discard, naming every section with changes, and discards them all on confirm", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  await click(button("Workflows"));
  await setValue(field("Name"), "Delivery");

  button("Discard").focus();
  await click(button("Discard"));
  expect(dialog()?.textContent).toContain("Discard changes to Workflows and General?");
  expect(dialog()?.textContent).toContain(DISCARD_DESCRIPTION);
  expect(document.activeElement).toBe(dialogButton("Discard"));
  // Nothing is dropped until the dialog is answered.
  expect(unsavedLabels()).toEqual(["Workflows", "General"]);
  expect((field("Name") as HTMLInputElement).value).toBe("Delivery");

  await click(dialogButton("Discard"));
  await tick();
  expect(dialog()).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(unsavedLabels()).toEqual([]);
  expect(unsavedLine()).toBeNull();
  expect((field("Name") as HTMLInputElement).value).toBe(DEFAULT_DOCUMENT.workflows[0]!.name);
  await click(button("General"));
  expect(number(MAX_TASKS)).toBe("8");
  expect(mocks.call).not.toHaveBeenCalled();
});

it("hands focus to the current section's button after a confirmed Discard, since the bar is gone", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  button("Discard").focus();
  await click(button("Discard"));
  // Only the section on screen has changes, so the dialog does not mention others.
  expect(dialog()?.textContent).toContain("Your edits go back to the saved values. This cannot be undone.");
  expect(dialog()?.textContent).not.toContain("not on screen");
  await click(dialogButton("Discard"));
  await tick();
  expect(document.activeElement).toBe(navButton("General"));
});

it.each([
  ["Keep editing", () => click(dialogButton("Keep editing"))],
  ["Escape", () => keydown(dialog()!, "Escape")],
])("keeps every draft when Discard is cancelled with %s, and returns focus to Discard", async (_, cancel) => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  button("Discard").focus();
  await click(button("Discard"));
  expect(dialog()).not.toBeNull();

  await cancel();
  await tick();
  expect(dialog()).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(number(MAX_TASKS)).toBe("5");
  expect(unsavedLabels()).toEqual(["General"]);
  expect(unsavedLine()).toBe("Unsaved changes in General");
  expect(document.activeElement).toBe(button("Discard"));
  expect(mocks.call).not.toHaveBeenCalled();
});

it("asks the same way when only Advanced JSON has changes", async () => {
  await mount(<Configurator initialSection="advanced" />);
  await setValue(field("Workflow"), "{}");
  button("Discard").focus();
  await click(button("Discard"));
  expect(dialog()?.textContent).toContain("Discard changes to Advanced JSON?");
  expect((field("Workflow") as HTMLTextAreaElement).value).toBe("{}");

  await click(dialogButton("Keep editing"));
  await tick();
  expect((field("Workflow") as HTMLTextAreaElement).value).toBe("{}");

  await confirmDiscard();
  expect((field("Workflow") as HTMLTextAreaElement).value).toBe(mocks.config.workflow);
  expect(unsavedLabels()).toEqual([]);
  expect(document.activeElement).toBe(navButton("Advanced JSON"));
  expect(mocks.call).not.toHaveBeenCalled();
});

it("keeps the dialog's title while it closes, after the drafts it names are gone", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  await confirmDiscard();
  const lastOpen = mocks.dialogRenders.map((r) => r.open).lastIndexOf(true);
  expect(mocks.dialogRenders[lastOpen]!.title).toBe("Discard changes to General?");
  const closing = mocks.dialogRenders.slice(lastOpen + 1);
  expect(closing.length).toBeGreaterThan(0);
  expect(closing.every((r) => !r.open && r.title === "Discard changes to General?")).toBe(true);
});

it("puts Discard and Save at opposite ends of their own row on phones, and side by side from sm up", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "5");
  const group = button("Discard").parentElement!;
  expect(group).toBe(button("Save changes").parentElement);
  const classes = (group.getAttribute("class") ?? "").split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(["flex", "basis-full", "justify-between", "sm:ml-auto", "sm:basis-auto", "sm:justify-end"]));
  expect(classes).not.toContain("ml-auto");
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

it("shows the brief comments choice as trusted and saves another", async () => {
  await mount(<Configurator initialSection="repos" />);
  await click(container.querySelector("article button[aria-expanded]")!);
  const picker = field("Comments in the agent's brief") as HTMLSelectElement;
  expect(picker.value).toBe("trusted");
  await setValue(picker, "none");
  await click(button("Save changes"));

  const [method, input] = mocks.call.mock.calls[0] as [string, { repos: string }];
  expect(method).toBe("cos_set_config");
  expect((JSON.parse(input.repos) as { repos: Record<string, unknown>[] }).repos[0]).toMatchObject({ owner: "acme", repo: "app", briefComments: "none" });
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
  // The new entry is open, so its problem shows there and not again in the bar.
  expect(text()).toContain("duplicate of entry 1");
  expect(bar().textContent).not.toContain("duplicate");
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

  await confirmDiscard();
  expect(textarea("Workflow").value).toBe(mocks.config.workflow);
  expect(unsavedSections()).toEqual([]);
  expect(mocks.call).not.toHaveBeenCalled();
});

const REVERT_TITLE = "Revert your Advanced JSON edits?";

it("asks before Revert, and keeps both documents' edits when it is cancelled", async () => {
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Repositories"), EDITED_REPOS);
  await setValue(textarea("Workflow"), "{}");
  button("Revert").focus();
  await click(button("Revert"));
  expect(dialog()?.textContent).toContain(REVERT_TITLE);
  expect(dialog()?.textContent).toContain("Both documents go back to the saved JSON. This cannot be undone.");
  expect(textarea("Repositories").value).toBe(EDITED_REPOS);

  await click(dialogButton("Keep editing"));
  await tick();
  expect(dialog()).toBeNull();
  expect(textarea("Repositories").value).toBe(EDITED_REPOS);
  expect(textarea("Workflow").value).toBe("{}");
  expect(unsavedLabels()).toEqual(["Advanced JSON"]);
  expect(document.activeElement).toBe(button("Revert"));
  expect(mocks.call).not.toHaveBeenCalled();
});

it("restores the loaded JSON on a confirmed Revert and hands focus to the Advanced JSON section button", async () => {
  await mount(<Configurator initialSection="advanced" />);
  await setValue(textarea("Repositories"), EDITED_REPOS);
  await setValue(textarea("Workflow"), "{}");
  button("Revert").focus();
  await click(button("Revert"));
  await click(dialogButton("Revert"));
  await tick();
  expect(dialog()).toBeNull();
  expect(textarea("Repositories").value).toBe(mocks.config.repos);
  expect(textarea("Workflow").value).toBe(mocks.config.workflow);
  expect(unsavedLabels()).toEqual([]);
  expect(unsavedLine()).toBeNull();
  expect(button("Revert").disabled).toBe(true);
  expect(document.activeElement).toBe(navButton("Advanced JSON"));
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

  await confirmDiscard();
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
  expect(text()).toContain("Review › model choice 1: “Use when” must not be empty");
  expect(bar().textContent).not.toContain("Use when");
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Save changes"));
  expect(mocks.call).not.toHaveBeenCalled();
});

it("lists an over-long default model under General and next to the field, and keeps Save off", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field("Model"), "m".repeat(201));

  expect(bar().textContent).toContain("1 to fix before saving");
  expect(bar().textContent).not.toContain("Default model");
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

  await click(button("Show"));
  expect(summaries()).toEqual(["Workflows · 1 to fix"]);
  expect(button("Save changes").disabled).toBe(true);
  await click(button("Save changes"));
  expect(mocks.call).not.toHaveBeenCalled();
});

// ---------- a limit of 0 (#125) ----------
/** The hint or error under a field. */
const hintOf = (label: string) => field(label).parentElement!.textContent!.replace(label, "");
const saveBarWarnings = () => Array.from(container.querySelectorAll('[aria-label="Warnings"] li')).map((li) => li.textContent);

it("explains the capacity fields under General", async () => {
  await mount(<Configurator initialSection="general" />);
  expect(hintOf(MAX_TASKS)).toBe("Tasks running at once, across all repositories. 0 starts no new tasks.");
  expect(hintOf("Intake every (minutes)")).toBe("How often each repository is checked for new matching issues.");
});

it("warns in the save bar before a total of 0 is saved, and still saves it", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "0");
  expect(hintOf(MAX_TASKS)).toContain("0 starts no new tasks.");
  expect(saveBarWarnings()).toEqual(["General · Max tasks across all repos is 0: no new tasks will start until you raise it."]);
  expect(text()).not.toContain("to fix before saving");
  expect(button("Save changes").disabled).toBe(false);
  await click(button("Save changes"));
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith("cos_set_settings", { maxConcurrentTotal: 0 });
});

it("shows no capacity warning for a total above 0", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field(MAX_TASKS), "3");
  expect(text()).toContain("Unsaved changes");
  expect(saveBarWarnings()).toEqual([]);
});

it("explains a repository's limit and warns before a limit of 0 is saved", async () => {
  await mount(<Configurator initialSection="repos" />);
  await click(container.querySelector("article button[aria-expanded]")!);
  expect(hintOf("Max concurrent tasks")).toBe("Tasks running at once in this repository. 0 starts no new tasks here.");
  await setValue(field("Max concurrent tasks"), "0");
  expect(saveBarWarnings()).toEqual(["Repositories · acme/app: Max concurrent tasks is 0: no new tasks will start in this repository."]);
  expect(button("Save changes").disabled).toBe(false);
  await click(button("Save changes"));
  const [method, input] = mocks.call.mock.calls[0] as [string, { repos: string }];
  expect(method).toBe("cos_set_config");
  expect((JSON.parse(input.repos) as { repos: { maxConcurrent: number }[] }).repos[0]!.maxConcurrent).toBe(0);
});

it("lists at most five capacity warnings in the save bar", async () => {
  const repos = Array.from({ length: 7 }, (_, i) => ({ owner: "acme", repo: `app${i}`, projectId: "proj_1", maxConcurrent: 0 }));
  mocks.config = { ...mocks.config, repos: JSON.stringify({ repos }) };
  await mount(<Configurator initialSection="repos" />);
  await click(container.querySelector("article button[aria-expanded]")!);
  await setValue(field("Model"), "opus");
  expect(saveBarWarnings()).toHaveLength(6);
  expect(saveBarWarnings()[5]).toBe("and 2 more");
});

// ---------- the save bar: a count, and where to go, never the problems themselves ----------

/** In the Workflows list view, give the Review step a model choice without a “Use when”. */
async function breakReviewStep() {
  await click(button("List"));
  await click(Array.from(container.querySelectorAll("button[aria-expanded]"))[2]!);
  await click(button("Add a model choice"));
  await setValue(field("Model"), "haiku");
}

it("keeps the save bar to one collapsed row with the count and no problem text", async () => {
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "");
  await click(button("General"));
  await setValue(field("Model"), "m".repeat(201));

  expect(bar().textContent).toContain("2 to fix before saving");
  expect(bar().textContent).not.toContain("must");
  expect(bar().querySelector("ul")).toBeNull();
  expect(button("Show").getAttribute("aria-expanded")).toBe("false");
});

it("expands to the sections with problems, leaving out the one on screen", async () => {
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "");
  await click(button("General"));
  await setValue(field("Model"), "m".repeat(201));

  await click(button("Show"));
  expect(button("Hide").getAttribute("aria-expanded")).toBe("true");
  expect(summaries()).toEqual(["Workflows · 1 to fix"]);
  expect(bar().textContent).not.toContain("must");

  await click(button("Workflows · 1 to fix"));
  expect(container.querySelector('nav [aria-current="page"]')!.textContent).toContain("Workflows");
  expect(summaries()).toEqual(["General · 1 to fix"]);
});

it("does not reopen the summaries by itself after they ran out", async () => {
  await mount(<Configurator initialSection="workflow" />);
  await setValue(field("Name"), "");
  await click(button("General"));
  await click(button("Show"));
  await click(button("Workflows · 1 to fix"));
  // On Workflows nothing is off screen; coming back to General must not show the list unasked.
  await click(button("General"));
  expect(bar().querySelector("ul")).toBeNull();
  expect(button("Show").getAttribute("aria-expanded")).toBe("false");
});

it("does not expand when every problem is on screen", async () => {
  await mount(<Configurator initialSection="general" />);
  await setValue(field("Model"), "m".repeat(201));
  expect(button("Show").hasAttribute("aria-expanded")).toBe(false);
  await click(button("Show"));
  expect(bar().querySelector("ul")).toBeNull();
});

it("opens the repository a summary names", async () => {
  await mount(<Configurator initialSection="repos" />);
  await click(button("Add repository"));
  await click(button("General"));
  await click(button("Show"));
  expect(summaries()).toEqual(["Repositories · acme/app · 1 to fix"]);

  await click(button("Repositories · acme/app · 1 to fix"));
  expect(container.querySelector('nav [aria-current="page"]')!.textContent).toContain("Repositories");
  const open = Array.from(container.querySelectorAll("article button[aria-expanded]")).map((b) => b.getAttribute("aria-expanded"));
  expect(open).toEqual(["false", "true"]);
  expect(text()).toContain("duplicate of entry 1");
});

it("selects the step of the first workflow problem when its summary is used from another section", async () => {
  await mount(<Configurator initialSection="workflow" />);
  await breakReviewStep();
  await click(button("General"));
  expect(() => button("Remove Review")).toThrow();

  await click(button("Show"));
  await click(button("Workflows · 1 to fix"));
  // Canvas view, with Review's panel shown and its heading focused.
  expect(button("Remove Review")).toBeDefined();
  expect(document.activeElement?.closest("article")?.textContent).toContain("Review");

  // Going back by the section list does not select it again.
  await click(button("General"));
  await click(Array.from(container.querySelectorAll("nav button")).find((b) => b.textContent!.startsWith("Workflows"))!);
  expect(() => button("Remove Review")).toThrow();
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

it.each(["workflow", "repos", "both"] as const)("keeps saved %s drafts after a resolving failed refresh, then confirms them on Retry", async (documents) => {
  let stored = { ...mocks.config };
  mocks.call.mockImplementation(async (method: string, input: Partial<typeof stored>) => {
    if (method === "cos_set_settings") throw new Error("host unavailable");
    stored = { ...stored, ...input };
    return { ok: true, warnings: [] };
  });
  // The SDK retains old data and resolves the promise when a refresh fails.
  mocks.refetchConfig.mockImplementation(async () => { mocks.failed.config = "offline"; });
  await mount(<Configurator initialSection="workflow" />);
  if (documents !== "repos") await setValue(field("Name"), "Delivery");
  if (documents !== "workflow") {
    await click(navButton("Repositories"));
    await click(container.querySelector("article button[aria-expanded]")!);
    await setValue(field("Model"), "opus");
  }
  await click(navButton("General"));
  await setValue(field(MAX_TASKS), "5");
  await click(button("Save changes"));

  const documentSections = [
    ...(documents !== "repos" ? ["Workflows"] : []),
    ...(documents !== "workflow" ? ["Repositories1"] : []),
  ];
  expect(unsavedSections()).toEqual([...documentSections, "General"]);
  expect(text()).toContain("offline");
  expect(text()).toContain("drafts are kept");
  if (documents !== "repos") {
    await click(navButton("Workflows"));
    expect((field("Name") as HTMLInputElement).value).toBe("Delivery");
  }

  mocks.refetchConfig.mockImplementation(async () => {
    mocks.config = stored;
    mocks.failed.config = null;
  });
  await click(button("Retry"));
  expect(unsavedSections()).toEqual(["General"]);
  expect(text()).not.toContain("drafts are kept");
  expect(mocks.call).toHaveBeenCalledTimes(2); // Retry reads; it never repeats a write.
  await click(navButton("General"));
  expect(number(MAX_TASKS)).toBe("5");
});

it("keeps a saved draft when a successful read does not contain the saved values", async () => {
  mocks.refetchConfig.mockResolvedValue(undefined); // Resolves, but still exposes the old workflow.
  await halfSave();
  expect(unsavedSections()).toEqual(["Workflows", "General"]);
  expect(text()).toContain("drafts are kept");
  expect(button("Retry")).toBeDefined();
});

it("confirms the saved documents even when the General settings refresh rejects", async () => {
  mocks.refetchSettings.mockRejectedValue(new Error("settings offline"));
  await halfSave();
  expect(unsavedSections()).toEqual(["General"]);
  await click(navButton("Workflows"));
  expect((field("Name") as HTMLInputElement).value).toBe("Delivery");
});

it("does not clear a newer edit when Retry confirms an earlier saved draft", async () => {
  mocks.refetchConfig.mockImplementation(async () => { mocks.failed.config = "offline"; });
  await halfSave();
  await click(navButton("Workflows"));
  await setValue(field("Name"), "Newer edit");
  const [, saved] = mocks.call.mock.calls.find(([method]) => method === "cos_set_config")!;
  mocks.refetchConfig.mockImplementation(async () => {
    mocks.config = { ...mocks.config, ...saved };
    mocks.failed.config = null;
  });
  await click(button("Retry"));
  expect(unsavedSections()).toEqual(["Workflows", "General"]);
  expect((field("Name") as HTMLInputElement).value).toBe("Newer edit");
  expect(text()).not.toContain("drafts are kept");
});

function PersistentConfigurator({ visible }: { visible: boolean }) {
  const drafts = useConfigDrafts();
  return visible ? <Configurator drafts={drafts} /> : null;
}

it("keeps partial-save confirmation state across a dashboard tab switch", async () => {
  mocks.call.mockImplementation(async (method: string) => {
    if (method === "cos_set_settings") throw new Error("host unavailable");
    return { ok: true, warnings: [] };
  });
  mocks.refetchConfig.mockImplementation(async () => { mocks.failed.config = "offline"; });
  await mount(<PersistentConfigurator visible />);
  await setValue(field("Name"), "Delivery");
  await click(navButton("General"));
  await setValue(field(MAX_TASKS), "5");
  await click(button("Save changes"));
  await mount(<PersistentConfigurator visible={false} />);
  await mount(<PersistentConfigurator visible />);
  expect(unsavedSections()).toEqual(["Workflows", "General"]);
  expect((field("Name") as HTMLInputElement).value).toBe("Delivery");
  expect(text()).toContain("drafts are kept");

  const [, saved] = mocks.call.mock.calls.find(([method]) => method === "cos_set_config")!;
  mocks.refetchConfig.mockImplementation(async () => {
    mocks.config = { ...mocks.config, ...saved };
    mocks.failed.config = null;
  });
  await click(button("Retry"));
  expect(unsavedSections()).toEqual(["General"]);
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
    await confirmDiscard();

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
    await confirmDiscard();
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
