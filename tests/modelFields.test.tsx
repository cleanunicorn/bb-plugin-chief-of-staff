// @vitest-environment jsdom
// The model fields suggest bb's providers, the chosen provider's models (the
// default provider's when none is set), and the chosen model's reasoning levels.
import { afterEach, expect, it, vi } from "vitest";
import { container, field, mount, setValue, unmount } from "./dom";

const calls = vi.hoisted(() => [] as { providerId: string; enabled: boolean | undefined }[]);
vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useRpcQuery: ({ input, enabled }: { input: { providerId: string }; enabled?: boolean }) => {
    calls.push({ providerId: input.providerId, enabled });
    if (enabled === false) return { data: undefined, error: null, isLoading: false, refetch: vi.fn() };
    const models = input.providerId === "codex"
      ? [{ id: "gpt-6", displayName: "GPT-6", isDefault: true, reasoningLevels: [], defaultReasoningLevel: null }]
      : [{ id: "claude-opus-5-5", displayName: "Opus 5.5", isDefault: true, reasoningLevels: ["low", "high", "max"], defaultReasoningLevel: "high" }, { id: "claude-haiku-5-5", displayName: "Haiku 5.5", isDefault: false, reasoningLevels: [], defaultReasoningLevel: null }];
    return { data: { models, error: null }, error: null, isLoading: false, refetch: vi.fn() };
  },
}));
import { ModelFields, type ModelCatalog, type ModelValues } from "../components/cos/modelFields";

afterEach(() => {
  calls.length = 0;
  return unmount();
});

const catalog: ModelCatalog = {
  providers: [
    { id: "claude-code", displayName: "Claude Code", available: true, enabled: true },
    { id: "codex", displayName: "Codex", available: false, enabled: true },
    { id: "pi", displayName: "Pi", available: true, enabled: false },
  ],
  defaultProviderId: "claude-code",
};

/** The suggestions the input labelled `label` offers, as value → label. */
const suggestions = (label: string) => {
  const list = field(label).getAttribute("list");
  if (!list) return null;
  return Object.fromEntries(Array.from(container.querySelectorAll<HTMLOptionElement>(`datalist[id="${list}"] option`)).map((o) => [o.value, o.getAttribute("label") ?? ""]));
};

async function render(value: ModelValues, onChange = vi.fn()) {
  await mount(<ModelFields value={value} onChange={onChange} catalog={catalog} error={() => undefined} />);
  return onChange;
}

it("suggests the enabled providers, marking unavailable ones", async () => {
  await render({});
  expect(suggestions("Agent (provider)")).toEqual({ "claude-code": "Claude Code", codex: "Codex (unavailable)" });
});

it("suggests the chosen provider's models and the chosen model's reasoning levels", async () => {
  await render({ providerId: "codex" });
  expect(suggestions("Model")).toEqual({ "gpt-6": "GPT-6 (default)" });
  await render({ providerId: "claude-code", model: "claude-opus-5-5" });
  expect(suggestions("Model")).toEqual({ "claude-opus-5-5": "Opus 5.5 (default)", "claude-haiku-5-5": "Haiku 5.5" });
  expect(suggestions("Reasoning level")).toEqual({ low: "", high: "default", max: "" });
  expect(container.textContent).toContain("Opus 5.5: low, high, max");
});

it("suggests the default provider's models when no provider is set, and says so", async () => {
  await render({});
  expect(calls.at(-1)).toEqual({ providerId: "claude-code", enabled: true });
  expect(suggestions("Model")).toMatchObject({ "claude-opus-5-5": "Opus 5.5 (default)" });
  expect(container.textContent).toContain("Suggestions from the default agent (claude-code).");
  // No level list for a model that is not picked (or has none).
  expect(suggestions("Reasoning level")).toBeNull();
});

it("does not look up a provider bb does not know, and keeps accepting any text", async () => {
  const onChange = await render({ providerId: "my-own" });
  expect(calls.at(-1)?.enabled).toBe(false);
  expect(suggestions("Model")).toBeNull();
  await setValue(field("Model"), "custom-model");
  expect(onChange).toHaveBeenLastCalledWith({ model: "custom-model" });
  await setValue(field("Agent (provider)"), "");
  expect(onChange).toHaveBeenLastCalledWith({ providerId: undefined });
});
