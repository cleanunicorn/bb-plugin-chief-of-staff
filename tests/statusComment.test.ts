import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { dispatch, settleJobs } from "../src/delivery";
import { GitHubClient, GitHubError, type GitHubComment } from "../src/github";
import { DEFAULT_POLICY, freshNode } from "../src/machine";
import { migrationsForDatabase, StateStore, type NewWorkItem } from "../src/state";
import { taskBrief } from "../src/intake";
import { postStatusComment, statusKey, STATUS_MARKER } from "../src/statusComment";
import { workflowSchema } from "../src/workflow";
import type { Cos } from "../src/context";
import type { RepoConfig } from "../src/config";
import type { WorkItem } from "../src/state";

const workflow = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
  { id: "ship", name: "Ship", type: "ship", action: "merge", onFail: "build" },
] });
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await settleJobs(); for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

/** An in-memory GitHub that records the comment calls the plugin makes. */
function fakeGithub(seed: GitHubComment[] = []) {
  const comments = [...seed];
  const issueOf = new Map<number, number>(seed.map((c) => [c.id, 7]));
  const calls: string[] = [];
  let nextId = 1000;
  const fail: { create?: Error; update?: Error; list?: Error } = {};
  const client = {
    async listIssueComments(_o: string, _r: string, issue: number) { calls.push("list"); if (fail.list) throw fail.list; return comments.filter((c) => issueOf.get(c.id) === issue).map((c) => ({ ...c })); },
    async createIssueComment(_o: string, _r: string, issue: number, body: string) {
      calls.push("create"); if (fail.create) throw fail.create;
      const comment = { id: nextId++, body, user: { login: "bot" }, created_at: "2026-11-12T00:00:00Z" };
      comments.push(comment);
      issueOf.set(comment.id, issue);
      return comment;
    },
    async updateIssueComment(_o: string, _r: string, id: number, body: string) {
      calls.push("update"); if (fail.update) throw fail.update;
      const comment = comments.find((c) => c.id === id);
      if (!comment) throw new GitHubError("not found", 404, "x");
      comment.body = body;
      return comment;
    },
    // The brief a spawned builder receives.
    async getIssue() { return { number: 7, title: "Fix it", body: "", html_url: "https://github.com/a/b/issues/7" }; },
    async getFileContent() { return null; },
  };
  return { client, comments, calls, fail };
}

