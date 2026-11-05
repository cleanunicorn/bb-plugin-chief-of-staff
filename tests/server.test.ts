// End-to-end wiring through the SDK's fake plugin host: intake → spawn →
// idle → checks → push → PR, plus CLI, agent tool, routines and the sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

type Route = (url: URL, init: RequestInit) => { status?: number; body?: unknown; text?: string } | undefined;

function fakeGitHub(routes: Record<string, Route>, calls: { method: string; path: string; body?: unknown; auth?: string | null }[]) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({ method, path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers?.authorization ?? null });
    const key = `${method} ${url.pathname}`;
    const handler = routes[key] ?? routes[`${method} *`];
    const result = handler?.(url, init);
    if (!result) return new Response(JSON.stringify({ message: `no route for ${key}` }), { status: 404 });
    return new Response(result.text ?? JSON.stringify(result.body ?? {}), { status: result.status ?? 200, headers: { "content-type": "application/json" } });
  });
}

const repos = JSON.stringify({
  repos: [
    { owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, maxConcurrent: 2, checkCommand: "npm test", allow: { intake: true, openPr: true, merge: true, release: false, deploy: false } },
  ],
});
const routines = JSON.stringify({
  routines: [
    { name: "Nightly ship", enabled: true, cron: "0 2 * * *", timezone: "UTC", repo: "acme/app", steps: [{ type: "batch_merge" }, { type: "notify", title: "shipped" }] },
    { name: "Unconfigured", enabled: true, every: "1h", repo: "acme/other", steps: [{ type: "notify", title: "x" }] },
  ],
});

const issue = { number: 12, title: "Fix login", body: "Login breaks", state: "open", html_url: "https://github.com/acme/app/issues/12", labels: [{ name: "agent-ready" }], milestone: null, assignees: [], updated_at: "2026-11-05T00:00:00Z" };
const pull: Record<string, unknown> & { merged: boolean; merged_at: string | null; state: string } = { number: 7, title: "Fix login (#12)", body: "Closes #12", state: "open", draft: false, merged: false, merged_at: null, html_url: "https://github.com/acme/app/pull/7", head: { ref: "cos/issue-12-fix-login", sha: "abc" }, base: { ref: "main" }, labels: [], created_at: "2026-11-05T01:00:00Z", updated_at: "2026-11-05T01:00:00Z", mergeable: true, mergeable_state: "clean", user: { login: "bot" } };

