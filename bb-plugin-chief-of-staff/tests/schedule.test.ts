import { describe, expect, it } from "vitest";
import { dueRoutines, intervalToMs, isDue, nextFireTime, validateCron } from "../src/schedule";
import type { Routine } from "../src/config";

const nightly: Routine = { name: "Nightly ship", enabled: true, cron: "0 2 * * *", timezone: "UTC", repo: "acme/app", dryRun: false, continueOnError: false, steps: [{ type: "notify", title: "x" }] };

describe("routine scheduling", () => {
  it("validates cron expressions", () => {
    expect(validateCron("0 2 * * *")).toBeNull();
    expect(validateCron("99 2 * * *")).not.toBeNull();
  });

  it("parses intervals", () => {
    expect(intervalToMs("30m")).toBe(30 * 60_000);
    expect(intervalToMs("6h")).toBe(6 * 3_600_000);
    expect(() => intervalToMs("1w")).toThrow();
  });

  it("is due once after the cron time and not again until the next fire", () => {
    const at0200 = new Date("2026-11-06T02:00:30Z");
    expect(isDue(nightly, at0200, null)).toBe(true);
    expect(isDue(nightly, at0200, at0200)).toBe(false);
    const later = new Date("2026-11-06T13:00:00Z");
    expect(isDue(nightly, later, new Date("2026-11-05T02:00:00Z"))).toBe(true);
    expect(isDue(nightly, later, new Date("2026-11-06T02:00:30Z"))).toBe(false);
  });

  it("does not fire a never-run routine for a fire time outside the catch-up window", () => {
    const noon = new Date("2026-11-06T12:00:00Z");
    expect(isDue(nightly, noon, null)).toBe(false);
  });

  it("supports intervals relative to the last run", () => {
    const every = { ...nightly, cron: undefined, every: "30m" };
    const now = new Date("2026-11-06T12:00:00Z");
    expect(isDue(every, now, null)).toBe(true);
    expect(isDue(every, now, new Date("2026-11-06T11:45:00Z"))).toBe(false);
    expect(isDue(every, now, new Date("2026-11-06T11:29:00Z"))).toBe(true);
    expect(nextFireTime(every, now, new Date("2026-11-06T11:45:00Z"))?.toISOString()).toBe("2026-11-06T12:15:00.000Z");
  });

  it("respects enabled flags and runtime overrides", () => {
    const at0200 = new Date("2026-11-06T02:00:30Z");
    expect(dueRoutines([nightly], at0200, new Map(), new Map([["Nightly ship", false]]))).toEqual([]);
    expect(dueRoutines([{ ...nightly, enabled: false }], at0200, new Map(), new Map([["Nightly ship", true]])).length).toBe(1);
    expect(dueRoutines([{ ...nightly, enabled: false }], at0200, new Map(), new Map()).length).toBe(0);
  });
});