function setup(options: { appUrl?: string; repo?: Partial<RepoConfig>; seed?: GitHubComment[] } = {}) {
  const host = createFakePluginHost({ pluginId: "test", ...(options.appUrl ? { appUrl: options.appUrl } : {}), sdk: { threads: {
    spawn: async () => ({ id: "thr_new", providerId: "claude-code", environmentId: "env_1" }) as never,
    send: async () => ({ ok: true, delivery: "sent" }) as never,
  } } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, migrationsForDatabase(db));
  const store = new StateStore(db);
  const gh = fakeGithub(options.seed);
  const repo = { owner: "a", repo: "b", projectId: "proj_1", maxConcurrent: 5, issueComments: true, reviewers: [], permissionMode: "auto", ...options.repo } as unknown as RepoConfig;
  const cos = {
    bb: host.bb, store, now: () => new Date(), github: async () => gh.client, safe: async (s: string) => s, invalidate: () => {}, notify: async () => {},
    config: async () => ({ policy: DEFAULT_POLICY, repos: [repo], values: { maxConcurrentTotal: 5, archiveThreadsOnDone: false } }),
    repo: async () => repo, checkout: async () => ({ hostId: "host_1", path: "/tmp/x" }),
  } as unknown as Cos;
  const item = (id: string, patch: Partial<NewWorkItem> = {}): WorkItem => store.insertWorkItem({
    id, repo: "a/b", status: "agent", issueTitle: "Fix it", issueNumber: 7, branch: id, threadId: null, environmentId: null, prNumber: null, prUrl: null,
    providerId: null, model: null, lastError: null, source: "issue", lastActivityAt: null, finishedAt: null, workflow,
    nodes: { build: { ...freshNode(), round: 1, status: "running" }, ship: freshNode() }, ...patch,
  } satisfies NewWorkItem);
  const warnings = () => host.harness.inspection.logEntries.filter((l) => l.level === "warn").map((l) => l.message);
  return { host, cos, store, repo, gh, item, warnings };
}

describe("postStatusComment", () => {
  it.each([12, 250])("recovers an old status marker among %i comments using the real GitHub client", async (total) => {
    const { cos, repo, item } = setup();
    const comments = Array.from({ length: total }, (_, n) => ({
      id: n + 1, body: n === 0 ? `${STATUS_MARKER}\nExisting status` : `Human comment ${n}`,
      user: null, created_at: "2026-11-12T00:00:00Z",
    }));
    const calls: string[] = [];
    const github = new GitHubClient({ token: "test", fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      const page = Number(url.searchParams.get("page") ?? "1");
      const next = page * 100 < total ? `<${url.origin}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"` : "";
      return new Response(JSON.stringify(method === "GET" ? comments.slice((page - 1) * 100, page * 100) : { id: 1 }), {
        status: 200, headers: { "content-type": "application/json", ...(next ? { link: next } : {}) },
      });
    } });
    cos.github = async () => github;

    await postStatusComment(cos, repo, item("recover"), "thr_1");

    expect(calls).toEqual([
      ...Array.from({ length: Math.ceil(total / 100) }, () => "GET /repos/a/b/issues/7/comments"),
      "PATCH /repos/a/b/issues/comments/1",
    ]);
    expect(await cos.bb.storage.kv.get(statusKey("a/b", 7))).toBe(1);
  });

  it("creates one comment on the first start and edits it when a fresh builder restarts the task", async () => {
    const { cos, repo, gh, item } = setup();
    const it1 = item("one");
    await postStatusComment(cos, repo, it1, "thr_1");
    expect(gh.calls).toEqual(["list", "create"]);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body.startsWith(STATUS_MARKER)).toBe(true);
    expect(gh.comments[0]!.body).toContain("workflow: Test");
    expect(gh.comments[0]!.body).not.toContain("Restarted");
    expect(await cos.bb.storage.kv.get(statusKey("a/b", 7))).toBe(gh.comments[0]!.id);

    await postStatusComment(cos, repo, it1, "thr_2");
    expect(gh.calls).toEqual(["list", "create", "update"]);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain("Restarted with a new agent");
  });

  it("edits the same comment when intake picks the issue up again as a new work item", async () => {
    const { cos, repo, gh, item } = setup();
    await postStatusComment(cos, repo, item("first"), "thr_1");
    await postStatusComment(cos, repo, item("second"), "thr_2");
    expect(gh.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(gh.calls.filter((c) => c === "update")).toHaveLength(1);
    expect(gh.comments).toHaveLength(1);
  });

  it("keeps a separate status comment for each issue", async () => {
    const { cos, repo, gh, item } = setup();
    await postStatusComment(cos, repo, item("a", { issueNumber: 7 }), "thr_1");
    await postStatusComment(cos, repo, item("b", { issueNumber: 8 }), "thr_2");
    expect(gh.comments).toHaveLength(2);
    expect(await cos.bb.storage.kv.get(statusKey("a/b", 8))).toBe(gh.comments[1]!.id);
  });

  it.each([[404], [403]])("creates a new comment, and remembers it, when editing answers %i", async (status) => {
    const { cos, repo, gh, item } = setup();
    const it1 = item("one");
    await postStatusComment(cos, repo, it1, "thr_1");
    gh.fail.update = new GitHubError("nope", status, "x");
    await postStatusComment(cos, repo, it1, "thr_2");
    expect(gh.calls).toEqual(["list", "create", "update", "create"]);
    expect(gh.comments).toHaveLength(2);
    expect(gh.comments[1]!.body).not.toContain("Restarted");
    expect(await cos.bb.storage.kv.get(statusKey("a/b", 7))).toBe(gh.comments[1]!.id);
  });

  it("does not add a comment when an edit fails for a transient reason", async () => {
    const { cos, repo, gh, item, warnings } = setup();
    const it1 = item("one");
    await postStatusComment(cos, repo, it1, "thr_1");
    gh.fail.update = new GitHubError("boom", 502, "x");
    await expect(postStatusComment(cos, repo, it1, "thr_2")).resolves.toBeUndefined();
    expect(gh.comments).toHaveLength(1);
    expect(warnings().join("\n")).toContain("status comment");
  });

  it("edits a marked comment already on the issue when nothing is stored, without a duplicate", async () => {
    const seed = [
      { id: 1, body: "I mentioned <!-- cos-status --> in passing", user: { login: "human" }, created_at: "2026-11-01T00:00:00Z" },
      { id: 2, body: `${STATUS_MARKER}\n🤖 Chief of Staff started an agent on this issue (workflow: Old).`, user: { login: "bot" }, created_at: "2026-11-02T00:00:00Z" },
    ];
    const { cos, repo, gh, item } = setup({ seed });
    await postStatusComment(cos, repo, item("one"), "thr_1");
    expect(gh.calls).toEqual(["list", "update"]);
    expect(gh.comments).toHaveLength(2);
    expect(gh.comments[1]!.body).toContain("Restarted with a new agent");
    expect(gh.comments[0]!.body).toBe(seed[0]!.body);
    expect(await cos.bb.storage.kv.get(statusKey("a/b", 7))).toBe(2);
  });

  it("adopts the newest comment from before the marker and drops its bb:// link", async () => {
    const legacy = (id: number) => ({ id, body: "🤖 Chief of Staff started an agent on this issue (workflow: Old).\n\nBB thread: bb://threads/thr_old", user: { login: "bot" }, created_at: `2026-11-0${id}T00:00:00Z` });
    const { cos, repo, gh, item } = setup({ seed: [legacy(1), legacy(2)] });
    await postStatusComment(cos, repo, item("one"), "thr_1");
    expect(gh.calls).toEqual(["list", "update"]);
    expect(gh.comments[1]!.body).not.toContain("bb://");
    expect(gh.comments[0]!.body).toContain("bb://");
  });

  it("links the thread only when BB has a web URL", async () => {
    const withUrl = setup({ appUrl: "https://bb.example.com/" });
    await postStatusComment(withUrl.cos, withUrl.repo, withUrl.item("one"), "thr_1");
    expect(withUrl.gh.comments[0]!.body).toContain("BB thread: https://bb.example.com/threads/thr_1");

    const without = setup();
    await postStatusComment(without.cos, without.repo, without.item("one"), "thr_1");
    expect(without.gh.comments[0]!.body).not.toContain("bb://");
    expect(without.gh.comments[0]!.body).not.toContain("BB thread");
  });

  it("never throws: a missing token, a failed list or a failed create is only logged", async () => {
    const noToken = setup();
    noToken.cos.github = async () => { throw new Error("no token"); };
    await expect(postStatusComment(noToken.cos, noToken.repo, noToken.item("one"), "thr_1")).resolves.toBeUndefined();
    expect(noToken.warnings().join("\n")).toContain("no token");

    const listFails = setup();
    listFails.gh.fail.list = new GitHubError("rate limited", 429, "x");
    await postStatusComment(listFails.cos, listFails.repo, listFails.item("one"), "thr_1");
    expect(listFails.gh.calls).toEqual(["list"]);
    expect(listFails.gh.comments).toHaveLength(0);

    const createFails = setup();
    createFails.gh.fail.create = new Error("offline");
    await expect(postStatusComment(createFails.cos, createFails.repo, createFails.item("one"), "thr_1")).resolves.toBeUndefined();
    expect(createFails.warnings().join("\n")).toContain("offline");
  });

  it("does nothing when the repository turns issue comments off or the task has no issue", async () => {
    const off = setup({ repo: { issueComments: false } });
    off.cos.github = async () => { throw new Error("must not be called"); };
    await postStatusComment(off.cos, off.repo, off.item("one"), "thr_1");
    expect(off.warnings()).toEqual([]);
    expect(off.gh.calls).toEqual([]);

    const task = setup();
    await postStatusComment(task.cos, task.repo, task.item("one", { issueNumber: null }), "thr_1");
    expect(task.gh.calls).toEqual([]);
  });
});

