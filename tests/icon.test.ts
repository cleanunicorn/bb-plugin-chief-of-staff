// Host icon names: the host has its own catalog, and missing artwork falls
// back to a Circle, so PR states must stay distinct after the name mapping.
// (The UI tests mock Icon and skip the mapping; this is what proves it.)
import { expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_Icon: () => null }));
import { hostIconName } from "../components/ui/icon";
import { CHECKS_META, PR_STATE_META, REVIEW_META } from "../components/cos/prState";

const hostNames = (meta: Record<string, { icon: string }>) => Object.values(meta).map((m) => hostIconName(m.icon));

it.each([
  ["PR states", PR_STATE_META, 5],
  ["checks", CHECKS_META, 4],
  ["reviews", REVIEW_META, 2],
] as const)("gives each of the %s its own host icon, never the fallback", (_name, meta, count) => {
  const names = hostNames(meta);
  expect(names).toHaveLength(count);
  expect(new Set(names).size).toBe(count);
  expect(names).not.toContain("Circle");
});

it("maps names the host lacks and passes the rest through", () => {
  expect(hostIconName("Timer")).toBe("Clock");
  expect(hostIconName("GitMerge")).toBe("GitMerge");
});
