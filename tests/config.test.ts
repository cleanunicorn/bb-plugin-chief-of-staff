import { describe, expect, it } from "vitest";
import { issueBranchName, parseGitHubRemote, parseRepos, parseRoutines, SEED_REPOS, SEED_ROUTINES, slugify } from "../src/config";
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

  it("parses GitHub remote URLs", () => {
    expect(parseGitHubRemote("https://github.com/Theralexis/canary.git")).toEqual({ owner: "Theralexis", repo: "canary" });
    expect(parseGitHubRemote("https://github.com/EdenBlockVC/deals")).toEqual({ owner: "EdenBlockVC", repo: "deals" });
    expect(parseGitHubRemote("git@github.com:cleanunicorn/earheart.git")).toEqual({ owner: "cleanunicorn", repo: "earheart" });
    expect(parseGitHubRemote("ssh://git@github.com/acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(parseGitHubRemote("https://x-access-token:abc@github.com/acme/my.app/")).toEqual({ owner: "acme", repo: "my.app" });
    expect(parseGitHubRemote("https://gitlab.com/acme/app.git")).toBeNull();
    expect(parseGitHubRemote(null)).toBeNull();
  });

  it("infers owner/repo from the BB project remote", () => {
    const projects = new Map([["proj_1", "git@github.com:acme/app.git"]]);
    const result = parseRepos(JSON.stringify({ repos: [{ projectId: "proj_1" }] }), projects);
    expect(result.ok && result.value.map((r) => `${r.owner}/${r.repo}`)).toEqual(["acme/app"]);
    expect(result.ok && result.warnings).toEqual([]);
  });

  it("lets explicit owner/repo override the remote, with a mismatch warning", () => {
    const projects = new Map([["proj_1", "https://github.com/acme/app"]]);
    const result = parseRepos(JSON.stringify({ repos: [{ projectId: "proj_1", owner: "acme", repo: "fork" }] }), projects);
    expect(result.ok && result.value[0].repo).toBe("fork");
    expect(result.ok && result.warnings[0]).toMatch(/differs from project proj_1 remote acme\/app/);
  });

  it("skips entries it cannot resolve, warning only when projects are known", () => {
    const doc = JSON.stringify({ repos: [{ projectId: "proj_none" }, { projectId: "proj_gl" }] });
    const projects = new Map([["proj_gl", "https://gitlab.com/acme/app.git"]]);
    const resolved = parseRepos(doc, projects);
    expect(resolved.ok && resolved.value).toEqual([]);
    expect(resolved.ok && resolved.warnings).toEqual([expect.stringMatching(/proj_none not found/), expect.stringMatching(/proj_gl has no GitHub remote/)]);
    // Synchronous settings validation (no project list) accepts the document.
    const validated = parseRepos(doc);
    expect(validated.ok && validated.warnings).toEqual([]);
  });

  it("dedupes repos resolved to the same owner/repo", () => {
    const projects = new Map([["proj_1", "https://github.com/acme/app"]]);
    const result = parseRepos(JSON.stringify({ repos: [{ projectId: "proj_1" }, { projectId: "proj_2", owner: "acme", repo: "app" }] }), projects);
    expect(result.ok && result.value).toHaveLength(1);
    expect(result.ok && result.warnings[0]).toMatch(/duplicate repo acme\/app/);
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
