// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SkillTextarea } from "../components/cos/skillTextarea";

vi.mock("../components/ui/icon", () => ({ Icon: () => null }));
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("points aria-controls at the suggestion list only while the list exists", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const render = (value: string) => act(async () => { root.render(<SkillTextarea value={value} onChange={onChange} skills={[{ name: "build", description: "Implement a plan" }, { name: "review", description: null }] as never} />); });
  await render("");
  const textarea = container.querySelector("textarea")!;
  expect(textarea.getAttribute("aria-expanded")).toBe("false");
  expect(textarea.hasAttribute("aria-controls")).toBe(false);

  await render("/bu");
  await act(async () => {
    textarea.focus();
    textarea.setSelectionRange(3, 3);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
  });
  expect(textarea.getAttribute("aria-expanded")).toBe("true");
  const list = document.getElementById(textarea.getAttribute("aria-controls")!)!;
  expect(list.getAttribute("role")).toBe("listbox");
  expect(document.getElementById(textarea.getAttribute("aria-activedescendant")!)?.textContent).toContain("/build");

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(textarea.getAttribute("aria-expanded")).toBe("false");
  expect(textarea.hasAttribute("aria-controls")).toBe(false);
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => { root.unmount(); });
});
