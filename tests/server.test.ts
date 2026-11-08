// End-to-end wiring through the SDK's fake plugin host: intake → stages →
// push → PR, plus the CLI, agent tools, settings and the sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { settleJobs } from "../src/delivery";

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
/** Build → Verify (npm test via checkCommand) → Ship: the old single-turn flow. */
const minimalWorkflow = JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, verify: { maxAttempts: 1 } } });
/** Every stage on: plan approval, verify command, independent reviewer, PR. */
const fullWorkflow = JSON.stringify({ workflow: {} });


const issue = { number: 12, title: "Fix login", body: "Login breaks", state: "open", html_url: "https://github.com/acme/app/issues/12", labels: [{ name: "agent-ready" }], milestone: null, assignees: [], updated_at: "2026-11-05T00:00:00Z" };
const pull: Record<string, unknown> & { merged: boolean; merged_at: string | null; state: string } = { number: 7, title: "Fix login (#12)", body: "Closes #12", state: "open", draft: false, merged: false, merged_at: null, html_url: "https://github.com/acme/app/pull/7", head: { ref: "cos/issue-12-fix-login", sha: "abc" }, base: { ref: "main" }, labels: [], created_at: "2026-11-05T01:00:00Z", updated_at: "2026-11-05T01:00:00Z", mergeable: true, mergeable_state: "clean", user: { login: "bot" } };

