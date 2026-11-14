import { describe, expect, it } from "vitest";
import { FINISHED_FIRST, FINISHED_STEP, dayLabel, finishDay, finishedTimer, groupByDay, mergePages, outcomeGroup, visibleSlice } from "../components/cos/finishedModel";

const NOW = Date.parse("2026-11-14T15:00:00.000Z");

describe("finishDay", () => {
  it("is the UTC day of the finish time, like Throughput", () => {
    expect(finishDay({ finishedAt: "2026-11-14T00:30:00.000Z" })).toBe("2026-11-14");
    expect(finishDay({ finishedAt: "2026-11-13T23:59:59.000Z" })).toBe("2026-11-13");
    // An offset time is read as the instant it names.
    expect(finishDay({ finishedAt: "2026-11-14T01:00:00+02:00" })).toBe("2026-11-13");
  });

  it("is null without a usable finish time", () => {
    expect(finishDay({ finishedAt: null })).toBeNull();
    expect(finishDay({ finishedAt: "not a date" })).toBeNull();
  });
});

describe("dayLabel", () => {
  it("says Today, Yesterday, then the short date", () => {
    expect(dayLabel("2026-11-14", NOW)).toBe("Today");
    expect(dayLabel("2026-11-13", NOW)).toBe("Yesterday");
    expect(dayLabel("2026-11-08", NOW)).toBe(new Date("2026-11-08T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }));
  });

  it("counts days in UTC, so a minute past UTC midnight is a new day", () => {
    const justAfter = Date.parse("2026-11-15T00:01:00.000Z");
    expect(dayLabel("2026-11-15", justAfter)).toBe("Today");
    expect(dayLabel("2026-11-14", justAfter)).toBe("Yesterday");
  });
});

describe("outcomeGroup", () => {
  it.each([
    ["merged", "shipped"],
    ["pr_opened", "shipped"],
    ["completed", "shipped"],
    ["marked_done", "marked_done"],
    ["failed", "failed"],
    ["marked_failed", "failed"],
    ["pr_closed", "failed"],
  ] as const)("puts %s under %s", (outcome, group) => {
    expect(outcomeGroup({ outcome, detail: group === "failed" ? "failed" : "done" })).toBe(group);
  });

  it("falls back to the status without an outcome", () => {
    expect(outcomeGroup({ outcome: null, detail: "done" })).toBe("shipped");
    expect(outcomeGroup({ outcome: null, detail: "failed" })).toBe("failed");
    expect(outcomeGroup({ outcome: null, detail: "agent" })).toBeNull();
  });
});

describe("groupByDay", () => {
  const row = (id: string, finishedAt: string | null) => ({ id, finishedAt });

  it("groups by finish day in the given order, newest first, with unknown finish times last under Earlier", () => {
    const groups = groupByDay([row("a", "2026-11-14T10:00:00Z"), row("legacy", null), row("b", "2026-11-14T01:00:00Z"), row("c", "2026-11-13T22:00:00Z"), row("d", "2026-11-08T09:00:00Z")], NOW);
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      [dayLabel("2026-11-08", NOW), ["d"]],
      ["Earlier", ["legacy"]],
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-11-14", "2026-11-13", "2026-11-08", "earlier"]);
  });

  it("returns no groups for no rows", () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe("visibleSlice", () => {
  it("shows the first ten, then twenty more per step", () => {
    const list = Array.from({ length: 45 }, (_, i) => i);
    expect(FINISHED_FIRST).toBe(10);
    expect(FINISHED_STEP).toBe(20);
    expect(visibleSlice(list, FINISHED_FIRST)).toEqual({ rows: list.slice(0, 10), more: true });
    expect(visibleSlice(list, FINISHED_FIRST + FINISHED_STEP)).toEqual({ rows: list.slice(0, 30), more: true });
    expect(visibleSlice(list, 50)).toEqual({ rows: list, more: false });
  });
});

describe("mergePages", () => {
  const e = (id: string, detail = "done") => ({ id, detail });

  it("keeps the first page's order, appends older pages without duplicates, and drops active tasks", () => {
    const first = [e("a", "agent"), e("f1"), e("f2", "failed")];
    const older = [e("f2", "failed"), e("f3"), e("retried")];
    expect(mergePages(first, older, new Set(["retried"])).map((x) => x.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("prefers the first page's copy of a task", () => {
    const first = [{ id: "f1", detail: "done", title: "new" }];
    const older = [{ id: "f1", detail: "done", title: "old" }];
    expect(mergePages(first, older, new Set())).toEqual([{ id: "f1", detail: "done", title: "new" }]);
  });
});

describe("finishedTimer", () => {
  it("says when the task finished and how long it took", () => {
    const finishedAt = new Date(NOW - 2 * 3_600_000).toISOString();
    const startedAt = new Date(Date.parse(finishedAt) - 72 * 60_000).toISOString();
    const timer = finishedTimer({ startedAt, finishedAt }, NOW);
    expect(timer.text).toBe("Finished 2h ago · took 1.2h");
    expect(timer.label).toBe("Finished 2h ago, took 1.2h");
    expect(timer.title).toBe(`Finished ${new Date(finishedAt).toLocaleString()} · started ${new Date(startedAt).toLocaleString()}`);
  });

  it("says only when it started without a finish time", () => {
    const timer = finishedTimer({ startedAt: new Date(NOW - 8 * 86_400_000).toISOString(), finishedAt: null }, NOW);
    expect(timer.text).toBe("Started 8d ago");
    expect(timer.label).toBe("Started 8d ago");
  });
});
