import { describe, expect, it } from "vitest";
import { parseRepos } from "../src/config";
import type { RepoConfig } from "../src/config";
import { blankRepo, detachWorkflow, inferIdentity, loadRepos, parseList, parseRepoSlug, selectProject, serializeRepos, validateRepos } from "../src/configModel";

const reposJson = JSON.stringify({
  repos: [
    { owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, workflow: { review: { enabled: false } } },
    { owner: "acme", repo: "api", projectId: "proj_2" },
  ],
});

describe("configModel", () => {
  it("loads several repos with defaults and round-trips through serialize", () => {
    const loaded = loadRepos(reposJson);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[1]!.maxConcurrent).toBe(2);
    expect(loaded.items[1]!.intake).toBe(true);
    expect(loaded.items[0]!.workflow).toEqual({ review: { enabled: false } });
    const again = loadRepos(serializeRepos(loaded.items));
    expect(again).toEqual(loaded);
    const server = parseRepos(serializeRepos(loaded.items));
    if (!server.ok) throw new Error(server.error);
    expect(server.value.map((r) => `${r.owner}/${r.repo}`)).toEqual(["acme/app", "acme/api"]);
  });

  it("keeps entries that only miss their identity so they can be fixed", () => {
    const loaded = loadRepos(JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "" }, { owner: "acme", repo: "api", projectId: "p" }] }));
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.items.map((r) => r.projectId)).toEqual(["", "p"]);
    expect(validateRepos(loaded.items)[0]!.join(" ")).toMatch(/BB project/);
    expect(loadRepos(JSON.stringify({ repos: [{ owner: "a", repo: "b", projectId: "p", maxConcurrent: "lots" }] })).ok).toBe(false);
  });

  it("reports load errors instead of throwing", () => {
    expect(loadRepos("{nope").ok).toBe(false);
    expect(loadRepos("").ok).toBe(true);
  });

  it("drops blank optional strings when serializing", () => {
    const repo = { ...blankRepo("proj_1"), owner: "acme", repo: "app", model: "  ", providerId: " codex " };
    const out = JSON.parse(serializeRepos([repo])).repos[0];
    expect(out.model).toBeUndefined();
    expect(out.providerId).toBe("codex");
  });

  it("starts new repos with defaults and a blank identity", () => {
    expect(blankRepo()).toMatchObject({ owner: "", repo: "", projectId: "", intake: true, maxConcurrent: 2 });
  });

  it("does not let the seeded placeholder entry block saving", () => {
    const loaded = loadRepos(JSON.stringify({ repos: [{ projectId: "proj_xxxxxxxxxx", issueFilter: { labels: ["agent-ready"] }, maxConcurrent: 2 }] }));
    if (!loaded.ok) throw new Error(loaded.error);
    expect(validateRepos(loaded.items)).toEqual({});
    expect(validateRepos([{ ...loaded.items[0]!, projectId: "" }])[0]).toBeTruthy();
  });

  it("loads legacy entries with their old keys folded in", () => {
    const loaded = loadRepos(JSON.stringify({ repos: [{ projectId: "p", checkCommand: "make test", allow: { intake: false } }] }));
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.items[0]).toMatchObject({ intake: false, workflow: { verify: { command: "make test" } } });
  });

  it("validates missing identity, duplicates and project", () => {
    const loaded = loadRepos(reposJson);
    if (!loaded.ok) throw new Error();
    const issues = validateRepos([...loaded.items, { ...loaded.items[0]! }, blankRepo()]);
    expect(issues[0]).toBeUndefined();
    expect(issues[2]).toContain("duplicate of entry 1");
    expect(issues[3]!.join(" ")).toMatch(/owner\/repo/);
    expect(issues[3]!.join(" ")).toMatch(/BB project/);
  });

  it("parses repo slugs from several forms", () => {
    expect(parseRepoSlug("acme/app")).toEqual({ owner: "acme", repo: "app" });
    expect(parseRepoSlug("https://github.com/acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(parseRepoSlug("git@github.com:acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(parseRepoSlug("acme")).toBeNull();
    expect(parseList("a, b ,,c")).toEqual(["a", "b", "c"]);
  });

});

describe("project-inferred repository", () => {
  const projects = [
    { id: "proj_a", remote: "git@github.com:acme/app.git" },
    { id: "proj_b", remote: "https://github.com/acme/api" },
    { id: "proj_gl", remote: "https://gitlab.com/acme/x.git" },
  ];

  it("loads a projectId-only entry and shows the inferred repository", () => {
    const loaded = loadRepos(JSON.stringify({ repos: [{ projectId: "proj_a" }] }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.items[0]).toMatchObject({ owner: "", repo: "" });
    const shown = inferIdentity(loaded.items[0]!, projects);
    expect(`${shown.owner}/${shown.repo}`).toBe("acme/app");
    expect(validateRepos([shown])).toEqual({});
  });

  it("fills the repository when a project is picked, and follows project changes", () => {
    const picked = selectProject(blankRepo(), "proj_a", projects);
    expect(`${picked.owner}/${picked.repo}`).toBe("acme/app");
    const moved = selectProject(picked, "proj_b", projects);
    expect(`${moved.owner}/${moved.repo}`).toBe("acme/api");
    const noRemote = selectProject(moved, "proj_gl", projects);
    expect(noRemote).toMatchObject({ projectId: "proj_gl", owner: "", repo: "" });
  });

  it("keeps a repository the user typed by hand", () => {
    const manual = { ...blankRepo("proj_a"), owner: "acme", repo: "fork" };
    expect(selectProject(manual, "proj_b", projects)).toMatchObject({ projectId: "proj_b", owner: "acme", repo: "fork" });
  });
});

describe("detachWorkflow", () => {
  const repo = (owner: string, workflow?: RepoConfig["workflow"]) => ({ ...blankRepo("proj"), owner, repo: "app", ...(workflow !== undefined ? { workflow } : {}) });

  it("clears only repositories set to the deleted workflow", () => {
    const legacy = { review: { enabled: false } } as RepoConfig["workflow"];
    const repos = [repo("a", "gone"), repo("b", "other"), repo("c"), repo("d", legacy)];
    const { repos: next, detached } = detachWorkflow(repos, "gone");
    expect(next[0]!.workflow).toBeUndefined();
    expect(next.slice(1)).toEqual(repos.slice(1));
    expect(next[1]).toBe(repos[1]);
    expect(detached.map((r) => r.owner)).toEqual(["a"]);
    expect(JSON.parse(serializeRepos(next)).repos[0]).not.toHaveProperty("workflow");
  });

  it("returns the same array when no repository uses it", () => {
    const repos = [repo("a", "other"), repo("b")];
    const result = detachWorkflow(repos, "gone");
    expect(result.repos).toBe(repos);
    expect(result.detached).toEqual([]);
  });
});
