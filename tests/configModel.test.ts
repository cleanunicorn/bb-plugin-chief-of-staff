import { describe, expect, it } from "vitest";
import { parseRepos, parseRoutines } from "../src/config";
import {
  blankRepo,
  blankRoutine,
  blankStep,
  cleanRoutine,
  cronShapeError,
  inferIdentity,
  loadRepos,
  loadRoutines,
  parseList,
  parseRepoSlug,
  routineHints,
  scheduleMode,
  selectProject,
  serializeRepos,
  serializeRoutines,
  splitEvery,
  validateRepos,
  validateRoutines,
} from "../src/configModel";

const reposJson = JSON.stringify({
  repos: [
    { owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, allow: { merge: true } },
    { owner: "acme", repo: "api", projectId: "proj_2" },
  ],
});

describe("configModel", () => {
  it("loads several repos with defaults and round-trips through serialize", () => {
    const loaded = loadRepos(reposJson);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[1]!.maxConcurrent).toBe(2);
    expect(loaded.items[1]!.allow).toEqual({ intake: true, openPr: true, merge: false, release: false, deploy: false });
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
    expect(loadRoutines(JSON.stringify({ routines: [{ name: "x" }] })).ok).toBe(false);
  });

  it("drops blank optional strings when serializing", () => {
    const repo = { ...blankRepo("proj_1"), owner: "acme", repo: "app", model: "  ", checkCommand: " npm test " };
    const out = JSON.parse(serializeRepos([repo])).repos[0];
    expect(out.model).toBeUndefined();
    expect(out.checkCommand).toBe("npm test");
  });

  it("starts new repos and routines least-privilege", () => {
    const repo = blankRepo();
    expect(repo.allow).toEqual({ intake: true, openPr: true, merge: false, release: false, deploy: false });
    const routine = blankRoutine("acme/app", ["New routine"]);
    expect(routine).toMatchObject({ name: "New routine 2", enabled: false, dryRun: true });
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

  it("validates routines: cron shape, prompts, titles, duplicate names", () => {
    const base = blankRoutine("acme/app");
    const issues = validateRoutines([
      { ...base, cron: "* * *", every: undefined },
      { ...base, name: "Agent", steps: [blankStep("run_agent"), blankStep("notify")] },
      { ...base, name: "Agent" },
    ]);
    expect(issues[0]!.join(" ")).toMatch(/5 fields/);
    expect(issues[1]!.join(" ")).toMatch(/prompt/);
    expect(issues[1]!.join(" ")).toMatch(/title/);
    expect(issues[2]!.join(" ")).toMatch(/duplicate name/);
    expect(cronShapeError("0 2 * * 1-5")).toBeNull();
  });

  it("keeps only cron when both schedules are set and parses back on the server", () => {
    const r = cleanRoutine({ ...blankRoutine("acme/app"), cron: "0 2 * * *", every: "1d" });
    expect(r.every).toBeUndefined();
    const parsed = parseRoutines(serializeRoutines([r]));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value[0]!.cron).toBe("0 2 * * *");
  });

  it("parses repo slugs from several forms", () => {
    expect(parseRepoSlug("acme/app")).toEqual({ owner: "acme", repo: "app" });
    expect(parseRepoSlug("https://github.com/acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(parseRepoSlug("git@github.com:acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(parseRepoSlug("acme")).toBeNull();
    expect(parseList("a, b ,,c")).toEqual(["a", "b", "c"]);
  });

  it("hints when a routine targets an unknown repo or a step is not allowed", () => {
    const loaded = loadRepos(reposJson);
    if (!loaded.ok) throw new Error();
    expect(routineHints(blankRoutine("acme/zzz"), loaded.items)[0]).toMatch(/not a configured/);
    const r = { ...blankRoutine("acme/api"), steps: [blankStep("batch_merge"), blankStep("deploy")] };
    const hints = routineHints(r, loaded.items);
    expect(hints.join(" ")).toMatch(/"merge"/);
    expect(hints.join(" ")).toMatch(/"deploy"/);
    expect(routineHints(blankRoutine("acme/app"), loaded.items)).toEqual([]);
  });

  it("derives schedule mode and interval parts", () => {
    expect(scheduleMode({ cron: "0 2 * * *" })).toBe("cron");
    expect(scheduleMode({ every: "2h" })).toBe("every");
    expect(scheduleMode({})).toBe("manual");
    expect(splitEvery("15m")).toEqual({ amount: 15, unit: "m" });
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
