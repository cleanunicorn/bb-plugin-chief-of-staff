import { describe, expect, it } from "vitest";
import type { Outcome } from "../src/outcome";
import { FINISHED_FIRST, FINISHED_STEP, NO_FILTER, dayLabel, finishDay, finishedTimer, groupByDay, isFiltering, matchesFinishedFilter, mergePages, outcomeGroup, visibleSlice } from "../components/cos/finishedModel";

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

describe("matchesFinishedFilter", () => {
  type Row = { outcome: Outcome | null; detail: string; repo: string; issueTitle: string; threadTitle: string | null; issueNumber: number | null; prNumber: number | null };
  const row = (over: Partial<Row> = {}): Row => ({ outcome: "merged", detail: "done", repo: "acme/app", issueTitle: "Fix login redirect", threadTitle: null, issueNumber: 12, prNumber: 34, ...over });

  it("matches everything without a filter", () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(matchesFinishedFilter(row(), NO_FILTER)).toBe(true);
  });

  it.each([
    ["merged", "shipped"],
    ["pr_opened", "shipped"],
    ["completed", "shipped"],
    ["marked_done", "marked_done"],
    ["failed", "failed"],
    ["marked_failed", "failed"],
    ["pr_closed", "failed"],
  ] as const)("filters %s by its outcome group %s", (outcome, group) => {
    const r = row({ outcome, detail: group === "failed" ? "failed" : "done" });
    expect(matchesFinishedFilter(r, { ...NO_FILTER, outcomes: [group] })).toBe(true);
    const others = (["shipped", "marked_done", "failed"] as const).filter((g) => g !== group);
    expect(matchesFinishedFilter(r, { ...NO_FILTER, outcomes: others })).toBe(false);
  });

  it("filters by repository", () => {
    expect(matchesFinishedFilter(row(), { ...NO_FILTER, repo: "acme/app" })).toBe(true);
    expect(matchesFinishedFilter(row(), { ...NO_FILTER, repo: "acme/api" })).toBe(false);
  });

  it("finds a title, case-insensitively, falling back to the thread title", () => {
    expect(matchesFinishedFilter(row(), { ...NO_FILTER, query: "  LOGIN " })).toBe(true);
    expect(matchesFinishedFilter(row(), { ...NO_FILTER, query: "logout" })).toBe(false);
    expect(matchesFinishedFilter(row({ issueTitle: "", threadTitle: "Tidy the docs" }), { ...NO_FILTER, query: "docs" })).toBe(true);
  });

  it("finds an issue or PR number, with or without #", () => {
    for (const query of ["12", "#12", "34", "#34"]) expect(matchesFinishedFilter(row(), { ...NO_FILTER, query })).toBe(true);
    expect(matchesFinishedFilter(row(), { ...NO_FILTER, query: "#1" })).toBe(false);
    expect(matchesFinishedFilter(row({ issueNumber: null, prNumber: null }), { ...NO_FILTER, query: "#12" })).toBe(false);
    // A number in the title still matches.
    expect(matchesFinishedFilter(row({ issueTitle: "Bump to v2026" }), { ...NO_FILTER, query: "2026" })).toBe(true);
  });

  it("combines filters: every one must match", () => {
    const filter = { ...NO_FILTER, outcomes: ["shipped", "marked_done"] as const, repo: "acme/app", query: "#12" };
    expect(isFiltering(filter)).toBe(true);
    expect(matchesFinishedFilter(row(), filter)).toBe(true);
    expect(matchesFinishedFilter(row({ repo: "acme/api" }), filter)).toBe(false);
    expect(matchesFinishedFilter(row({ outcome: "failed", detail: "failed" }), filter)).toBe(false);
    expect(matchesFinishedFilter(row({ issueNumber: 13, prNumber: null }), filter)).toBe(false);
  });
});
