// Usage fields survive the RPC contract: zod strips keys it does not declare,
// and the UI tests mock the RPC, so they would not notice.
import { expect, it } from "vitest";
import { rpcContract } from "../rpcContract";
import { entry } from "./helpers/roster";

it("keeps a roster entry's usage, with its thread counts and whether it is counted", () => {
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: { amount: 0.5, currency: "USD" }, threads: 5, reportedThreads: 4, counted: false };
  const parsed = rpcContract.cos_roster.output.parse({ entries: [entry({ usage })], nextBefore: null });
  expect(parsed.entries[0]!.usage).toEqual(usage);
});
