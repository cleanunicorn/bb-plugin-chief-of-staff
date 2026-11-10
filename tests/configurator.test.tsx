// @vitest-environment jsdom
// The configurator's save path: dirty tracking, Save, Discard and live refetch.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const settingsValues = { maxConcurrentTotal: 8, stallThresholdMinutes: 30, intakeIntervalMinutes: 5, defaultProviderId: "", defaultModel: "", notifyPush: true, archiveThreadsOnDone: false };
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  refetch: { cos_get_config: vi.fn(), cos_get_settings: vi.fn() } as Record<string, ReturnType<typeof vi.fn>>,
  realtime: new Map<string, () => void>(),
  data: {} as Record<string, unknown>,
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: mocks.call }),
  useRealtime: (event: string, handler: () => void) => { mocks.realtime.set(event, handler); },
  experimental_useRpcQuery: ({ method }: { method: string }) => ({ data: mocks.data[method] ?? null, error: null, refetch: mocks.refetch[method] ?? vi.fn() }),
}));
vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
vi.mock("../components/cos/workflowCanvas", async (original) => ({ ...(await original()), WorkflowCanvas: () => null }));
import { Configurator } from "../components/cos/configurator";

const reposJson = JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1" }] });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function mount(section: "general" | "repos") {
  await act(async () => { root.render(<Configurator initialSection={section} />); });
}
const text = () => container.textContent ?? "";
const button = (label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
const navButton = (label: string) => Array.from(container.querySelectorAll('nav[aria-label="Configuration sections"] button')).find((b) => b.textContent?.includes(label))!;
function field(label: string): HTMLInputElement {
  const el = Array.from(container.querySelectorAll("label")).find((l) => l.textContent === label)!;
  return document.getElementById(el.htmlFor) as HTMLInputElement;
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el: Element | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => { (el as HTMLElement).click(); });
}
async function openRepo() {
  await click(container.querySelector('article button[aria-expanded="false"]')!);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.data = {
    cos_get_config: { repos: reposJson, workflow: "" },
    cos_get_settings: {
      values: { ...settingsValues },
      token: { stored: false, source: "gh-cli" },
      projects: [{ id: "proj_1", name: "App", remote: "https://github.com/acme/app" }, { id: "proj_2", name: "Api", remote: null }],
      providers: [],
    },
    cos_skills: { skills: [] },
  };
  mocks.call.mockReset();
  for (const fn of Object.values(mocks.refetch)) fn.mockReset().mockResolvedValue(undefined);
  mocks.realtime.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

it("shows no save bar on a clean load", async () => {
  await mount("general");
  expect(field("Max tasks across all repos").value).toBe("8");
  expect(text()).not.toContain("Unsaved changes");
  expect(button("Save changes")).toBeUndefined();
  expect(container.querySelector('[aria-label="unsaved"]')).toBeNull();
});

it("marks a general edit unsaved, and an edit back to the loaded value clean", async () => {
  await mount("general");
  await type(field("Max tasks across all repos"), "12");
  expect(text()).toContain("Unsaved changes");
  expect(navButton("General").querySelector('[aria-label="unsaved"]')).not.toBeNull();
  expect(navButton("Repositories").querySelector('[aria-label="unsaved"]')).toBeNull();
  await type(field("Max tasks across all repos"), "8");
  expect(text()).not.toContain("Unsaved changes");
});

it("Discard restores the loaded values and hides the bar", async () => {
  await mount("general");
  await type(field("Max tasks across all repos"), "12");
  await click(button("Discard"));
  expect(field("Max tasks across all repos").value).toBe("8");
  expect(text()).not.toContain("Unsaved changes");
  expect(mocks.call).not.toHaveBeenCalled();
});

it("saves a general edit with only the changed keys, refetches and clears the bar", async () => {
  mocks.call.mockResolvedValue({ ok: true, changed: ["maxConcurrentTotal"] });
  await mount("general");
  await type(field("Max tasks across all repos"), "12");
  await click(button("Save changes"));
  expect(mocks.call.mock.calls).toEqual([["cos_set_settings", { maxConcurrentTotal: 12 }]]);
  expect(mocks.refetch.cos_get_config).toHaveBeenCalledTimes(1);
  expect(mocks.refetch.cos_get_settings).toHaveBeenCalledTimes(1);
  expect(text()).not.toContain("Unsaved changes");
  expect(text()).toContain("Saved. Changes apply on the next intake and sweep.");
});

it("saves a repository edit through cos_set_config with repos only, and shows server warnings", async () => {
  mocks.call.mockResolvedValue({ ok: true, warnings: ["placeholder repo entry ignored"] });
  await mount("repos");
  await openRepo();
  await type(field("Max concurrent tasks"), "5");
  expect(navButton("Repositories").querySelector('[aria-label="unsaved"]')).not.toBeNull();
  await click(button("Save changes"));
  expect(mocks.call).toHaveBeenCalledTimes(1);
  const [method, input] = mocks.call.mock.calls[0]!;
  expect(method).toBe("cos_set_config");
  expect(Object.keys(input)).toEqual(["repos"]);
  const saved = JSON.parse(input.repos).repos;
  expect(saved).toHaveLength(1);
  expect([saved[0].owner, saved[0].repo, saved[0].projectId, saved[0].maxConcurrent]).toEqual(["acme", "app", "proj_1", 5]);
  expect(mocks.refetch.cos_get_config).toHaveBeenCalledTimes(1);
  expect(mocks.refetch.cos_get_settings).toHaveBeenCalledTimes(1);
  expect(text()).toContain("Saved. placeholder repo entry ignored");
  expect(text()).not.toContain("Unsaved changes");
});

it("keeps the draft and shows the error when saving fails", async () => {
  mocks.call.mockRejectedValue(new Error("database is locked"));
  await mount("general");
  await type(field("Max tasks across all repos"), "12");
  await click(button("Save changes"));
  expect(text()).toContain("database is locked");
  expect(text()).toContain("Unsaved changes");
  expect(field("Max tasks across all repos").value).toBe("12");
  expect(mocks.refetch.cos_get_config).not.toHaveBeenCalled();
});

it("disables Save and lists the problem while a repository is invalid", async () => {
  await mount("repos");
  await click(button("Add repository"));
  const save = button("Save changes") as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(text()).toContain("to fix before saving");
  expect(text()).toContain("Repositories · Repository 2: pick the BB project that holds the checkout");
  await click(save);
  expect(mocks.call).not.toHaveBeenCalled();
});

it("refetches on cos-changed only while there are no unsaved changes", async () => {
  await mount("general");
  await act(async () => mocks.realtime.get("cos-changed")!());
  expect(mocks.refetch.cos_get_config).toHaveBeenCalledTimes(1);
  expect(mocks.refetch.cos_get_settings).toHaveBeenCalledTimes(1);
  await type(field("Max tasks across all repos"), "12");
  await act(async () => mocks.realtime.get("cos-changed")!());
  expect(mocks.refetch.cos_get_config).toHaveBeenCalledTimes(1);
  expect(mocks.refetch.cos_get_settings).toHaveBeenCalledTimes(1);
});