describe("chief-of-staff server", () => {
  const ghCalls: { method: string; path: string; body?: unknown; auth?: string | null }[] = [];
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  let openPulls: unknown[] = [];
  let currentPull: typeof pull = { ...pull };
  let checkExit = 0;
  let checkHangs = false;
  let threadUpdatedAt = 0;
  let threadStatus: "idle" | "active" = "idle";
  let checkBlocks: Promise<void> | null = null;
  let ghRoutes: Record<string, Route> = {};
  /** Per-thread overrides of status / updatedAt for the fake thread list. */
  let perThread: Record<string, { status?: "idle" | "active"; updatedAt?: number }> = {};
  const spawned = new Set<string>();
  let prCreated = false;
  let clock = 0;
  let pending: unknown[] = [];
  let resolved: unknown[] = [];
  let sent: unknown[] = [];
  let archivedIds: string[] = [];
  let assistantOutput = "Done.\n## Summary\nFixed the login bug.\n## Test evidence\nnpm test → 12 passing";
  let host: ReturnType<typeof createFakePluginHost>;
  const originalFetch: typeof fetch = globalThis.fetch;

  beforeEach(async () => {
    ghCalls.length = 0;
    hostCalls.length = 0;
    openPulls = [];
    currentPull = { ...pull };
    checkExit = 0;
    threadStatus = "idle";
    pending = [];
    resolved = [];
    sent = [];
    archivedIds = [];
    checkHangs = false;
    checkBlocks = null;
    threadUpdatedAt = 0;
    clock = 0;
    assistantOutput = "Done.\n## Summary\nFixed the login bug.\n## Test evidence\nnpm test → 12 passing";
    prCreated = false;
    perThread = {};
    spawned.clear();
    ghRoutes = {
        "GET /repos/acme/app": () => ({ body: { default_branch: "main", full_name: "acme/app" } }),
        "GET /repos/acme/app/issues": () => ({ body: [issue] }),
        "GET /repos/acme/app/issues/12": () => ({ body: issue }),
        "GET /repos/acme/app/issues/12/comments": () => ({ body: [{ id: 1, body: "please fix", user: { login: "dan" }, created_at: "2026-11-05T00:00:00Z" }] }),
        "GET /repos/acme/app/contents/AGENTS.md": () => ({ body: { content: Buffer.from("# Conventions\nUse pnpm").toString("base64") } }),
        "POST /repos/acme/app/issues/12/comments": () => ({ status: 201, body: { id: 2, body: "", user: null, created_at: "" } }),
        "GET /repos/acme/app/pulls": (url) => ({ body: url.searchParams.get("head") ? (prCreated ? [currentPull] : []) : openPulls }),
        "POST /repos/acme/app/pulls": () => {
          prCreated = true;
          return { status: 201, body: currentPull };
        },
        "GET /repos/acme/app/pulls/7": () => ({ body: currentPull }),
        "GET /repos/acme/app/pulls/7/reviews": () => ({ body: [{ state: "APPROVED", user: { login: "alice" }, submitted_at: "" }] }),
        "GET /repos/acme/app/commits/abc/check-runs": () => ({ body: { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", html_url: "https://github.com/acme/app/actions/runs/99" }] } }),
        "GET /repos/acme/app/commits/abc/status": () => ({ body: { state: "success", total_count: 0 } }),
        "PUT /repos/acme/app/pulls/7/merge": () => ({ body: { merged: true, message: "ok", sha: "def" } }),
    };
    globalThis.fetch = fakeGitHub(ghRoutes, ghCalls) as typeof fetch;

    host = createFakePluginHost({
      pluginId: "chief-of-staff",
      settings: { githubToken: "ghp_secret_token", repos, workflow: minimalWorkflow, intakeIntervalMinutes: 10 },
      experimental_callHostRpc: async (call) => {
        hostCalls.push({ method: call.method, input: call.input, hostId: call.hostId });
        if (call.method === "readFile") return { exists: false, content: "", truncated: false };
        const input = call.input as { command: string; args?: string[] };
        const ok = { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 5, timedOut: false };
        if (input.command === "git" && input.args?.[0] === "status") return { ...ok, stdout: " M src/a.ts\n" };
        if (input.command === "git" && input.args?.[0] === "rev-list") return { ...ok, stdout: "2\n" };
        if (input.command === "npm test" && checkHangs) throw new Error("host plugin call 42b1 exceeded its deadline");
        if (input.command === "npm test" && checkBlocks) await checkBlocks;
        if (input.command === "npm test") return { ...ok, exitCode: checkExit, stdout: checkExit ? "1 failing" : "all green" };
        return ok;
      },
      sdk: {
        system: { config: async () => ({ primaryHostId: "host_1" }) as never },
        projects: { list: async () => [{ id: "proj_1", kind: "git", name: "app", gitRemoteUrl: "https://github.com/acme/app", sources: [{ hostId: "host_1", path: "/work/app", isDefault: true }] }] as never },
        threads: {
          // The builder (titled after its branch) is thr_1 in env_1; step threads are thr_<step title>.
          spawn: async (args: { environment: { type: string }; title?: string }) => {
            const title = args.title ?? "";
            const builder = title.startsWith("cos/");
            const id = builder ? "thr_1" : `thr_${title.split(":")[0]!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
            spawned.add(id);
            return makeThreadResponse({ id, environmentId: builder || args.environment.type === "reuse" ? "env_1" : `env_${id}`, providerId: "claude-code" });
          },
          get: async (args: { threadId: string }) => ({ ...makeThreadResponse({ id: args.threadId, environmentId: "env_1", providerId: "claude-code", status: threadStatus, updatedAt: threadUpdatedAt }), runtime: { displayStatus: threadStatus } }),
          interactions: {
            list: async () => pending as never,
            resolve: async (args: unknown) => {
              resolved.push(args);
              pending = [];
              return { ok: true } as never;
            },
          },
          list: async () =>
            ["thr_1", ...[...spawned].filter((id) => id !== "thr_1")].map((id) => {
              const status = perThread[id]?.status ?? threadStatus;
              return { ...makeThreadResponse({ id, environmentId: "env_1", status, updatedAt: perThread[id]?.updatedAt ?? threadUpdatedAt }), runtime: { displayStatus: status }, hasPendingInteraction: pending.length > 0 };
            }),
          output: async () => ({ output: assistantOutput }),
          archive: async (args: { threadId: string }) => {
            archivedIds.push(args.threadId);
            return { archivedThreadIds: [args.threadId] } as never;
          },
          send: async (args: unknown) => {
            sent.push(args);
            return { ok: true, delivery: "sent" } as never;
          },
          events: { list: async () => [] as never },
        },
        environments: { get: async () => ({ id: "env_1", hostId: "host_1", path: "/work/app/.bb/wt-1", branchName: "cos/issue-12-fix-login", status: "ready" }) as never },
        plugins: { callRpc: async () => ({ ok: true, channels: ["web"] }) },
        skills: { list: async () => ({ skills: [{ id: "skill_1", name: "tdd", description: "Test first", filePath: "/x/SKILL.md", manageable: false, pluginId: null, provider: null, registrySkillId: null, scope: "bb-project" }] }) as never },
        providers: { catalog: async () => [{ id: "claude-code", displayName: "Claude Code", available: true, enabled: true, info: {} }] as never },
      },
    });
    await plugin(host.bb);
  });

  /** A strictly increasing thread timestamp, always after Chief of Staff's latest prompt. */
  const tick = () => Date.now() + 60_000 + ++clock * 1000;
  /** The agent files its stage report through the cos_report tool. */
  const report = (stage: string, outcome = "done", summary = `${stage} done`, threadId = "thr_1", question?: string) =>
    host.harness.behavior.callAgentTool("cos_report", { step: stage, outcome, summary, ...(question ? { question } : {}) }, { threadId });
  /** A turn ends on a thread; wait for the jobs it starts. */
  const idle = async (lastAssistantText: string | null = "done", threadId = "thr_1", updatedAt = tick()) => {
    threadUpdatedAt = updatedAt;
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, environmentId: "env_1", status: "idle", updatedAt }), lastAssistantText });
    await settleJobs();
  };
  type Entry = { id: string; status: string; detail: string; current: string[]; lastError: string | null; actor: string; activity: string; waitingKind: string | null; waitingReason: string | null; prNumber: number | null; fixAttempts: number; counters: Record<string, number> };
  const roster = async () => ((await host.harness.behavior.callRpc("cos_roster", { includeDone: true })) as { entries: Entry[] }).entries[0];
  const ranChecks = () => hostCalls.filter((c) => (c.input as { command: string }).command === "npm test").length;
  const sentTexts = () => (sent as { input: { text: string }[] }[]).map((s) => s.input[0].text);
  const sweep = async () => {
    await host.harness.behavior.runSchedule("cos-sweep");
    await settleJobs();
  };

  afterEach(async (ctx) => {
    if (process.env.COS_DEBUG && ctx.task.result?.state === "fail") console.log((await host.harness.behavior.runCli(["log", "--limit", "80"])).stdout);
    await settleJobs();
    globalThis.fetch = originalFetch;
    await host.harness.lifecycle.dispose();
  });

  it("takes an issue through build, verify and ship, never leaking the token", async () => {
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
    // The first prompt names the stage and the reporting contract.
    expect(spawnArgs.prompt).toContain("Build");
    expect(spawnArgs.prompt).toContain("cos_report");
    expect(ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/issues/12/comments")).toBeTruthy();
    expect(await roster()).toMatchObject({ current: ["Build"], detail: "agent", actor: "agent" });

    // Dedupe: a second intake does not spawn again.
    await host.harness.behavior.callRpc("cos_intake_now", {});
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);

    // The agent reports Build done and ends its turn → verify → push → PR.
    expect(await report("build", "done", "Fixed the login bug.\n\nnpm test → 12 passing")).toContain("Recorded");
    await idle();
    const commands = hostCalls.map((c) => (c.input as { command: string; args?: string[] }).command + " " + ((c.input as { args?: string[] }).args ?? []).join(" "));
    expect(commands.some((c) => c.startsWith("npm test"))).toBe(true);
    expect(commands.some((c) => c.startsWith("git push --force-with-lease"))).toBe(true);
    const prCall = ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls");
    expect(prCall).toBeTruthy();
    const body = prCall!.body as { body: string; head: string; base: string };
    expect(body.head).toBe("cos/issue-12-fix-login");
    expect(body.base).toBe("main");
    expect(body.body).toContain("Closes #12");
    expect(body.body).toContain("claude-code");
    expect(body.body).toContain("npm test → 12 passing");
    expect(body.body).toContain("all green");
    expect(await roster()).toMatchObject({ status: "running", detail: "ci", prNumber: 7 });

    // CI green → ready to merge; merged → done (CI is polled every 2 minutes).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await sweep();
      expect(await roster()).toMatchObject({ detail: "ready", actor: "human" });
      currentPull = { ...currentPull, merged: true, merged_at: "2026-11-05T02:00:00Z", state: "closed" };
      vi.setSystemTime(Date.now() + 3 * 60_000);
      await sweep();
      expect(await roster()).toMatchObject({ status: "done" });
      expect(archivedIds).toEqual(["thr_1"]);
    } finally {
      vi.useRealTimers();
    }

    // The token went to GitHub as a bearer header and nowhere else.
    expect(ghCalls.every((c) => c.auth === "Bearer ghp_secret_token")).toBe(true);
    const status = await host.harness.behavior.runCli(["status", "--all", "--json"]);
    expect(status.stdout).not.toContain("ghp_secret_token");
    const log = await host.harness.behavior.runCli(["log"]);
    expect(log.stdout).not.toContain("ghp_secret_token");
  });

  it("runs a custom workflow: parallel planners, approval, build, check, parallel gate + docs, ship, with a review loop", async () => {
    const custom = {
      workflows: [
        {
          id: "careful",
          name: "Careful",
          steps: [
            { id: "plan", name: "Plan", type: "agent", agents: 2, approval: true, instructions: "Write a plan.", next: ["build"] },
            { id: "build", name: "Build", type: "agent", writes: true, instructions: "Build it.", next: ["test"] },
            { id: "test", name: "Test", type: "check", command: "npm test", onFail: "build", next: ["review", "docs"] },
            { id: "review", name: "Review", type: "agent", verdict: true, onFail: "build", instructions: "Review the diff.", next: ["ship"] },
            { id: "docs", name: "Docs", type: "agent", instructions: "Check the docs mention the change.", next: ["ship"] },
            { id: "ship", name: "Ship", type: "ship", action: "pr", onFail: "build" },
          ],
        },
      ],
      default: "careful",
    };
    const reposWithWorkflow = JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, workflow: "careful" }] });
    await host.harness.behavior.setSettings({ workflow: JSON.stringify(custom), repos: reposWithWorkflow });
    await host.harness.behavior.callRpc("cos_intake_now", {});

    // Two planners, each in its own (read-only) thread; no builder yet.
    const spawns = () => host.harness.inspection.sdk.callsTo("threads.spawn").map((c) => c[0] as { title: string; prompt: string; environment: { type: string; environmentId?: string }; parentThreadId?: string });
    expect(spawns().map((p) => p.title)).toEqual(["Plan 1: cos/issue-12-fix-login", "Plan 2: cos/issue-12-fix-login"]);
    expect(spawns()[0]!.prompt).toContain("This step is read-only");
    expect(spawns()[1]!.prompt).toContain("you are agent 2");
    expect(await roster()).toMatchObject({ current: ["Plan"], detail: "agent", activity: "Plan: 0/2 agents reported" });

    await report("plan", "done", "Plan A: patch auth.ts", "thr_plan-1");
    await idle("a", "thr_plan-1");
    expect(await roster()).toMatchObject({ activity: "Plan: 1/2 agents reported" });
    await report("plan", "done", "Plan B: rewrite session", "thr_plan-2");
    await idle("b", "thr_plan-2");
    const { id } = await roster();
    expect(await roster()).toMatchObject({ current: ["Plan"], detail: "waiting_on_human", waitingKind: "approval" });
    const view = (await host.harness.behavior.callRpc("cos_question", { id })) as { report: string; decidable: boolean; stepName: string };
    expect(view).toMatchObject({ stepName: "Plan", decidable: true });
    expect(view.report).toContain("Plan A: patch auth.ts");
    expect(view.report).toContain("Plan B: rewrite session");

    // Approve → the builder spawns with both plans as input.
    await host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "approve" } });
    const builder = spawns().at(-1)!;
    expect(builder.title).toBe("cos/issue-12-fix-login");
    expect(builder.prompt).toContain("Plan A: patch auth.ts");
    expect(builder.prompt).toContain("Plan B: rewrite session");
    expect(builder.prompt).toContain("You may change code");

    // Build → test check → review and docs in parallel, both in the builder's workspace.
    await report("build", "done", "Patched auth.ts");
    await idle();
    expect(ranChecks()).toBe(1);
    const parallel = spawns().slice(-2);
    expect(parallel.map((p) => p.title.split(":")[0])).toEqual(["Review", "Docs"]);
    for (const p of parallel) {
      expect(p.environment).toEqual({ type: "reuse", environmentId: "env_1" });
      expect(p.parentThreadId).toBe("thr_1");
    }
    expect(await roster()).toMatchObject({ current: ["Review", "Docs"], detail: "agent" });

    // The builder (idle, its step done) cannot report someone else's step.
    expect(JSON.stringify(await report("review", "done", "lgtm", "thr_1"))).toContain("no step running on this thread");
    // Docs passes; review fails → back to build with the findings; docs runs again too.
    await report("docs", "done", "Docs fine", "thr_docs");
    await idle("ok", "thr_docs");
    await report("review", "failed", "1. auth.ts:12 misses the null case", "thr_review");
    await idle("findings", "thr_review");
    expect(await roster()).toMatchObject({ current: ["Build"], detail: "agent" });
    expect(sentTexts().at(-1)).toContain("auth.ts:12 misses the null case");

    await report("build", "done", "Handled null");
    await idle();
    expect(ranChecks()).toBe(2);
    // The same review and docs threads get the next round.
    expect(sent.slice(-2).map((m) => (m as { threadId: string }).threadId).sort()).toEqual(["thr_docs", "thr_review"]);
    await report("review", "done", "Looks right now", "thr_review");
    await idle("ok", "thr_review");
    expect(await roster()).toMatchObject({ current: ["Docs"] });
    await report("docs", "done", "Docs fine", "thr_docs");
    await idle("ok2", "thr_docs");
    expect(await roster()).toMatchObject({ detail: "ci", prNumber: 7 });
    const pr = ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")!.body as { body: string };
    expect(pr.body).toContain("## Workflow: Careful");
    expect(pr.body).toContain("### Plan (approved)");
    expect(pr.body).toContain("Looks right now");
  });

  describe("archiving threads when the workflow is done", () => {
    const buildThenReview = {
      workflows: [
        {
          id: "br",
          name: "Build and review",
          steps: [
            { id: "build", name: "Build", type: "agent", writes: true, instructions: "Build it.", next: ["review"] },
            { id: "review", name: "Review", type: "agent", instructions: "Review the diff." },
          ],
        },
      ],
      default: "br",
    };
    const reposBr = JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, workflow: "br" }] });
    const runToDone = async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build", "done", "Built");
      await idle();
      expect(archivedIds).toEqual([]);
      await report("review", "done", "lgtm", "thr_review");
      await idle("ok", "thr_review");
      expect(await roster()).toMatchObject({ status: "done" });
    };

    it("archives the builder and step threads, and stays done when their archive events arrive", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify(buildThenReview), repos: reposBr });
      await runToDone();
      expect(archivedIds.sort()).toEqual(["thr_1", "thr_review"]);
      for (const id of archivedIds) await host.harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id, environmentId: "env_1", status: "idle" }) } as never);
      expect(await roster()).toMatchObject({ status: "done", lastError: null });
    });

    it("keeps the threads when archiving is turned off", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify(buildThenReview), repos: reposBr, archiveThreadsOnDone: false });
      await runToDone();
      expect(archivedIds).toEqual([]);
    });

    it("keeps a failed task's threads", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_1", status: "error" }), error: "provider crashed" } as never);
      expect((await roster()).detail).toBe("failed");
      expect(archivedIds).toEqual([]);
    });
  });

  it("handles a turn end once even when the event and the sweep both see it", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build");
    let release!: () => void;
    checkBlocks = new Promise<void>((resolve) => (release = resolve));
    const updatedAt = tick();
    threadUpdatedAt = updatedAt;
    await Promise.all([
      host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "idle", updatedAt }), lastAssistantText: "done" }),
      host.harness.behavior.runSchedule("cos-sweep"),
      host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "idle", updatedAt }), lastAssistantText: "done" }),
    ]);
    // The verify job runs detached: monitoring is not blocked while it runs.
    expect(await roster()).toMatchObject({ current: ["Verify"], detail: "cos", actor: "cos" });
    // A sweep while the job runs neither waits for it nor starts a second one.
    await host.harness.behavior.runSchedule("cos-sweep");
    expect(ranChecks()).toBe(1);
    release();
    await settleJobs();
    expect(ranChecks()).toBe(1);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(await roster()).toMatchObject({ detail: "ci" });
  });

  it("nudges an agent that stops without reporting, then hands it to a human", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await idle("I made some changes.");
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("without reporting the step **Build**");
    expect(await roster()).toMatchObject({ detail: "agent", activity: expect.stringContaining("nudged 1×") });
    // The same idle seen again by the sweep changes nothing.
    await sweep();
    expect(sentTexts()).toHaveLength(1);

    await idle("Still working on it.");
    await idle("Hmm.");
    expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingKind: "no_report" });
    expect(ranChecks()).toBe(0);

    // The human vouches for the stage → verify runs.
    const { id } = await roster();
    await host.harness.behavior.runCli(["item", "approve", id]);
    await settleJobs();
    expect(ranChecks()).toBe(1);
  });

  it("accepts a Stage report block from agents without the tool", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await idle("All set.\n\n## Stage report\nstage: build\noutcome: done\nsummary: Fixed login via text report");
    expect(ranChecks()).toBe(1);
    const pr = ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")!.body as { body: string };
    expect(pr.body).toContain("Fixed login via text report");
  });

  it("feeds a failing verify back to the agent on budget, then waits on a human", async () => {
    checkExit = 1;
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build");
    await idle();
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("1 failing");
    expect(await roster()).toMatchObject({ current: ["Build"], detail: "agent", fixAttempts: 1 });

    await report("build");
    await idle();
    expect(await roster()).toMatchObject({ status: "waiting on human", current: ["Verify"], waitingKind: "escalation" });
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc").length).toBeGreaterThan(0);
    expect(ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")).toBeUndefined();

    // Send it back with instructions from the dashboard.
    const { id } = await roster();
    checkExit = 0;
    await host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "revise", feedback: "The flaky test needs a retry" } });
    expect(sentTexts().at(-1)).toContain("The flaky test needs a retry");
    await report("build");
    await idle();
    expect(await roster()).toMatchObject({ detail: "ci" });
  });

  it("tracks questions and resumes in step with the thread", async () => {
    const question = { id: "int_1", status: "pending", threadId: "thr_1", createdAt: 1, payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Which database should I use?", allowFreeText: true, multiSelect: false, required: true }] } };

    threadStatus = "active";
    await host.harness.behavior.callRpc("cos_intake_now", {});
    expect(await roster()).toMatchObject({ detail: "agent" });

    // The agent asks through a BB interaction.
    pending = [question];
    await host.harness.behavior.emitThreadEvent("interaction.pending", { thread: makeThreadResponse({ id: "thr_1", status: "active" }), interaction: question as never });
    expect(await roster()).toMatchObject({ status: "waiting on human", waitingKind: "question", waitingReason: "Build: Question: Which database should I use?" });

    // The human answers in BB. No event says so; the sweep notices.
    pending = [];
    await sweep();
    expect(await roster()).toMatchObject({ detail: "agent", waitingReason: null });

    // A missed interaction event is also caught by the sweep.
    pending = [question];
    await sweep();
    expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingReason: "Build: Question: Which database should I use?" });
    pending = [];
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_1", status: "active" }) });
    expect(await roster()).toMatchObject({ detail: "agent" });

    // The agent ends its turn with a plain-text question: wait, do not verify.
    threadStatus = "idle";
    await idle("I found two options.\n\nShould I use Postgres or SQLite?");
    expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingReason: "Build: Question: Should I use Postgres or SQLite?" });
    expect(ranChecks()).toBe(0);
    await sweep();
    expect(await roster()).toMatchObject({ detail: "waiting_on_human" });

    // The human replies in the thread: it resumes, reports, and ships.
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_1", status: "active" }) });
    expect(await roster()).toMatchObject({ detail: "agent", waitingReason: null });
    await report("build", "done", "Used Postgres.");
    await idle("## Summary\nUsed Postgres.");
    expect(ranChecks()).toBe(1);
    expect(await roster()).toMatchObject({ detail: "ci" });
  });

  it("retries its own infrastructure failures with backoff instead of blaming the human", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
      checkHangs = true;
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build");
      await idle();
      expect(await roster()).toMatchObject({ status: "running", detail: "retrying", actor: "system", waitingReason: null });
      expect((await roster()).activity).toContain("Verify: Chief of Staff retrying");
      expect((await roster()).lastError).toContain("exceeded its deadline");

      // Not due yet: nothing re-runs.
      await sweep();
      expect(ranChecks()).toBe(1);

      checkHangs = false;
      vi.setSystemTime(new Date("2026-11-06T10:02:00Z"));
      await sweep();
      expect(ranChecks()).toBe(2);
      expect(await roster()).toMatchObject({ detail: "ci", waitingReason: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for help after repeated infrastructure failures and says it is not the agent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let now = Date.parse("2026-11-06T10:00:00Z");
      vi.setSystemTime(now);
      checkHangs = true;
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build");
      await idle();
      for (let i = 0; i < 3; i++) {
        now += 20 * 60_000;
        vi.setSystemTime(now);
        await sweep();
      }
      const parked = await roster();
      expect(parked).toMatchObject({ detail: "waiting_on_human", waitingKind: "cos_error" });
      expect(parked.waitingReason).toContain("Chief of Staff could not run the check command");
      expect(parked.waitingReason).toContain("the agent is not asking anything");
      expect(ranChecks()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts a verify job lost to a plugin reload, keeping the database", async () => {
    let release!: () => void;
    checkBlocks = new Promise<void>((resolve) => (release = resolve));
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build");
    threadUpdatedAt = tick();
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "idle", updatedAt: threadUpdatedAt }), lastAssistantText: "done" });
    await vi.waitFor(() => expect(ranChecks()).toBe(1));

    checkBlocks = null;
    host = await host.harness.lifecycle.reload(plugin);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await host.harness.behavior.runService("cos-reconcile").done;
      await settleJobs();
    } finally {
      vi.useRealTimers();
    }
    expect(ranChecks()).toBe(2);
    // The old instance's late result is dropped.
    release();
    await new Promise((r) => setTimeout(r, 10));
    const entry = await roster();
    expect(entry.detail).toBe("ci");
    expect(ghCalls.filter((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")).toHaveLength(1);
  });

  it("keeps a plain-text question parked across a reload", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    assistantOutput = "Two options.\n\nShould I use Postgres?";
    await idle(assistantOutput);
    host = await host.harness.lifecycle.reload(plugin);
    await host.harness.behavior.runService("cos-reconcile").done;
    await sweep();
    expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingKind: "question" });
    expect(ranChecks()).toBe(0);
  });

  it("picks up a reply given in BB even when the thread.active event was missed", async () => {
    const pause = () => new Promise((r) => setTimeout(r, 5));
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await pause();
    // Realistic timestamps: BB's updatedAt is "now" when the idle fires.
    await idle("Two options.\n\nShould I use Postgres?", "thr_1", Date.now());
    expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingKind: "question" });
    // The human answered in BB; the agent finished and reported, but only the idle arrives.
    await pause();
    await report("build");
    await pause();
    await idle("Used Postgres.", "thr_1", Date.now());
    expect(ranChecks()).toBe(1);
    expect(await roster()).toMatchObject({ detail: "ci" });
  });

  it("does not nudge the idle builder while the independent reviewer works", async () => {
    await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false } } }) });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build");
    await idle();
    expect(await roster()).toMatchObject({ current: ["Review"], detail: "agent" });
    const before = sent.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
        // The builder idles from before the review prompt; the reviewer is working.
      perThread = { thr_1: { status: "idle", updatedAt: 1 }, thr_review: { status: "active", updatedAt: Date.now() } };
      for (let i = 1; i <= 5; i++) {
        vi.setSystemTime(Date.now() + 15 * 60_000);
        perThread.thr_review = { status: "active", updatedAt: Date.now() };
        await sweep();
      }
    } finally {
      vi.useRealTimers();
    }
    const after = (await roster()) as Entry & { steps: { id: string; retrying: boolean; status: string }[] };
    expect(after).toMatchObject({ current: ["Review"], detail: "agent" });
    expect(after.steps.find((st) => st.id === "review")).toMatchObject({ status: "running", retrying: false });
    expect(sent.slice(before).filter((m) => (m as { threadId: string }).threadId === "thr_1")).toHaveLength(0);
  });

  it("counts a CI failure again when a fix pushes no new commit", async () => {
    await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { maxCiFixes: 1 } } }) });
    ghRoutes["GET /repos/acme/app/commits/abc/check-runs"] = () => ({ body: { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/app/actions/runs/99" }] } });
    ghRoutes["GET /repos/acme/app/actions/runs/99/jobs"] = () => ({ body: { jobs: [] } });
    openPulls = [];
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build");
    await idle();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await sweep();
      const fixing = (await roster()) as Entry & { steps: { id: string; attempts: number }[] };
      expect(fixing).toMatchObject({ current: ["Build"] });
      expect(fixing.steps.find((st) => st.id === "ship")!.attempts).toBe(1);
      // The agent decides it was a flake and reports without committing: same head sha.
      currentPull = { ...currentPull };
      vi.setSystemTime(Date.now() + 3 * 60_000);
      await report("build");
      await idle();
      expect(await roster()).toMatchObject({ detail: "ci" });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await sweep();
      expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingKind: "escalation" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts items started before custom workflows at their old stage", async () => {
    const db = host.bb.storage.database();
    const at = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO work_items (id, repo, issue_number, issue_title, thread_id, environment_id, branch, pr_number, pr_url, status, source, created_at, updated_at, stage, waiting_kind, waiting_reason)
       VALUES (@id, 'acme/app', @issue, 'Old task', @thread, 'env_1', 'cos/old', @pr, @prUrl, @status, 'intake', @at, @at, @stage, @kind, @reason)`,
    );
    insert.run({ id: "old-verify", issue: 30, thread: "thr_1", pr: null, prUrl: null, status: "cos", at, stage: "verify", kind: null, reason: null });
    insert.run({ id: "old-ci", issue: 31, thread: "thr_old2", pr: 7, prUrl: "https://github.com/acme/app/pull/7", status: "ci", at, stage: "ship", kind: null, reason: null });
    insert.run({ id: "old-question", issue: 32, thread: "thr_old3", pr: null, prUrl: null, status: "waiting_on_human", at, stage: "build", kind: "question", reason: "Question: which DB?" });

    host = await host.harness.lifecycle.reload(plugin);
    await host.harness.behavior.runService("cos-reconcile").done;
    await settleJobs();
    const all = ((await host.harness.behavior.callRpc("cos_roster", { includeDone: true })) as { entries: (Entry & { issueNumber: number; workflowName: string; steps: { id: string; status: string; phase: string | null }[] })[] }).entries;
    const byIssue = (n: number) => all.find((e) => e.issueNumber === n)!;

    // Was running its checks: Build done, the Verify check re-runs, then ships.
    expect(byIssue(30).workflowName).toBe("acme/app (converted)");
    expect(byIssue(30).steps.find((st) => st.id === "build")!.status).toBe("done");
    expect(ranChecks()).toBe(1);
    expect(byIssue(30)).toMatchObject({ detail: "ci" });
    // Was waiting on CI: still watching the same PR.
    expect(byIssue(31)).toMatchObject({ detail: "ci", prNumber: 7 });
    expect(byIssue(31).steps.find((st) => st.id === "ship")).toMatchObject({ status: "running", phase: "ci" });
    // Was waiting on a question: still waiting, same question.
    expect(byIssue(32)).toMatchObject({ detail: "waiting_on_human", waitingKind: "question", waitingReason: "Build: Question: which DB?" });
  });

  it("revives a failed item when its thread is resumed", async () => {
    threadStatus = "active";
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_1", status: "error" }), error: "provider crashed" } as never);
    expect((await roster()).detail).toBe("failed");
    await sweep();
    expect(await roster()).toMatchObject({ detail: "agent", current: ["Build"] });
  });

  it("starts an ad-hoc task described by the operator or another agent", async () => {
    const started = (await host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", title: "Add rate limiting", body: "Limit /login to 5 req/min" })) as { id: string; workflow: string };
    expect(started.workflow).toBe("acme/app (converted)");
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
    expect(spawn.prompt).toContain("Add rate limiting");
    expect(spawn.prompt).toContain("Limit /login to 5 req/min");
    await expect(host.harness.behavior.callRpc("cos_start_task", { repo: "acme/other", title: "x", body: "" })).rejects.toThrow(/not configured/);
    const tool = await host.harness.behavior.callAgentTool("cos_start_task", { repo: "acme/app", title: "Second", description: "Do more" }, { threadId: "thr_parent" });
    expect(JSON.stringify(tool)).toContain("Started");
  });

  it("starts a described task through the configured workflow with intake disabled and no issue", async () => {
    const paused = JSON.parse(repos);
    paused.repos[0].allow.intake = false;
    await host.harness.behavior.setSettings({ repos: JSON.stringify(paused) });
    const started = await host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", title: "Improve login", body: "Explain errors" }) as { id: string; workflow: string };
    expect(started.workflow).toBe("acme/app (converted)");
    const entry = await roster();
    expect(entry).toMatchObject({ id: started.id, issueNumber: null, current: ["Build"] });
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
    expect(spawn.prompt).toContain("Explain errors");
    expect(ghCalls.some((call) => call.path === "/repos/acme/app/issues")).toBe(false);
  });

  it("shows the open question with options and context, and answers it from the dashboard", async () => {
    const question = {
      id: "int_1", status: "pending", threadId: "thr_1", createdAt: 1,
      payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Which database?", allowFreeText: true, multiSelect: false, required: true, options: [{ label: "Postgres", value: "pg", description: "Matches prod" }, { label: "SQLite", value: "sqlite" }] }] },
    };
    threadStatus = "active";
    await host.harness.behavior.callRpc("cos_intake_now", {});
    assistantOutput = "I compared both.\n\nPostgres matches production; SQLite is simpler.";
    pending = [question];
    await host.harness.behavior.emitThreadEvent("interaction.pending", { thread: makeThreadResponse({ id: "thr_1", status: "active" }), interaction: question as never });
    const { id } = await roster();

    const view = (await host.harness.behavior.callRpc("cos_question", { id })) as Record<string, unknown>;
    expect(view).toMatchObject({
      threadId: "thr_1",
      issueNumber: 12,
      stepName: "Build",
      waitingKind: "question",
      decidable: false,
      lastMessage: assistantOutput,
      open: [{ kind: "question", interactionId: "int_1", questions: [{ id: "q1", prompt: "Which database?", options: [{ label: "Postgres", value: "pg", description: "Matches prod" }, { label: "SQLite", value: "sqlite", description: null }] }] }],
    });

    // Unknown options and missing required answers are rejected before reaching BB.
    await expect(host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "question", interactionId: "int_1", answers: { q1: { selected: ["mysql"] } } } })).rejects.toThrow(/unknown option/);
    await expect(host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "question", interactionId: "int_1", answers: {} } })).rejects.toThrow(/needs an answer/);
    expect(resolved).toHaveLength(0);

    const result = (await host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "question", interactionId: "int_1", answers: { q1: { selected: ["pg"], freeText: "use the docker image" } } } })) as { status: string };
    expect(resolved).toEqual([{ threadId: "thr_1", interactionId: "int_1", resolution: { kind: "user_answer", answers: { q1: { selected: ["pg"], freeText: "use the docker image" } } } }]);
    expect(result.status).toBe("agent");
    expect(await roster()).toMatchObject({ detail: "agent", waitingReason: null });
    // Answering a question that is gone fails clearly.
    await expect(host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "question", interactionId: "int_1", answers: { q1: { selected: ["pg"] } } } })).rejects.toThrow(/no longer open/);

    // Approvals resolve with one of the offered decisions.
    const approval = { id: "int_2", status: "pending", threadId: "thr_1", createdAt: 2, payload: { kind: "approval", availableDecisions: ["allow_once", "deny"], reason: "Needs network", subject: { kind: "command", itemId: "x", command: "npm install", cwd: "/work", actions: [], sessionGrant: null } } };
    pending = [approval];
    await sweep();
    const approvalView = (await host.harness.behavior.callRpc("cos_question", { id })) as { open: unknown[] };
    expect(approvalView.open).toEqual([{ kind: "approval", interactionId: "int_2", subject: "run a command", reason: "Needs network", detail: "npm install\nin /work", detailMarkdown: false, decisions: ["allow_once", "deny"] }]);
    await expect(host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "approval", interactionId: "int_2", decision: "allow_for_session" } })).rejects.toThrow(/not offered/);
    await host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "approval", interactionId: "int_2", decision: "allow_once" } });
    expect(resolved.at(-1)).toEqual({ threadId: "thr_1", interactionId: "int_2", resolution: { decision: "allow_once", grantedPermissions: null } });

    // A plain-text question is answered with a message in the thread.
    threadStatus = "idle";
    assistantOutput = "Two findings need a call.\n\nShould I fix them now or file issues?";
    await idle(assistantOutput);
    const textView = (await host.harness.behavior.callRpc("cos_question", { id })) as { open: unknown[]; lastMessage: string };
    expect(textView.open).toEqual([{ kind: "text", question: "Should I fix them now or file issues?" }]);
    expect(textView.lastMessage).toContain("Two findings need a call.");
    await host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "text", text: "Fix them now." } });
    expect(sent).toEqual([{ threadId: "thr_1", mode: "auto", input: [{ type: "text", text: "Fix them now.", mentions: [] }] }]);
    expect(await roster()).toMatchObject({ detail: "agent" });

    // The activity log records who answered, never what they typed.
    const log = (await host.harness.behavior.callRpc("cos_log", { workItemId: id })) as { entries: { kind: string; message: string; actor: string }[] };
    const answers = log.entries.filter((e) => e.kind === "answer");
    expect(answers.map((e) => e.actor)).toEqual(["rpc:client", "rpc:client", "rpc:client"]);
    expect(JSON.stringify(answers)).not.toMatch(/docker image|Fix them now/);
  });

  it("exposes the roster through the agent tool and CLI", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const tool = await host.harness.behavior.callAgentTool("chief_of_staff_status", {});
    const text = typeof tool === "string" ? tool : tool.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("acme/app#12");
    expect(text).toContain("[Build/agent]");
    const cli = await host.harness.behavior.runCli(["status"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("acme/app#12");
    expect(cli.stdout).toContain("thr_1");
  });

  it("reads and writes settings for the configurator without exposing the token", async () => {
    const read = (await host.harness.behavior.callRpc("cos_get_settings", null)) as { values: Record<string, unknown>; token: { stored: boolean; source: string }; projects: { id: string; remote: string | null }[] };
    expect(JSON.stringify(read)).not.toContain("ghp_secret_token");
    expect(read.token).toEqual({ stored: true, source: "setting" });
    expect(read.values.intakeIntervalMinutes).toBe(10);
    expect(read.projects).toEqual([{ id: "proj_1", name: "app", remote: "https://github.com/acme/app" }]);
    expect((read as unknown as { providers: unknown[] }).providers).toEqual([{ id: "claude-code", displayName: "Claude Code", available: true, enabled: true }]);

    const saved = (await host.harness.behavior.callRpc("cos_set_settings", { stallThresholdMinutes: 45, githubToken: "ghp_rotated_token" })) as { changed: string[] };
    expect(saved.changed.sort()).toEqual(["githubToken", "stallThresholdMinutes"]);
    const after = (await host.harness.behavior.callRpc("cos_get_settings", null)) as { values: Record<string, unknown> };
    expect(after.values.stallThresholdMinutes).toBe(45);
    expect(JSON.stringify(after)).not.toContain("ghp_rotated_token");
    const log = await host.harness.behavior.runCli(["log"]);
    expect(log.stdout).toContain("settings updated");
    expect(log.stdout).not.toContain("ghp_rotated_token");

    await expect(host.harness.behavior.callRpc("cos_set_settings", { githubToken: "x", clearGithubToken: true })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("cos_set_settings", { stallThresholdMinutes: 99_999 })).rejects.toThrow();

    await host.harness.behavior.callRpc("cos_set_settings", { clearGithubToken: true });
    const cleared = (await host.harness.behavior.callRpc("cos_get_settings", null)) as { token: { stored: boolean } };
    expect(cleared.token.stored).toBe(false);
  });

  it("sends /skill references in step instructions as skill mentions", async () => {
    const workflow = { workflows: [{ id: "default", name: "Skilled", steps: [{ id: "build", name: "Build", type: "agent", writes: true, instructions: "Use /tdd and /nope. Avoid src/tdd." }] }], default: "default" };
    const plainRepos = JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, maxConcurrent: 2, allow: { intake: true, openPr: true } }] });
    await host.harness.behavior.callRpc("cos_set_config", { workflow: JSON.stringify(workflow), repos: plainRepos });
    expect(await host.harness.behavior.callRpc("cos_skills", null)).toEqual({ skills: [{ name: "tdd", description: "Test first", scope: "bb-project" }] });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const args = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt?: string; input?: { text: string; mentions: { start: number; end: number; resource: { name: string; source: string } }[] }[] };
    expect(args.prompt).toBeUndefined();
    const [input] = args.input!;
    expect(input!.text).toContain("Use /tdd and /nope.");
    expect(input!.mentions.map((m) => [input!.text.slice(m.start, m.end), m.resource.source])).toEqual([["/tdd", "skill"]]);
  });

  it("validates and stores the workflow from the configurator", async () => {
    await expect(host.harness.behavior.callRpc("cos_set_config", { workflow: JSON.stringify({ workflow: { ship: { action: "deploy" } } }) })).rejects.toThrow(/workflow/);
    await host.harness.behavior.callRpc("cos_set_config", { workflow: JSON.stringify({ workflow: { review: { mode: "self", instructions: "Check a11y" } } }) });
    const config = (await host.harness.behavior.callRpc("cos_get_config", null)) as { workflow: string };
    expect(JSON.parse(config.workflow).workflow.review).toEqual({ mode: "self", instructions: "Check a11y" });
  });

});
