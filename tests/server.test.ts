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
  let prCreated = false;
  let clock = 0;
  let pending: unknown[] = [];
  let resolved: unknown[] = [];
  let sent: unknown[] = [];
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
    checkHangs = false;
    checkBlocks = null;
    threadUpdatedAt = 0;
    clock = 0;
    assistantOutput = "Done.\n## Summary\nFixed the login bug.\n## Test evidence\nnpm test → 12 passing";
    prCreated = false;
    perThread = {};
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
          spawn: async (args: { environment: { type: string } }) =>
            args.environment.type === "reuse" ? makeThreadResponse({ id: "thr_r", environmentId: "env_1", providerId: "claude-code" }) : makeThreadResponse({ id: "thr_1", environmentId: "env_1", providerId: "claude-code" }),
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
            ["thr_1", "thr_r"].map((id) => {
              const status = perThread[id]?.status ?? threadStatus;
              return { ...makeThreadResponse({ id, environmentId: "env_1", status, updatedAt: perThread[id]?.updatedAt ?? threadUpdatedAt }), runtime: { displayStatus: status }, hasPendingInteraction: pending.length > 0 };
            }),
          output: async () => ({ output: assistantOutput }),
          send: async (args: unknown) => {
            sent.push(args);
            return { ok: true, delivery: "sent" } as never;
          },
          events: { list: async () => [] as never },
        },
        environments: { get: async () => ({ id: "env_1", hostId: "host_1", path: "/work/app/.bb/wt-1", branchName: "cos/issue-12-fix-login", status: "ready" }) as never },
        plugins: { callRpc: async () => ({ ok: true, channels: ["web"] }) },
        providers: { catalog: async () => [{ id: "claude-code", displayName: "Claude Code", available: true, enabled: true, info: {} }] as never },
      },
    });
    await plugin(host.bb);
  });

  /** A strictly increasing thread timestamp, always after Chief of Staff's latest prompt. */
  const tick = () => Date.now() + 60_000 + ++clock * 1000;
  /** The agent files its stage report through the cos_report tool. */
  const report = (stage: string, outcome = "done", summary = `${stage} done`, threadId = "thr_1", question?: string) =>
    host.harness.behavior.callAgentTool("cos_report", { stage, outcome, summary, ...(question ? { question } : {}) }, { threadId });
  /** A turn ends on a thread; wait for the jobs it starts. */
  const idle = async (lastAssistantText: string | null = "done", threadId = "thr_1", updatedAt = tick()) => {
    threadUpdatedAt = updatedAt;
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, environmentId: "env_1", status: "idle", updatedAt }), lastAssistantText });
    await settleJobs();
  };
  type Entry = { id: string; status: string; detail: string; stage: string; actor: string; activity: string; waitingKind: string | null; waitingReason: string | null; prNumber: number | null; fixAttempts: number; counters: Record<string, number> };
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
    expect(await roster()).toMatchObject({ stage: "build", detail: "agent", actor: "agent" });

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
    expect(await roster()).toMatchObject({ status: "running", stage: "ship", detail: "ci", prNumber: 7 });

    // CI green → ready to merge; merged → done (CI is polled every 2 minutes).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await sweep();
      expect(await roster()).toMatchObject({ stage: "ship", detail: "ready", actor: "human" });
      currentPull = { ...currentPull, merged: true, merged_at: "2026-11-05T02:00:00Z", state: "closed" };
      vi.setSystemTime(Date.now() + 3 * 60_000);
      await sweep();
      expect(await roster()).toMatchObject({ status: "done", stage: "done" });
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

  it("runs the full pipeline: plan approval, independent reviewer in the builder's workspace, review loop", async () => {
    await host.harness.behavior.setSettings({ workflow: fullWorkflow });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const first = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
    expect(first.prompt).toContain("Plan");
    expect(first.prompt).toContain("Do not change files");

    await report("plan", "done", "1. Patch auth.ts\n2. Add a regression test");
    await idle();
    const { id } = await roster();
    expect(await roster()).toMatchObject({ stage: "plan", detail: "waiting_on_human", waitingKind: "plan_approval", actor: "human" });
    const view = (await host.harness.behavior.callRpc("cos_question", { id })) as { plan: string; decidable: boolean };
    expect(view).toMatchObject({ plan: "1. Patch auth.ts\n2. Add a regression test", decidable: true });

    // Approve from the dashboard → the builder gets the build prompt with the plan.
    await host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "approve" } });
    expect(await roster()).toMatchObject({ stage: "build", detail: "agent" });
    expect(sentTexts().at(-1)).toContain("Approved plan");
    expect(sentTexts().at(-1)).toContain("Patch auth.ts");

    await report("build", "done", "Patched auth.ts");
    await idle();
    expect(ranChecks()).toBe(1);
    // Review: a reviewer thread in the builder's environment, nested under it.
    const reviewerSpawn = host.harness.inspection.sdk.callsTo("threads.spawn")[1][0] as { environment: unknown; parentThreadId: string; prompt: string };
    expect(reviewerSpawn.environment).toEqual({ type: "reuse", environmentId: "env_1" });
    expect(reviewerSpawn.parentThreadId).toBe("thr_1");
    expect(reviewerSpawn.prompt).toContain("You did not write it");
    expect(reviewerSpawn.prompt).toContain("git diff origin/main...HEAD");
    expect(await roster()).toMatchObject({ stage: "review", detail: "agent", activity: expect.stringContaining("Reviewer") });

    // The builder may not report review; the reviewer requests changes.
    expect(JSON.stringify(await report("review", "done", "lgtm", "thr_1"))).toContain("reviewer thread");
    await report("review", "changes_requested", "1. auth.ts:12 misses the null case", "thr_r");
    await idle("findings", "thr_r");
    expect(await roster()).toMatchObject({ stage: "build", detail: "agent", counters: expect.objectContaining({ reviewRounds: 1 }) });
    expect(sentTexts().at(-1)).toContain("auth.ts:12 misses the null case");

    // Fix → verify again → re-review in the same reviewer thread → approve → PR.
    await report("build", "done", "Handled null");
    await idle();
    expect(ranChecks()).toBe(2);
    expect((sent.at(-1) as { threadId: string }).threadId).toBe("thr_r");
    expect(sentTexts().at(-1)).toContain("Handled null");
    await report("review", "done", "Looks right now", "thr_r");
    await idle("ok", "thr_r");
    expect(await roster()).toMatchObject({ stage: "ship", detail: "ci", prNumber: 7 });
    const pr = ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")!.body as { body: string };
    expect(pr.body).toContain("Plan: approved by a human");
    expect(pr.body).toContain("independent reviewer agent, 1 round(s)");
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
    expect(await roster()).toMatchObject({ stage: "verify", detail: "cos", actor: "cos" });
    // A sweep while the job runs neither waits for it nor starts a second one.
    await host.harness.behavior.runSchedule("cos-sweep");
    expect(ranChecks()).toBe(1);
    release();
    await settleJobs();
    expect(ranChecks()).toBe(1);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(await roster()).toMatchObject({ stage: "ship", detail: "ci" });
  });

  it("nudges an agent that stops without reporting, then hands it to a human", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await idle("I made some changes.");
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain("without reporting the Build stage");
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
    expect(await roster()).toMatchObject({ stage: "build", detail: "agent", fixAttempts: 1 });

    await report("build");
    await idle();
    expect(await roster()).toMatchObject({ status: "waiting on human", stage: "verify", waitingKind: "escalation" });
    expect(host.harness.inspection.sdk.callsTo("plugins.callRpc").length).toBeGreaterThan(0);
    expect(ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")).toBeUndefined();

    // Send it back with instructions from the dashboard.
    const { id } = await roster();
    checkExit = 0;
    await host.harness.behavior.callRpc("cos_answer", { id, answer: { kind: "revise", feedback: "The flaky test needs a retry" } });
    expect(sentTexts().at(-1)).toContain("The flaky test needs a retry");
    await report("build");
    await idle();
    expect(await roster()).toMatchObject({ stage: "ship", detail: "ci" });
  });

  it("tracks questions and resumes in step with the thread", async () => {
    const question = { id: "int_1", status: "pending", threadId: "thr_1", createdAt: 1, payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Which database should I use?", allowFreeText: true, multiSelect: false, required: true }] } };

    threadStatus = "active";
    await host.harness.behavior.callRpc("cos_intake_now", {});
    expect(await roster()).toMatchObject({ detail: "agent" });

    // The agent asks through a BB interaction.
    pending = [question];
    await host.harness.behavior.emitThreadEvent("interaction.pending", { thread: makeThreadResponse({ id: "thr_1", status: "active" }), interaction: question as never });
    expect(await roster()).toMatchObject({ status: "waiting on human", waitingKind: "question", waitingReason: "Question: Which database should I use?" });

    // The human answers in BB. No event says so; the sweep notices.
    pending = [];
    await sweep();
    expect(await roster()).toMatchObject({ detail: "agent", waitingReason: null });

    // A missed interaction event is also caught by the sweep.
    pending = [question];
    await sweep();
    expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingReason: "Question: Which database should I use?" });
    pending = [];
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_1", status: "active" }) });
    expect(await roster()).toMatchObject({ detail: "agent" });

    // The agent ends its turn with a plain-text question: wait, do not verify.
    threadStatus = "idle";
    await idle("I found two options.\n\nShould I use Postgres or SQLite?");
    expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingReason: "Question: Should I use Postgres or SQLite?" });
    expect(ranChecks()).toBe(0);
    await sweep();
    expect(await roster()).toMatchObject({ detail: "waiting_on_human" });

    // The human replies in the thread: it resumes, reports, and ships.
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_1", status: "active" }) });
    expect(await roster()).toMatchObject({ detail: "agent", waitingReason: null });
    await report("build", "done", "Used Postgres.");
    await idle("## Summary\nUsed Postgres.");
    expect(ranChecks()).toBe(1);
    expect(await roster()).toMatchObject({ stage: "ship", detail: "ci" });
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
      expect((await roster()).activity).toContain("exceeded its deadline");

      // Not due yet: nothing re-runs.
      await sweep();
      expect(ranChecks()).toBe(1);

      checkHangs = false;
      vi.setSystemTime(new Date("2026-11-06T10:02:00Z"));
      await sweep();
      expect(ranChecks()).toBe(2);
      expect(await roster()).toMatchObject({ stage: "ship", detail: "ci", waitingReason: null });
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
      expect(parked.waitingReason).toContain("Chief of Staff could not run the verify command");
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
    expect(await roster()).toMatchObject({ stage: "ship", detail: "ci" });
  });

  it("does not nudge the idle builder while the independent reviewer works", async () => {
    await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false } } }) });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build");
    await idle();
    expect(await roster()).toMatchObject({ stage: "review", detail: "agent" });
    const before = sent.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
        // The builder idles from before the review prompt; the reviewer is working.
      perThread = { thr_1: { status: "idle", updatedAt: 1 }, thr_r: { status: "active", updatedAt: Date.now() } };
      for (let i = 1; i <= 5; i++) {
        vi.setSystemTime(Date.now() + 15 * 60_000);
        await sweep();
      }
    } finally {
      vi.useRealTimers();
    }
    expect(await roster()).toMatchObject({ stage: "review", detail: "agent", counters: expect.objectContaining({ infraRetries: 0 }) });
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
      expect(await roster()).toMatchObject({ stage: "build", counters: expect.objectContaining({ ciFixes: 1 }) });
      // The agent decides it was a flake and reports without committing: same head sha.
      currentPull = { ...currentPull };
      vi.setSystemTime(Date.now() + 3 * 60_000);
      await report("build");
      await idle();
      expect(await roster()).toMatchObject({ stage: "ship", detail: "ci" });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      await sweep();
      expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingKind: "escalation" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revives a failed item when its thread is resumed", async () => {
    threadStatus = "active";
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_1", status: "error" }), error: "provider crashed" } as never);
    expect((await roster()).detail).toBe("failed");
    await sweep();
    expect(await roster()).toMatchObject({ detail: "agent", stage: "build" });
  });

  it("starts an ad-hoc task described by the operator or another agent", async () => {
    const started = (await host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", title: "Add rate limiting", body: "Limit /login to 5 req/min" })) as { id: string; stage: string };
    expect(started.stage).toBe("build");
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
    expect(spawn.prompt).toContain("Add rate limiting");
    expect(spawn.prompt).toContain("Limit /login to 5 req/min");
    await expect(host.harness.behavior.callRpc("cos_start_task", { repo: "acme/other", title: "x", body: "" })).rejects.toThrow(/not configured/);
    const tool = await host.harness.behavior.callAgentTool("cos_start_task", { repo: "acme/app", title: "Second", description: "Do more" }, { threadId: "thr_parent" });
    expect(JSON.stringify(tool)).toContain("Started");
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
      stage: "build",
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
    expect(text).toContain("[build/agent]");
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

  it("validates and stores the workflow from the configurator", async () => {
    await expect(host.harness.behavior.callRpc("cos_set_config", { workflow: JSON.stringify({ workflow: { ship: { action: "deploy" } } }) })).rejects.toThrow(/workflow/);
    await host.harness.behavior.callRpc("cos_set_config", { workflow: JSON.stringify({ workflow: { review: { mode: "self", instructions: "Check a11y" } } }) });
    const config = (await host.harness.behavior.callRpc("cos_get_config", null)) as { workflow: string };
    expect(JSON.parse(config.workflow).workflow.review).toEqual({ mode: "self", instructions: "Check a11y" });
  });

});
