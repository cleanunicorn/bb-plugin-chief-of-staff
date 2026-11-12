import { expect, it } from "vitest";
import { createRowKeys } from "../components/cos/rowKeys";

it("keeps a row's key across edits and gives other rows their own", () => {
  const keys = createRowKeys<{ name: string }>();
  const a = { name: "a" };
  const b = { name: "a" };
  expect(keys.key(a)).toBe(keys.key(a));
  expect(keys.key(b)).not.toBe(keys.key(a));
  const edited = keys.carry(a, { ...a, name: "ab" });
  expect(keys.key(edited)).toBe(keys.key(a));
  // After removing `a`, `b` keeps its key, so it does not take over a's component.
  const rows = [a, b].filter((r) => r !== a);
  expect(rows.map(keys.key)).toEqual([keys.key(b)]);
  expect(keys.key(a)).not.toBe(keys.key(b));
});
