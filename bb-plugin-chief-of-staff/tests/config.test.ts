import { describe, expect, it } from "vitest";
import { issueBranchName, parseRepos, parseRoutines, SEED_REPOS, SEED_ROUTINES, slugify } from "../src/config";
import { nextVersion, conventionalBump } from "../src/version";

describe("config parsing", () => {
  it("ignores the seed placeholder repo with a warning", () => {
    const result = parseRepos(JSON.stringify(SEED_REPOS));
    expect(result.ok && result.value).toEqual([]);
    expect(result.ok && result.warnings[0]).toMatch(/placeholder/);
  });

  it("applies defaults and least-privilege allow flags", () => {
    const result = parseRepos(JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1" }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].allow).toEqual({ intake: true, openPr: true, merge: false, release: false, deploy: false });
    expect(result.value[0].issueFilter.labels).toEqual(["agent-ready"]);
    expect(result.value[0].branchPrefix).toBe("cos/");
  });

  it("rejects invalid JSON and schema errors", () => {
    expect(parseRepos("{").ok).toBe(false);
    const bad = parseRoutines(JSON.stringify({ routines: [{ name: "x", repo: "nope", steps: [] }] }));
    expect(bad.ok).toBe(false);
  });

  it("parses the seeded Nightly ship routine", () => {
    const result = parseRoutines(JSON.stringify(SEED_ROUTINES));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].steps.map((s) => s.type)).toEqual(["batch_merge", "release", "deploy"]);
    expect(result.value[0].cron).toBe("0 2 * * *");
    expect(result.value[0].enabled).toBe(false);
  });

  it("builds branch names", () => {
    expect(slugify("Fix: Login Page crashes!!")).toBe("fix-login-page-crashes");
    expect(issueBranchName({ branchPrefix: "cos/" }, 42, "Add OAuth support")).toBe("cos/issue-42-add-oauth-support");
  });
});

describe("version strategies", () => {
  it("bumps semver", () => {
    expect(nextVersion("v1.2.3", "patch", { prefix: "v" })).toBe("1.2.4");
    expect(nextVersion("v1.2.3", "minor", { prefix: "v" })).toBe("1.3.0");
    expect(nextVersion(null, "major", { prefix: "v" })).toBe("1.0.0");
  });
  it("derives conventional bumps from merged PR titles", () => {
    expect(conventionalBump(["fix: a", "feat: b"])).toBe("minor");
    expect(conventionalBump(["feat!: breaking"])).toBe("major");
    expect(nextVersion("v1.0.0", "conventional", { prefix: "v", mergedTitles: ["fix: x"] })).toBe("1.0.1");
  });
  it("produces calver with collision suffixes", () => {
    const now = new Date("2026-11-05T10:00:00Z");
    expect(nextVersion(null, "calver", { prefix: "v", now })).toBe("2026.11.05");
    expect(nextVersion(null, "calver", { prefix: "v", now, existingCalverTags: ["v2026.11.05"] })).toBe("2026.11.05.1");
  });
});
