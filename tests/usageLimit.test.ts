import { describe, expect, it } from "vitest";
import { usageLimitResetAt, type TurnFailure } from "../src/usageLimit";

const window = (resetsAtMs: number | null, status = "blocked") => ({ status, resetsAtMs });
const failure = (over: Partial<TurnFailure> = {}): TurnFailure => ({
  errorInfo: { category: "rate-limit", httpStatusCode: null },
  rateLimits: { kind: "subscription-window", status: "blocked", windows: [window(1_000)] },
  ...over,
});

describe("usageLimitResetAt", () => {
  it("reads the reset of a blocked subscription window (the Claude or Codex 5-hour limit)", () => {
    expect(usageLimitResetAt(failure())).toBe(1_000);
    expect(usageLimitResetAt(failure({ errorInfo: { category: "unknown", httpStatusCode: 429 } }))).toBe(1_000);
  });

  it("waits for the latest of several blocked windows, ignoring open ones", () => {
    expect(usageLimitResetAt(failure({ rateLimits: { kind: "subscription-window", status: "blocked", windows: [window(5_000, "allowed"), window(2_000), window(3_000)] } }))).toBe(3_000);
  });

  it("is not a usage limit without a rate-limit error, a blocked subscription window, or a known reset", () => {
    expect(usageLimitResetAt(null)).toBeNull();
    expect(usageLimitResetAt(failure({ errorInfo: null }))).toBeNull();
    expect(usageLimitResetAt(failure({ errorInfo: { category: "overloaded", httpStatusCode: 529 } }))).toBeNull();
    expect(usageLimitResetAt(failure({ rateLimits: null }))).toBeNull();
    expect(usageLimitResetAt(failure({ rateLimits: { kind: "subscription-window", status: "warning", windows: [window(1_000)] } }))).toBeNull();
    expect(usageLimitResetAt(failure({ rateLimits: { kind: "subscription-window", status: "blocked", windows: [window(null)] } }))).toBeNull();
  });

  it("leaves credit and spend limits to a person: they do not reset on their own", () => {
    expect(usageLimitResetAt(failure({ rateLimits: { kind: "credits", status: "blocked", windows: [window(1_000)] } }))).toBeNull();
    expect(usageLimitResetAt(failure({ rateLimits: { kind: "spend-control", status: "blocked", windows: [window(1_000)] } }))).toBeNull();
  });
});