describe("taskBrief", () => {
  it("leaves Chief of Staff's own status comment out of the agent's issue comments", async () => {
    const seed = [
      { id: 1, body: "Please also handle empty input.", user: { login: "human" }, created_at: "2026-11-01T00:00:00Z" },
      { id: 2, body: `${STATUS_MARKER}\n🤖 Chief of Staff started an agent on this issue (workflow: Old).`, user: { login: "bot" }, created_at: "2026-11-02T00:00:00Z" },
    ];
    const { cos, repo, item } = setup({ seed });
    const brief = await taskBrief(cos, repo, item("one"));
    expect(brief).toContain("Please also handle empty input.");
    expect(brief).not.toContain("cos-status");
    expect(brief).not.toContain("started an agent");
  });
});

describe("builder spawn", () => {
  it("posts the status comment when the builder starts and edits it on a fresh restart", async () => {
    const { cos, store, gh, item, host } = setup({ appUrl: "https://bb.example.com" });
    // The builder's brief also lists the issue's comments; only writes matter here.
    const written = () => gh.calls.filter((c) => c !== "list");
    item("one", { nodes: { build: freshNode(), ship: freshNode() }, status: "queued" });
    await dispatch(cos, "one", { type: "start" }, "test");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(store.getWorkItem("one")!.threadId).toBe("thr_new");
    expect(written()).toEqual(["create"]);
    expect(gh.comments[0]!.body).toContain("https://bb.example.com/threads/thr_new");

    store.updateWorkItem("one", { status: "failed" });
    await dispatch(cos, "one", { type: "retry" }, "test");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(written()).toEqual(["create", "update"]);
    expect(gh.comments).toHaveLength(1);
  });

  it("still starts the builder when GitHub fails, and makes no comment call when comments are off", async () => {
    const failing = setup();
    failing.gh.fail.list = new Error("github down");
    failing.item("one", { nodes: { build: freshNode(), ship: freshNode() }, status: "queued" });
    await dispatch(failing.cos, "one", { type: "start" }, "test");
    expect(failing.store.getWorkItem("one")).toMatchObject({ threadId: "thr_new", status: "agent" });
    expect(failing.warnings().join("\n")).toContain("github down");

    const off = setup({ repo: { issueComments: false } });
    off.item("one", { nodes: { build: freshNode(), ship: freshNode() }, status: "queued" });
    await dispatch(off.cos, "one", { type: "start" }, "test");
    expect(off.store.getWorkItem("one")!.threadId).toBe("thr_new");
    expect(off.gh.calls.filter((c) => c === "create" || c === "update")).toEqual([]);
  });
});
