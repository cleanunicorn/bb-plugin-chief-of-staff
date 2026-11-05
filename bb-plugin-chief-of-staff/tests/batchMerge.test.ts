import { describe, expect, it } from "vitest";
import { dependenciesOf, orderCandidates, planBatchMerge, type MergeCandidate } from "../src/routines/batchMergePlan";

const pr = (overrides: Partial<MergeCandidate> & { number: number }): MergeCandidate => ({
  title: `PR ${overrides.number}`,
  headRef: `cos/issue-${overrides.number}-x`,
  baseRef: "main",
  createdAt: `2026-11-0${overrides.number}T00:00:00Z`,
  labels: [],
  draft: false,
  approved: true,
  changesRequested: false,
  ci: "passing",
  mergeable: true,
  body: null,
  author: "bot",
  ...overrides,
});
const options = { branchPrefix: "cos/", onlyOwnBranches: true, labels: [], requireApproval: true, defaultBranch: "main" };

describe("batch merge planning", () => {
  it("parses dependency references", () => {
    expect(dependenciesOf("Depends on #4 and blocked by PR #9. After #4.")).toEqual([4, 9]);
    expect(dependenciesOf(null)).toEqual([]);
  });

  it("orders by creation time, then by declared dependencies", () => {
    const ordered = orderCandidates([pr({ number: 1, body: "depends on #3" }), pr({ number: 2 }), pr({ number: 3 })]);
    expect(ordered.map((p) => p.number)).toEqual([3, 1, 2]);
  });

  it("falls back to creation order on dependency cycles", () => {
    const ordered = orderCandidates([pr({ number: 1, body: "depends on #2" }), pr({ number: 2, body: "depends on #1" })]);
    expect(ordered.map((p) => p.number)).toEqual([2, 1]);
  });

  it("merges only green, approved, non-draft PRs on own branches", () => {
    const plan = planBatchMerge(
      [
        pr({ number: 1 }),
        pr({ number: 2, ci: "failing" }),
        pr({ number: 3, approved: false }),
        pr({ number: 4, draft: true }),
        pr({ number: 5, headRef: "feature/manual" }),
        pr({ number: 6, ci: "pending" }),
        pr({ number: 7, changesRequested: true }),
        pr({ number: 8, baseRef: "develop" }),
      ],
      options,
    );
    const byNumber = Object.fromEntries(plan.decisions.map((d) => [d.number, d]));
    expect(byNumber[1].action).toBe("merge");
    expect(byNumber[2]).toMatchObject({ action: "skip", reason: "CI failing" });
    expect(byNumber[3]).toMatchObject({ action: "skip", reason: "not approved" });
    expect(byNumber[4]).toMatchObject({ action: "skip", reason: "draft" });
    expect(byNumber[5].action).toBe("skip");
    expect(byNumber[6]).toMatchObject({ action: "skip", reason: "CI pending" });
    expect(byNumber[7]).toMatchObject({ action: "skip", reason: "changes requested" });
    expect(byNumber[8].action).toBe("skip");
  });

  it("treats recorded work-item branches as own branches", () => {
    const plan = planBatchMerge([pr({ number: 1, headRef: "bb/worktree-123" })], { ...options, ownBranches: new Set(["bb/worktree-123"]) });
    expect(plan.decisions[0].action).toBe("merge");
  });

  it("reports conflicts separately and skips dependents of unmerged PRs", () => {
    const plan = planBatchMerge([pr({ number: 1, mergeable: false, mergeableState: "dirty" }), pr({ number: 2, body: "depends on #1" }), pr({ number: 3, mergeable: null })], options);
    expect(plan.decisions.find((d) => d.number === 1)).toMatchObject({ action: "conflict" });
    expect(plan.decisions.find((d) => d.number === 2)).toMatchObject({ action: "skip", reason: "depends on unmerged #1" });
    expect(plan.decisions.find((d) => d.number === 3)).toMatchObject({ action: "skip" });
  });

  it("honours label filters and optional approval", () => {
    const plan = planBatchMerge([pr({ number: 1, labels: ["ship"], approved: false }), pr({ number: 2, approved: false })], { ...options, labels: ["ship"], requireApproval: false });
    expect(plan.decisions.find((d) => d.number === 1)?.action).toBe("merge");
    expect(plan.decisions.find((d) => d.number === 2)).toMatchObject({ action: "skip", reason: "missing label(s) ship" });
  });
});