describe("chief-of-staff server", () => {
  const ghCalls: { method: string; path: string; body?: unknown; auth?: string | null }[] = [];
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  let openPulls: unknown[] = [];
  let currentPull: typeof pull = { ...pull };
  let checkExit = 0;
  let host: ReturnType<typeof createFakePluginHost>;
  const originalFetch: typeof fetch = globalThis.fetch;

  beforeEach(async () => {
    ghCalls.length = 0;
    hostCalls.length = 0;
    openPulls = [];
    currentPull = { ...pull };
    checkExit = 0;
    globalThis.fetch = fakeGitHub(
      {
        "GET /repos/acme/app": () => ({ body: { default_branch: "main", full_name: "acme/app" } }),
        "GET /repos/acme/app/issues": () => ({ body: [issue] }),
        "GET /repos/acme/app/issues/12/comments": () => ({ body: [{ id: 1, body: "please fix", user: { login: "dan" }, created_at: "2026-11-05T00:00:00Z" }] }),
        "GET /repos/acme/app/contents/AGENTS.md": () => ({ body: { content: Buffer.from("# Conventions\nUse pnpm").toString("base64") } }),
        "POST /repos/acme/app/issues/12/comments": () => ({ status: 201, body: { id: 2, body: "", user: null, created_at: "" } }),
        "GET /repos/acme/app/pulls": (url) => ({ body: url.searchParams.get("head") ? [] : openPulls }),
        "POST /repos/acme/app/pulls": () => ({ status: 201, body: currentPull }),
        "GET /repos/acme/app/pulls/7": () => ({ body: currentPull }),
        "GET /repos/acme/app/pulls/7/reviews": () => ({ body: [{ state: "APPROVED", user: { login: "alice" }, submitted_at: "" }] }),
        "GET /repos/acme/app/commits/abc/check-runs": () => ({ body: { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", html_url: "https://github.com/acme/app/actions/runs/99" }] } }),
        "GET /repos/acme/app/commits/abc/status": () => ({ body: { state: "success", total_count: 0 } }),
        "PUT /repos/acme/app/pulls/7/merge": () => ({ body: { merged: true, message: "ok", sha: "def" } }),
      },
      ghCalls,
    ) as typeof fetch;

    host = createFakePluginHost({
      pluginId: "chief-of-staff",
      settings: { githubToken: "ghp_secret_token", repos, routines, intakeIntervalMinutes: 10 },
      experimental_callHostRpc: async (call) => {
        hostCalls.push({ method: call.method, input: call.input, hostId: call.hostId });
        if (call.method === "readFile") return { exists: false, content: "", truncated: false };
        const input = call.input as { command: string; args?: string[] };
        const ok = { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 5, timedOut: false };
        if (input.command === "git" && input.args?.[0] === "status") return { ...ok, stdout: " M src/a.ts\n" };
        if (input.command === "git" && input.args?.[0] === "rev-list") return { ...ok, stdout: "2\n" };
        if (input.command === "npm test") return { ...ok, exitCode: checkExit, stdout: checkExit ? "1 failing" : "all green" };
        return ok;
      },
      sdk: {
        system: { config: async () => ({ primaryHostId: "host_1" }) as never },
        projects: { list: async () => [{ id: "proj_1", kind: "git", name: "app", gitRemoteUrl: "https://github.com/acme/app", sources: [{ hostId: "host_1", path: "/work/app", isDefault: true }] }] as never },
        threads: {
          spawn: async () => makeThreadResponse({ id: "thr_1", environmentId: "env_1", providerId: "claude-code" }),
          get: async () => makeThreadResponse({ id: "thr_1", environmentId: "env_1", providerId: "claude-code", status: "idle" }),
          list: async () => [makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "idle" })],
          output: async () => ({ output: "Done.\n## Summary\nFixed the login bug.\n## Test evidence\nnpm test → 12 passing" }),
          send: async () => ({ ok: true, delivery: "sent" }) as never,
          events: { list: async () => [] as never },
        },
        environments: { get: async () => ({ id: "env_1", hostId: "host_1", path: "/work/app/.bb/wt-1", branchName: "cos/issue-12-fix-login", status: "ready" }) as never },
        plugins: { callRpc: async () => ({ ok: true, channels: ["web"] }) },
        providers: { catalog: async () => [{ id: "claude-code", displayName: "Claude Code", available: true, enabled: true, info: {} }] as never },
      },
    });
    await plugin(host.bb);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await host.harness.lifecycle.dispose();
  });

  it("takes an issue through spawn, checks, push and PR, never leaking the token", async () => {
    const intake = (await host.harness.behavior.callRpc("cos_intake_now", {})) as { results: { started: { issue: number; threadId: string }[] }[] };
    expect(intake.results[0].started).toEqual([{ issue: 12, threadId: "thr_1" }]);

    const spawnCalls = host.harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawnCalls).toHaveLength(1);
    const spawnArgs = spawnCalls[0][0] as { prompt: string; title: string; environment: { type: string; hostId: string; workspace: { type: string } } };
    expect(spawnArgs.title).toBe("cos/issue-12-fix-login");
    expect(spawnArgs.environment).toMatchObject({ type: "host", hostId: "host_1", workspace: { type: "managed-worktree" } });
    expect(spawnArgs.prompt).toContain("Fix login");
    expect(spawnArgs.prompt).toContain("please fix");
    expect(spawnArgs.prompt).toContain("Use pnpm");
    expect(ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/issues/12/comments")).toBeTruthy();

    // Dedupe: a second intake does not spawn again.
    await host.harness.behavior.callRpc("cos_intake_now", {});
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);

    // The agent finishes → checks run on the host → push → PR.
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "idle" }), lastAssistantText: "done" });
    const commands = hostCalls.map((c) => (c.input as { command: string; args?: string[] }).command + " " + ((c.input as { args?: string[] }).args ?? []).join(" "));
    expect(commands.some((c) => c.startsWith("npm test"))).toBe(true);
    expect(commands.some((c) => c.startsWith("git push --force-with-lease"))).toBe(true);
    const prCall = ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls");
    expect(prCall).toBeTruthy();
    const body = (prCall!.body as { body: string; head: string; base: string });
    expect(body.head).toBe("cos/issue-12-fix-login");
    expect(body.base).toBe("main");
    expect(body.body).toContain("Closes #12");
    expect(body.body).toContain("claude-code");
    expect(body.body).toContain("npm test → 12 passing");

    const roster = (await host.harness.behavior.callRpc("cos_roster", { includeDone: true })) as { entries: { status: string; detail: string; prNumber: number | null }[] };
    expect(roster.entries[0]).toMatchObject({ status: "running", detail: "pr_open", prNumber: 7 });

    // CI sweep sees the PR merged → done.
    currentPull = { ...currentPull, merged: true, merged_at: "2026-11-05T02:00:00Z", state: "closed" };
    await host.harness.behavior.runSchedule("cos-sweep");
    const after = (await host.harness.behavior.callRpc("cos_roster", { includeDone: true })) as { entries: { status: string }[] };
    expect(after.entries[0].status).toBe("done");

    // The token went to GitHub as a bearer header and nowhere else.
    expect(ghCalls.every((c) => c.auth === "Bearer ghp_secret_token")).toBe(true);
    const status = await host.harness.behavior.runCli(["status", "--all", "--json"]);
    expect(status.stdout).not.toContain("ghp_secret_token");
    const log = await host.harness.behavior.runCli(["log"]);
    expect(log.stdout).not.toContain("ghp_secret_token");
  });

  it("feeds a failing check back to the thread once, then waits on a human", async () => {
    checkExit = 1;
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "idle" }), lastAssistantText: null });
    const sends = host.harness.inspection.sdk.callsTo("threads.send");
    expect(sends).toHaveLength(1);
    expect(JSON.stringify(sends[0][0])).toContain("1 failing");
    const first = (await host.harness.behavior.callRpc("cos_roster", {})) as { entries: { detail: string; fixAttempts: number }[] };
    expect(first.entries[0]).toMatchObject({ detail: "fixing", fixAttempts: 1 });

    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "idle" }), lastAssistantText: null });
    const second = (await host.harness.behavior.callRpc("cos_roster", {})) as { entries: { detail: string; status: string }[] };
    expect(second.entries[0]).toMatchObject({ status: "waiting on human", detail: "waiting_on_human" });
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc").length).toBeGreaterThan(0);
    expect(ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")).toBeUndefined();
  });

  it("exposes the roster through the agent tool and CLI", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const tool = await host.harness.behavior.callAgentTool("chief_of_staff_status", { includeRoutines: true });
    const text = typeof tool === "string" ? tool : tool.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("acme/app#12");
    expect(text).toContain("Nightly ship");
    const cli = await host.harness.behavior.runCli(["status"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("acme/app#12");
    expect(cli.stdout).toContain("thr_1");
  });

  it("runs routines with dry-run and allow gating, and lists them", async () => {
    openPulls = [pull];
    const dry = await host.harness.behavior.runCli(["run", "Nightly ship", "--dry-run"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("batch_merge: dry_run");
    expect(dry.stdout).toContain("would merge 1 PR(s) [#7]");
    expect(ghCalls.find((c) => c.method === "PUT")).toBeUndefined();

    const real = (await host.harness.behavior.callRpc("cos_run_routine", { name: "Nightly ship" })) as { status: string; steps: { type: string; status: string; summary: string }[]; triggeredBy: string };
    expect(real.status).toBe("succeeded");
    expect(real.steps[0]).toMatchObject({ type: "batch_merge", status: "succeeded" });
    expect(ghCalls.find((c) => c.method === "PUT" && c.path === "/repos/acme/app/pulls/7/merge")).toBeTruthy();
    expect(real.triggeredBy).toBe("rpc:client");

    const unconfigured = await host.harness.behavior.runCli(["run", "Unconfigured"]);
    expect(unconfigured.exitCode).toBe(1);
    expect(unconfigured.stdout).toContain("not configured");

    const list = await host.harness.behavior.runCli(["routines", "list"]);
    expect(list.stdout).toContain("[on ] Nightly ship");
    await host.harness.behavior.runCli(["routines", "disable", "Nightly ship"]);
    const after = await host.harness.behavior.runCli(["routines", "list"]);
    expect(after.stdout).toContain("[off] Nightly ship");
    const missing = await host.harness.behavior.runCli(["run", "Nope"]);
    expect(missing.exitCode).not.toBe(0);
  });

  it("reads and writes settings for the configurator without exposing the token", async () => {
    const read = (await host.harness.behavior.callRpc("cos_get_settings", null)) as { values: Record<string, unknown>; token: { stored: boolean; source: string }; projects: { id: string; remote: string | null }[] };
    expect(JSON.stringify(read)).not.toContain("ghp_secret_token");
    expect(read.token).toEqual({ stored: true, source: "setting" });
    expect(read.values.intakeIntervalMinutes).toBe(10);
    expect(read.projects).toEqual([{ id: "proj_1", name: "app", remote: "https://github.com/acme/app" }]);
    expect((read as unknown as { providers: unknown[] }).providers).toEqual([{ id: "claude-code", displayName: "Claude Code", available: true, enabled: true }]);

    const saved = (await host.harness.behavior.callRpc("cos_set_settings", { maxFixRetries: 4, githubToken: "ghp_rotated_token" })) as { changed: string[] };
    expect(saved.changed.sort()).toEqual(["githubToken", "maxFixRetries"]);
    const after = (await host.harness.behavior.callRpc("cos_get_settings", null)) as { values: Record<string, unknown> };
    expect(after.values.maxFixRetries).toBe(4);
    expect(JSON.stringify(after)).not.toContain("ghp_rotated_token");
    const log = await host.harness.behavior.runCli(["log"]);
    expect(log.stdout).toContain("settings updated");
    expect(log.stdout).not.toContain("ghp_rotated_token");

    await expect(host.harness.behavior.callRpc("cos_set_settings", { notifyWebhookUrl: "http://insecure.example" })).rejects.toThrow(/https/);
    await expect(host.harness.behavior.callRpc("cos_set_settings", { githubToken: "x", clearGithubToken: true })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("cos_set_settings", { maxFixRetries: 99 })).rejects.toThrow();

    await host.harness.behavior.callRpc("cos_set_settings", { clearGithubToken: true });
    const cleared = (await host.harness.behavior.callRpc("cos_get_settings", null)) as { token: { stored: boolean } };
    expect(cleared.token.stored).toBe(false);
  });

  it("rejects routines with an invalid cron on save", async () => {
    const bad = JSON.stringify({ routines: [{ name: "Bad", enabled: true, cron: "99 * * * *", repo: "acme/app", steps: [{ type: "notify", title: "x" }] }] });
    await expect(host.harness.behavior.callRpc("cos_set_config", { routines: bad })).rejects.toThrow(/cron/i);
  });

  it("skips merge when the repo does not allow it", async () => {
    const parsed = JSON.parse(repos) as { repos: { allow: { merge: boolean } }[] };
    parsed.repos[0].allow.merge = false;
    await host.harness.behavior.setSettings({ repos: JSON.stringify(parsed) });
    openPulls = [pull];
    const run = (await host.harness.behavior.callRpc("cos_run_routine", { name: "Nightly ship" })) as { steps: { status: string; summary: string }[] };
    expect(run.steps[0]).toMatchObject({ status: "skipped" });
    expect(run.steps[0].summary).toContain("allow.merge");
    expect(ghCalls.find((c) => c.method === "PUT")).toBeUndefined();
  });

  it("dispatches due routines from the sweep exactly once", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-06T02:00:30Z"));
      await host.harness.behavior.runSchedule("cos-sweep");
      await vi.runAllTimersAsync();
      await host.harness.behavior.runSchedule("cos-sweep");
      await vi.runAllTimersAsync();
      const runs = (await host.harness.behavior.callRpc("cos_runs", { limit: 10 })) as { runs: { routine: string; triggeredBy: string }[] };
      expect(runs.runs.filter((r) => r.routine === "Nightly ship")).toHaveLength(1);
      expect(runs.runs[0].triggeredBy).toBe("schedule:Nightly ship");
    } finally {
      vi.useRealTimers();
    }
  });
});
