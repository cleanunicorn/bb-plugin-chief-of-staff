// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NewTaskForm } from "../components/cos/newTaskForm";

vi.mock("../components/ui/icon", () => ({ Icon: () => null }));

it("selects a repository that arrives after the form opens and submits it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const startTask = vi.fn().mockResolvedValue({});
  const props = { onCancel: vi.fn(), onStarted: vi.fn(), startTask };
  await act(async () => { root.render(<NewTaskForm {...props} repos={[]} />); });
  expect(container.textContent).toContain("Configure a repository first");
  await act(async () => { root.render(<NewTaskForm {...props} repos={["acme/app"]} />); });
  const select = container.querySelector("select")!;
  expect(select.value).toBe("acme/app");
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Fix login");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(button.disabled).toBe(false);
  await act(async () => { button.click(); });
  expect(startTask).toHaveBeenCalledWith({ repo: "acme/app", title: "Fix login", body: "" });
  await act(async () => { root.unmount(); });
  container.remove();
});

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
