import { describe, expect, it } from "vitest";
import { issueBranchName, parseGitHubRemote, parseRepos, SEED_REPOS, slugify } from "../src/config";

describe("config parsing", () => {
  it("ignores the seed placeholder repo with a warning", () => {
    const result = parseRepos(JSON.stringify(SEED_REPOS));
    expect(result.ok && result.value).toEqual([]);
    expect(result.ok && result.warnings[0]).toMatch(/placeholder/);
  });

  it("applies defaults", () => {
    const result = parseRepos(JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1" }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ intake: true, issueComments: true, briefComments: "trusted", maxConcurrent: 2, mergeStrategy: "squash", reviewers: [], issueFilter: { labels: ["agent-ready"] } });
    expect(result.value[0].workflow).toBeUndefined();
  });

  it("keeps issue comments on unless a repository turns them off", () => {
    const parse = (extra: object) => {
      const result = parseRepos(JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", ...extra }] }));
      if (!result.ok) throw new Error(result.error);
      return result.value[0].issueComments;
    };
    expect(parse({})).toBe(true);
    expect(parse({ issueComments: false })).toBe(false);
  });

  it("quotes only trusted comments in the brief unless a repository chooses otherwise", () => {
    const parse = (extra: object) => parseRepos(JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", ...extra }] }));
    const value = (extra: object) => {
      const result = parse(extra);
      if (!result.ok) throw new Error(result.error);
      return result.value[0].briefComments;
    };
    expect(value({})).toBe("trusted");
    expect(value({ briefComments: "all" })).toBe("all");
    expect(value({ briefComments: "none" })).toBe("none");
    expect(parse({ briefComments: "everyone" }).ok).toBe(false);
  });

  it("folds legacy keys into the current shape and drops the rest", () => {
    const legacy = {
      owner: "acme", repo: "app", projectId: "proj_1",
      checkCommand: "npm test", allow: { intake: false, openPr: true, merge: true, release: true, deploy: true },
      mergeFilter: { requireApproval: false, onlyOwnBranches: true, labels: [] },
      issueFilter: { labels: ["bot"], milestone: "v2", numbers: [3] },
      deployCommand: "./deploy.sh", versionStrategy: "minor", branchPrefix: "x/",
    };
    const result = parseRepos(JSON.stringify({ repos: [legacy] }));
    if (!result.ok) throw new Error(result.error);
    const repo = result.value[0] as unknown as Record<string, unknown>;
    expect(repo.intake).toBe(false);
    expect(repo.workflow).toEqual({ verify: { command: "npm test" }, ship: { requireApproval: false } });
    expect(repo.issueFilter).toEqual({ labels: ["bot"] });
    for (const gone of ["checkCommand", "allow", "mergeFilter", "deployCommand", "versionStrategy", "branchPrefix"]) expect(repo[gone]).toBeUndefined();
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
    expect(parseRepos(JSON.stringify({ repos: [{ projectId: "p", maxConcurrent: "lots" }] })).ok).toBe(false);
  });

  it("builds branch names", () => {
    expect(slugify("Fix: Login Page crashes!!")).toBe("fix-login-page-crashes");
    expect(issueBranchName(42, "Add OAuth support")).toBe("cos/issue-42-add-oauth-support");
  });
});
