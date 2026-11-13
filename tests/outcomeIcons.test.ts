// The outcome icons through the real host translation table (component tests mock Icon).
import { expect, it, vi } from "vitest";
vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_Icon: () => null }));
import { HOST_ICON_NAMES } from "../components/ui/icon";
import { OUTCOME_META, OUTCOMES } from "../src/outcome";

it("resolves every outcome to its own host icon", () => {
  const resolved = OUTCOMES.map((o) => HOST_ICON_NAMES[OUTCOME_META[o].icon] ?? OUTCOME_META[o].icon);
  expect(new Set(resolved).size).toBe(OUTCOMES.length);
  expect(resolved).toContain("chief-of-staff/user-check");
  expect(resolved).toContain("chief-of-staff/user-x");
});
