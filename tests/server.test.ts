// End-to-end wiring through the SDK's fake plugin host: intake → stages →
// push → PR, plus the CLI, agent tools, settings and the sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { REMOVED_SUMMARY, StateStore, isActiveStatus, type NewWorkItem } from "../src/state";
import { DEFAULT_WORKFLOW } from "../src/workflow";
import { settleJobs } from "../src/delivery";
import { initialNodes } from "../src/machine";
import { SETTLED_IDLE_MS } from "../src/sync";

/** Make the engine throw on the next event of this type (a bug in handling it). */
const engine = vi.hoisted(() => ({ failNext: null as string | null }));
vi.mock("../src/machine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/machine")>();
  return {
    ...actual,
    transition: (...args: Parameters<typeof actual.transition>) => {
      if (engine.failNext && args[1].type === engine.failNext) {
        engine.failNext = null;
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      }
      return actual.transition(...args);
    },
  };
});

type GhCall = { method: string; path: string; head?: string | null; body?: unknown; auth?: string | null };
type Route = (url: URL, init: RequestInit) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | undefined;

function fakeGitHub(routes: Record<string, Route>, calls: GhCall[]) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({ method, path: url.pathname, head: url.searchParams.get("head"), body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers?.authorization ?? null });
    const key = `${method} ${url.pathname}`;
    const handler = routes[key] ?? routes[`${method} *`];
    const result = handler?.(url, init);
    if (!result) return new Response(JSON.stringify({ message: `no route for ${key}` }), { status: 404 });
    return new Response(result.text ?? JSON.stringify(result.body ?? {}), { status: result.status ?? 200, headers: { "content-type": "application/json", ...result.headers } });
  });
}

const repos = JSON.stringify({
  repos: [
    { owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, maxConcurrent: 2, checkCommand: "npm test", allow: { intake: true, openPr: true, merge: true, release: false, deploy: false } },
  ],
});
/** Build → Verify (npm test via checkCommand) → Ship: the old single-turn flow. */
const minimalWorkflow = JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, verify: { maxAttempts: 1 } } });


const issue = { number: 12, title: "Fix login", body: "Login breaks", state: "open", html_url: "https://github.com/acme/app/issues/12", labels: [{ name: "agent-ready" }], milestone: null, assignees: [], updated_at: "2026-11-05T00:00:00Z", user: { login: "reporter" }, author_association: "NONE" };
const pull: Record<string, unknown> & { merged: boolean; merged_at: string | null; state: string } = { number: 7, title: "Fix login (#12)", body: "Closes #12", state: "open", draft: false, merged: false, merged_at: null, html_url: "https://github.com/acme/app/pull/7", head: { ref: "cos/issue-12-fix-login", sha: "abc" }, base: { ref: "main" }, labels: [], created_at: "2026-11-05T01:00:00Z", updated_at: "2026-11-05T01:00:00Z", mergeable: true, mergeable_state: "clean", user: { login: "bot" } };

describe("chief-of-staff server", () => {
  const ghCalls: GhCall[] = [];
  const hostCalls: { method: string; input: unknown; hostId: string }[] = [];
  let openPulls: unknown[] = [];
  let currentPull: typeof pull = { ...pull };
  let checkExit = 0;
  /** Appended to a failing check's output. */
  let checkLeak = "";
  let checkHangs = false;
  let threadUpdatedAt = 0;
  let threadStatus: "idle" | "active" | "error" = "idle";
  let checkBlocks: Promise<void> | null = null;
  let ghRoutes: Record<string, Route> = {};
  /** Per-thread overrides of status / updatedAt for the fake thread list. */
  let perThread: Record<string, { status?: "idle" | "active" | "error"; updatedAt?: number }> = {};
  /** What a thread's failed turn reports (its provider/error and rate-limit events). */
  let failures: Record<string, { errorInfo: { category: string; httpStatusCode: number | null; providerCode: null }; rateLimits: unknown }> = {};
  /** Retries of failed turns asked for, and the threads with one queued (a number: queued for then). */
  let retries: { threadId: string; sendAt?: number; reason?: string }[] = [];
  let queuedRetry: Record<string, boolean | number> = {};
  const spawned = new Set<string>();
  /** The thread ids of each threads.list call. */
  const threadListCalls: (readonly string[] | undefined)[] = [];
  let prCreated = false;
  let clock = 0;
  let pending: unknown[] = [];
  let resolved: unknown[] = [];
  let sent: unknown[] = [];
  let archivedIds: string[] = [];
  /** Threads archived now (archive adds, unarchive removes), and whether their workspace was removed. */
  let archivedNow = new Set<string>();
  let workspaceRemoved = false;
  let assistantOutput = "Done.\n## Summary\nFixed the login bug.\n## Test evidence\nnpm test → 12 passing";
  let host: ReturnType<typeof createFakePluginHost>;
  const originalFetch: typeof fetch = globalThis.fetch;

  beforeEach(async () => {
    ghCalls.length = 0;
    hostCalls.length = 0;
    openPulls = [];
    currentPull = { ...pull };
    checkExit = 0;
    checkLeak = "";
    threadStatus = "idle";
    pending = [];
    resolved = [];
    sent = [];
    archivedIds = [];
    archivedNow = new Set();
    workspaceRemoved = false;
    checkHangs = false;
    checkBlocks = null;
    threadUpdatedAt = 0;
    clock = 0;
    assistantOutput = "Done.\n## Summary\nFixed the login bug.\n## Test evidence\nnpm test → 12 passing";
    prCreated = false;
    perThread = {};
    failures = {};
    retries = [];
    queuedRetry = {};
    spawned.clear();
    threadListCalls.length = 0;
    ghRoutes = {
        "GET /repos/acme/app": () => ({ body: { default_branch: "main", full_name: "acme/app" } }),
        "GET /repos/acme/app/issues": () => ({ body: [issue] }),
        "GET /repos/acme/app/issues/12": () => ({ body: issue }),
        "GET /repos/acme/app/issues/12/comments": () => ({ body: [{ id: 1, body: "please fix", user: { login: "dan" }, created_at: "2026-11-05T00:00:00Z", author_association: "MEMBER" }] }),
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
        if (input.command === "npm test") return { ...ok, exitCode: checkExit, stdout: checkExit ? `1 failing${checkLeak}` : "all green" };
        return ok;
      },
      sdk: {
        system: { config: async () => ({ primaryHostId: "host_1" }) as never },
        projects: { list: async () => [{ id: "proj_1", kind: "git", name: "app", gitRemoteUrl: "https://github.com/acme/app", sources: [{ hostId: "host_1", path: "/work/app", isDefault: true }] }] as never },
        threads: {
          update: async () => ({ ok: true }) as never,
          // The builder (titled after its branch) is thr_1 in env_1; step threads are thr_<step title>.
          spawn: async (args: { environment: { type: string }; title?: string }) => {
            const title = args.title ?? "";
            const builder = title.startsWith("cos/");
            const id = builder ? "thr_1" : `thr_${title.split(":")[0]!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
            spawned.add(id);
            return makeThreadResponse({ id, environmentId: builder || args.environment.type === "reuse" ? "env_1" : `env_${id}`, providerId: "claude-code" });
          },
          get: async (args: { threadId: string }) => {
            const status = perThread[args.threadId]?.status ?? threadStatus;
            return { ...makeThreadResponse({ id: args.threadId, environmentId: "env_1", providerId: "claude-code", status, updatedAt: perThread[args.threadId]?.updatedAt ?? threadUpdatedAt }), runtime: { displayStatus: status }, archivedAt: archivedNow.has(args.threadId) ? 1 : null, canRestoreEnvironment: workspaceRemoved && !archivedNow.has(args.threadId) };
          },
          unarchive: async (args: { threadId: string }) => {
            archivedNow.delete(args.threadId);
            return { ok: true } as never;
          },
          restoreEnvironment: async () => {
            workspaceRemoved = false;
            return { ok: true } as never;
          },
          interactions: {
            list: async () => pending as never,
            resolve: async (args: unknown) => {
              resolved.push(args);
              pending = [];
              return { ok: true } as never;
            },
          },
          list: async (args?: { threadIds?: readonly string[] }) => {
            threadListCalls.push(args?.threadIds);
            return ["thr_1", ...[...spawned].filter((id) => id !== "thr_1")].map((id) => {
              const status = perThread[id]?.status ?? threadStatus;
              return { ...makeThreadResponse({ id, environmentId: "env_1", status, updatedAt: perThread[id]?.updatedAt ?? threadUpdatedAt }), runtime: { displayStatus: status }, hasPendingInteraction: pending.length > 0, archivedAt: archivedNow.has(id) ? 1 : null };
            });
          },
          output: async () => ({ output: assistantOutput }),
          archive: async (args: { threadId: string }) => {
            archivedIds.push(args.threadId);
            archivedNow.add(args.threadId);
            return { archivedThreadIds: [args.threadId] } as never;
          },
          send: async (args: unknown) => {
            sent.push(args);
            return { ok: true, delivery: "sent" } as never;
          },
          events: {
            list: async (args: { threadId: string; types?: readonly string[] }) => {
              const failure = failures[args.threadId];
              if (!failure) return [] as never;
              if (args.types?.includes("provider/error")) return [{ type: "provider/error", data: { message: "usage limit", errorInfo: failure.errorInfo } }] as never;
              if (args.types?.includes("provider/rateLimits/updated")) return [{ type: "provider/rateLimits/updated", data: { rateLimits: failure.rateLimits } }] as never;
              return [] as never;
            },
          },
          retry: async (args: { threadId: string; sendAt?: number; reason?: string }) => {
            if (queuedRetry[args.threadId]) throw new Error("retry_already_queued");
            retries.push(args);
            queuedRetry[args.threadId] = true;
            return {} as never;
          },
          queuedMessages: {
            list: async (args: { threadId: string }) => {
              const queued = queuedRetry[args.threadId];
              return (queued ? [{ id: "q1", threadId: args.threadId, payload: { kind: "retry" }, sendAt: typeof queued === "number" ? queued : null }] : []) as never;
            },
          },
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
  const report = (stage: string, outcome = "done", summary = `${stage} done`, threadId = "thr_1", question?: string) => {
    const store = new StateStore(host.bb.storage.database());
    const item = store.getWorkItemByThread(threadId);
    const delivery = item?.nodes[stage]?.deliveries?.[store.getThread(threadId)?.agent ?? 0]?.id;
    return host.harness.behavior.callAgentTool("cos_report", { step: stage, outcome, summary, ...(delivery ? { delivery } : {}), ...(question ? { question } : {}) }, { threadId });
  };
  /** A turn ends on a thread; wait for the jobs it starts. */
  const idle = async (lastAssistantText: string | null = "done", threadId = "thr_1", updatedAt = tick()) => {
    threadUpdatedAt = updatedAt;
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId, environmentId: "env_1", status: "idle", updatedAt }), lastAssistantText });
    await settleJobs();
  };
  type Entry = { id: string; status: string; detail: string; outcome: string | null; finishedAt: string | null; current: string[]; lastError: string | null; actor: string; activity: string; waitingKind: string | null; waitingReason: string | null; prNumber: number | null; issueUrl: string | null; fixAttempts: number; counters: Record<string, number> };
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

  it("pages filtered activity through the RPC and exposes an exclusive next cursor", async () => {
    const store = new StateStore(host.bb.storage.database());
    for (let i = 0; i < 3; i++) store.log({ level: "error", kind: "test", repo: null, workItemId: "paging-test", message: `error ${i}`, actor: "test" });
    for (let i = 0; i < 200; i++) store.log({ level: "info", kind: "test", repo: null, workItemId: "paging-test", message: `info ${i}`, actor: "test" });
    const first = await host.harness.behavior.callRpc("cos_log", { limit: 2, onlyProblems: true, workItemId: "paging-test" }) as { entries: { id: number; message: string }[]; nextCursor: number | null };
    expect(first.entries.map(e => e.message)).toEqual(["error 2", "error 1"]);
    expect(first.nextCursor).toBe(first.entries.at(-1)!.id);
    const last = await host.harness.behavior.callRpc("cos_log", { limit: 2, onlyProblems: true, workItemId: "paging-test", before: first.nextCursor });
    expect(last).toMatchObject({ entries: [{ message: "error 0" }], nextCursor: null });
    await expect(host.harness.behavior.callRpc("cos_log", { before: -1 })).rejects.toThrow();
  });

  it("groups older workflow threads on sweep and silences result notifications", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const state = new StateStore(host.bb.storage.database());
    const item = state.listWorkItems()[0]!;
    state.upsertThread({ threadId: "thr_old_plan", itemId: item.id, role: "step", stepId: "plan", agent: 0, environmentId: "env_old", round: 0, promptSentAt: null });
    const records = new Map(["thr_1", "thr_old_plan"].map((id) => [id, makeThreadResponse({ id })]));
    host.harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => records.get(threadId)!);
    host.harness.inspection.sdk.stub("threads.update", async ({ threadId, ...patch }: { threadId: string; parentThreadId: string; parentNotifications: "off" }) => {
      const next = { ...records.get(threadId)!, ...patch }; records.set(threadId, next); return next;
    });
    await sweep();
    await sweep();
    expect(host.harness.inspection.sdk.callsTo("threads.update")).toEqual([[{ threadId: "thr_old_plan", parentThreadId: "thr_1", parentNotifications: "off" }]]);
  });

  it("loads pre-model-choice workflows with defaults and completes their reports", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const db = host.bb.storage.database();
    const store = new StateStore(db);
    const item = store.listWorkItems()[0];
    const legacy = JSON.parse(JSON.stringify(item.workflow));
    for (const step of legacy.steps) delete step.chooses;
    db.prepare("UPDATE work_items SET workflow_json=? WHERE id=?").run(JSON.stringify(legacy), item.id);
    host = await host.harness.lifecycle.reload(plugin);
    expect(new StateStore(host.bb.storage.database()).getWorkItem(item.id)?.workflow.steps[0]).toHaveProperty("chooses", []);
    expect(JSON.stringify(await report("build"))).toContain("Recorded");
    await idle();
    expect(await roster()).toMatchObject({ detail: "done" });
  });

  it("does not retry a delivered prompt when post-send bookkeeping throws", async () => {
    const original = StateStore.prototype.log;
    vi.spyOn(StateStore.prototype, "log").mockImplementation(function (this: StateStore, entry) {
      if (entry.kind === "spawn") throw new Error("post-send bookkeeping failed");
      return original.call(this, entry);
    });
    try {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      const item = new StateStore(host.bb.storage.database()).listWorkItems()[0];
      expect(item.nodes.build.retry).toBeNull();
      expect(item.nodes.build.status).toBe("running");
      expect(JSON.stringify(await report("build"))).toContain("Recorded");
      await idle();
      expect(await roster()).toMatchObject({ detail: "done" });
    } finally { vi.restoreAllMocks(); }
  });

  it("keeps an uncertain send across reload and accepts the matching agent report", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    host.harness.inspection.sdk.stub("threads.send", async () => { throw new Error("accepted, response lost"); });
    await idle(); // nudge delivered but transport response lost
    const store = new StateStore(host.bb.storage.database());
    let item = store.listWorkItems()[0];
    expect(item.nodes.build.retry).toMatchObject({ uncertain: true, at: null });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    host = await host.harness.lifecycle.reload(plugin);
    threadStatus = "active";
    await host.harness.behavior.runService("cos-reconcile").done;
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    item = new StateStore(host.bb.storage.database()).getWorkItem(item.id)!;
    const delivery = item.nodes.build.deliveries?.[0]?.id;
    expect(delivery).toBeTruthy();
    expect(JSON.stringify(await host.harness.behavior.callAgentTool("cos_report", { step: "build", outcome: "done", summary: "done", delivery }, { threadId: "thr_1" }))).toContain("Recorded");
    await idle();
    expect(await roster()).toMatchObject({ detail: "done" });
  });

  it("rejects a tracked thread from an older round before staging a report", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    store.updateThread("thr_1", { round: item.nodes.build.round - 1 });
    expect(JSON.stringify(await report("build"))).toContain("earlier");
    expect(store.getThread("thr_1")?.pendingReport).toBeNull();
  });

  it.each(["done", "needs_input"])("recovers an uncertain send through a text %s report", async (outcome) => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    host.harness.inspection.sdk.stub("threads.send", async () => { throw new Error("response lost"); });
    await idle();
    const item = new StateStore(host.bb.storage.database()).listWorkItems()[0];
    const token = item.nodes.build.deliveries![0].id;
    await idle(`## Step report\nstep: build\ndelivery: wrong\noutcome: done\nsummary: stale`);
    expect((await roster()).waitingKind).toBe("cos_error");
    await idle(`## Step report\nstep: build\ndelivery: ${token}\noutcome: ${outcome}\nquestion: Which option?\nsummary: implemented`);
    expect(await roster()).toMatchObject(outcome === "done" ? { detail: "done" } : { waitingKind: "question" });
  });

  it("logs the stack of a failed send and clears the error once the agent reports (#24)", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    host.harness.inspection.sdk.stub("threads.send", async () => { throw new TypeError("Cannot read properties of undefined (reading 'length')"); });
    await idle();
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    const effectLog = store.listLog({ workItemId: item.id }).find((e) => e.kind === "effect");
    expect(effectLog?.message).toMatch(/^agent failed: .*reading 'length'\)\nTypeError[\s\S]*\n\s+at /);
    expect((await roster()).lastError).toContain("reading 'length'");
    const token = store.getWorkItem(item.id)!.nodes.build.deliveries![0].id;
    await idle(`## Step report\nstep: build\ndelivery: ${token}\noutcome: done\nsummary: implemented`);
    expect(await roster()).toMatchObject({ detail: "done", lastError: null });
  });

  it("recovers a lost spawn response using exact plugin metadata and its report token", async () => {
    let metadata: Record<string, unknown> = {};
    host.harness.inspection.sdk.stub("threads.spawn", async (args) => {
      metadata = (args as { pluginMetadata: Record<string, unknown> }).pluginMetadata;
      throw new Error("created the thread, lost the response");
    });
    host.harness.inspection.sdk.stub("threads.getPluginMetadata", async () => metadata as never);
    await host.harness.behavior.callRpc("cos_intake_now", {});
    expect((await roster()).waitingKind).toBe("cos_error");
    expect(JSON.stringify(await host.harness.behavior.callAgentTool("cos_report", {
      step: "build", delivery: metadata.delivery, outcome: "done", summary: "done",
    }, { threadId: "thr_lost" }))).toContain("Recorded");
    await idle("done", "thr_lost");
    expect(await roster()).toMatchObject({ detail: "done" });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("recovers legacy delivery-error waits but never an approval or unrelated failure", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    const node = item.nodes.build;
    delete node.deliveries;
    delete node.agentRetries;
    node.status = "waiting";
    node.waiting = { kind: "cos_error", reason: "legacy prompt failure" };
    node.retry = { effect: { type: "check", step: "build" }, count: 4, at: null };
    store.updateWorkItem(item.id, { nodes: item.nodes });
    expect(JSON.stringify(await report("build"))).toContain("not running");
    node.retry = { effect: { type: "agent", step: "build", agent: 0, kind: "nudge" }, count: 4, at: null };
    node.waiting = { kind: "approval", reason: "approval" };
    store.updateWorkItem(item.id, { nodes: item.nodes });
    expect(JSON.stringify(await report("build"))).toContain("not running");
    node.waiting = { kind: "cos_error", reason: "legacy prompt failure" };
    store.updateWorkItem(item.id, { nodes: item.nodes });
    host = await host.harness.lifecycle.reload(plugin);
    expect(JSON.stringify(await report("build"))).toContain("Recorded");
    await idle();
    expect(await roster()).toMatchObject({ detail: "done" });
  });

  it.each([
    ["tool", "failed", false], ["text", "deleted", false],
    ["tool", "deleted", true], ["text", "failed", true],
  ] as const)("rejects %s reports after a reviewer thread is %s (legacy=%s)", async (via, failure, legacy) => {
    await host.harness.behavior.setSettings({
      repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", workflow: "default" }] }),
      workflow: JSON.stringify({ default: "default", workflows: [{ id: "default", name: "Review", steps: [{ id: "review", name: "Review", type: "agent" }] }] }),
    });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    const delivery = item.nodes.review.deliveries![0].id;
    const thread = makeThreadResponse({ id: "thr_review", status: "error" });
    if (failure === "deleted") await host.harness.behavior.emitThreadEvent("thread.deleted", { thread });
    else await host.harness.behavior.emitThreadEvent("thread.failed", { thread, error: "provider crashed" } as never);
    const failed = store.getWorkItem(item.id)!;
    expect(failed.nodes.review.retry?.effect).toMatchObject({ type: "agent", fresh: true });
    if (legacy) {
      delete failed.nodes.review.retry!.cause;
      delete failed.nodes.review.agentRetries;
      store.updateWorkItem(item.id, { nodes: failed.nodes });
    }
    const before = store.getWorkItem(item.id)!.nodes.review;
    if (via === "tool") expect(JSON.stringify(await report("review", "done", "old thread done", "thr_review"))).toContain("not running");
    else await idle(`## Step report\nstep: review\ndelivery: ${delivery}\noutcome: done\nsummary: old thread done`, "thr_review");
    expect(store.getWorkItem(item.id)!.nodes.review).toEqual(before);
    expect(store.getThread("thr_review")?.pendingReport).toBeNull();
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    host.harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "thr_replacement", environmentId: "env_1" }));
    await host.harness.behavior.callRpc("cos_item_action", { id: item.id, action: "retry", step: "review" });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(JSON.stringify(await report("review", "done", "replacement done", "thr_replacement"))).toContain("Recorded");
    await idle("done", "thr_replacement");
    expect(store.getWorkItem(item.id)?.nodes.review.status).toBe("done");
  });

  it("preserves a sibling's uncertain retry and report on a multi-agent step", async () => {
    await host.harness.behavior.setSettings({ repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", workflow: "default" }] }), workflow: JSON.stringify({ default: "default", workflows: [{ id: "default", name: "Pair", steps: [{ id: "review", name: "Review", type: "agent", agents: 2 }] }] }) });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    host.harness.inspection.sdk.stub("threads.send", async () => { throw new Error("response lost"); });
    await idle("no report", "thr_review-1");
    await idle("no report", "thr_review-2"); // no blind nudge while parked
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    const retry = item.nodes.review.retry;
    expect(JSON.stringify(await report("review", "done", "second passed", "thr_review-2"))).toContain("Recorded");
    await idle("done", "thr_review-2");
    expect(store.getWorkItem(item.id)?.nodes.review).toMatchObject({ status: "waiting", retry, reports: [null, { summary: "second passed" }] });
    const delivery = item.nodes.review.deliveries![0].id;
    await host.harness.behavior.callAgentTool("cos_report", { step: "review", outcome: "done", summary: "first passed", delivery }, { threadId: "thr_review-1" });
    await idle("done", "thr_review-1");
    expect(await roster()).toMatchObject({ detail: "done" });
  });

  it("names tasks whose repository left the repos setting, in the overview and status (#52)", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const store = new StateStore(host.bb.storage.database());
    // A task queued for capacity earlier (as admission leaves one), not started yet.
    const running = store.listWorkItems()[0]!;
    const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = running;
    const waiting = store.insertWorkItem({ ...fields, id: "queued-task", status: "queued", issueNumber: null, issueTitle: "Tidy logs", threadId: null, nodes: initialNodes(running.workflow) });
    store.updateWorkItem(waiting.id, { queuedEvent: { type: "start" }, waitingReason: "Waiting for task capacity" });
    expect(store.listWorkItems().map((i) => i.status).sort()).toEqual(["agent", "queued"]);
    const overview = async () => ((await host.harness.behavior.callRpc("cos_overview", null)) as { warnings: string[] }).warnings;
    expect((await overview()).filter((w) => w.includes("repos setting"))).toEqual([]);

    await host.harness.behavior.setSettings({ repos: JSON.stringify({ repos: [{ owner: "acme", repo: "other", projectId: "proj_1" }] }) });
    await sweep();
    await sweep();
    // Each sweep re-tries the queued task; it logs the cause once.
    expect(store.listLog({ limit: 200 }).filter((e) => e.workItemId === "queued-task" && e.level === "warn")).toHaveLength(1);
    const queued = store.listWorkItems().find((i) => i.status === "queued")!;
    expect(queued.waitingReason).toMatch(/acme\/app is not in the repos setting/);
    expect((await host.harness.behavior.callRpc("cos_roster", {}) as { entries: Entry[] }).entries.find((e) => e.id === queued.id)?.activity).toMatch(/acme\/app is not in the repos setting/);
    const warning = (await overview()).find((w) => w.includes("repos setting"));
    expect(warning).toContain("acme/app#12");
    expect(warning).toContain("acme/app: Tidy logs");
    expect(JSON.parse((await host.harness.behavior.runCli(["status", "--json"])).stdout).warnings).toContain(warning);
    expect((await host.harness.behavior.runCli(["status"])).stdout).toContain(`warning: ${warning}`);
  });

  it("keeps four items isolated when one delivery becomes uncertain", async () => {
    await host.harness.behavior.setSettings({ repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", maxConcurrent: 4 }] }), maxConcurrentTotal: 4 });
    let serial = 0;
    host.harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: `task_${++serial}`, environmentId: "env_1" }));
    for (let i = 0; i < 4; i++) await host.harness.behavior.callAgentTool("cos_start_task", { repo: "acme/app", title: `Task ${i}`, description: `Fix ${i}` });
    const store = new StateStore(host.bb.storage.database());
    expect(store.listWorkItems()).toHaveLength(4);
    host.harness.inspection.sdk.stub("threads.send", async () => { throw new Error("response lost"); });
    await idle("no report", "task_1");
    expect(JSON.stringify(await report("build", "done", "second done", "task_2"))).toContain("Recorded");
    const affected = store.getWorkItemByThread("task_1")!;
    expect(affected.nodes.build.status).toBe("waiting");
    for (const id of ["task_2", "task_3", "task_4"]) expect(store.getWorkItemByThread(id)?.nodes.build).toMatchObject({ status: "running", retry: null });
    expect(store.getThread("task_1")?.pendingReport).toBeNull();
  });

  it("retries definite preparation failures with bounded backoff without spawning", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const original = StateStore.prototype.updateWorkItem;
      vi.spyOn(StateStore.prototype, "updateWorkItem").mockImplementation(function (this: StateStore, id, patch) {
        if (Object.keys(patch).length === 1 && patch.lastActivityAt) throw new Error("preparation failed");
        return original.call(this, id, patch);
      });
      await host.harness.behavior.callRpc("cos_intake_now", {});
      for (let i = 0; i < 3; i++) { vi.setSystemTime(Date.now() + 20 * 60_000); await sweep(); }
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      expect((await roster()).waitingKind).toBe("cos_error");
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it("does not resend accepted queued work after a long silent interval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      host.harness.inspection.sdk.stub("threads.send", async () => ({ ok: true, delivery: "queued", queuedMessage: { id: "queued_1" } }) as never);
      await idle();
      const calls = host.harness.inspection.sdk.callsTo("threads.send").length;
      threadUpdatedAt = 1; // an old idle snapshot cannot disprove acceptance
      vi.setSystemTime(Date.now() + 90 * 60_000);
      await sweep();
      expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(calls);
      expect(JSON.stringify(await report("build"))).toContain("Recorded");
      await idle();
      expect(await roster()).toMatchObject({ detail: "done" });
    } finally { vi.useRealTimers(); }
  });

  it("parks an interrupted in-flight delivery after reload without resending it", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    item.nodes.build.deliveries![0].state = "sending";
    store.updateWorkItem(item.id, { nodes: item.nodes });
    host = await host.harness.lifecycle.reload(plugin);
    threadStatus = "active";
    await host.harness.behavior.runService("cos-reconcile").done;
    expect(new StateStore(host.bb.storage.database()).getWorkItem(item.id)?.nodes.build.retry).toMatchObject({ uncertain: true, at: null });
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(JSON.stringify(await report("build"))).toContain("Recorded");
    await idle();
    expect(await roster()).toMatchObject({ detail: "done" });
  });

  it("accepts a current report after transient thread bookkeeping failure", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    const binding = vi.spyOn(StateStore.prototype, "upsertThread").mockImplementationOnce(() => { throw new Error("transient row update failed"); });
    try {
      await host.harness.behavior.callRpc("cos_item_action", { id: item.id, action: "rerun_step", step: "build" });
      expect(store.getWorkItem(item.id)?.nodes.build.deliveries?.[0].state).toBe("uncertain");
      expect(store.getThread("thr_1")?.round).toBe(1);
      expect(store.getWorkItem(item.id)?.nodes.build.round).toBe(2);
      binding.mockImplementationOnce(() => { throw new Error("report binding failed"); });
      await expect(report("build")).rejects.toThrow("report binding failed");
      expect(store.getThread("thr_1")?.round).toBe(1);
      expect(store.getWorkItem(item.id)?.nodes.build.deliveries?.[0].state).toBe("uncertain");
      expect(JSON.stringify(await report("build"))).toContain("Recorded");
      expect(store.getThread("thr_1")?.round).toBe(2);
      expect(store.getWorkItem(item.id)?.nodes.build.deliveries?.[0].state).toBe("accepted");
      await idle();
      expect(await roster()).toMatchObject({ detail: "done" });
      expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    } finally { vi.restoreAllMocks(); }
  });

  it.each([false, true])("preserves a failed thread when reconciling an interrupted delivery (legacy=%s)", async (legacy) => {
    await host.harness.behavior.setSettings({
      repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", workflow: "default" }] }),
      workflow: JSON.stringify({ default: "default", workflows: [{ id: "default", name: "Review", steps: [{ id: "review", name: "Review", type: "agent" }] }] }),
    });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    item.nodes.review.deliveries![0].state = "sending";
    store.updateWorkItem(item.id, { nodes: item.nodes });
    await host.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_review" }) });
    expect(store.getWorkItem(item.id)?.nodes.review.retry?.cause).toBe("thread_failure");
    if (legacy) {
      const failed = store.getWorkItem(item.id)!;
      delete failed.nodes.review.retry!.cause;
      delete failed.nodes.review.agentRetries;
      store.updateWorkItem(item.id, { nodes: failed.nodes });
    }
    const before = store.getWorkItem(item.id)!.nodes.review;
    await sweep();
    expect(store.getWorkItem(item.id)?.nodes.review).toEqual(before);
    expect(JSON.stringify(await report("review", "done", "old thread", "thr_review"))).toContain("not running");
    await idle("old thread done", "thr_review");
    expect(store.getWorkItem(item.id)?.nodes.review.status).toBe("waiting");
  });

  it("holds workflow progress and intake while paused, then resumes recorded reports", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await host.harness.behavior.callRpc("cos_set_paused", { paused: true });
    expect(await host.harness.behavior.callRpc("cos_overview", null)).toMatchObject({ paused: true });
    await expect(host.harness.behavior.callRpc("cos_intake_now", {})).rejects.toThrow(/paused/i);
    await sweep();
    await report("build");
    await idle();
    expect(ranChecks()).toBe(0);
    expect(await roster()).toMatchObject({ current: ["Build"] });
    await host.harness.behavior.callRpc("cos_set_paused", { paused: false });
    await settleJobs();
    expect(ranChecks()).toBe(1);
    expect(await host.harness.behavior.callRpc("cos_overview", null)).toMatchObject({ paused: false });
  });

  it("pauses one project: holds its intake and progress, then resumes the recorded report", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await host.harness.behavior.callRpc("cos_set_repo_paused", { repo: "acme/app", paused: true });
    expect(await host.harness.behavior.callRpc("cos_overview", null)).toMatchObject({ paused: false, repos: [{ key: "acme/app", paused: true }] });
    const intake = (await host.harness.behavior.callRpc("cos_intake_now", {})) as { results: { error?: string }[] };
    expect(intake.results[0].error).toMatch(/paused/i);
    await expect(host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", body: "do it" })).rejects.toThrow(/Project acme\/app is paused/);
    await expect(host.harness.behavior.callRpc("cos_set_repo_paused", { repo: "nope/nope", paused: true })).rejects.toThrow(/not configured/);
    await sweep();
    await report("build");
    await idle();
    expect(ranChecks()).toBe(0);
    expect(await roster()).toMatchObject({ current: ["Build"] });
    await host.harness.behavior.callRpc("cos_set_repo_paused", { repo: "acme/app", paused: false });
    await settleJobs();
    expect(ranChecks()).toBe(1);
    expect(await host.harness.behavior.callRpc("cos_overview", null)).toMatchObject({ repos: [{ paused: false }] });
  });

  it("takes an issue through build, verify and ship, never leaking the token", async () => {
    const intake = (await host.harness.behavior.callRpc("cos_intake_now", {})) as { results: { started: { issue: number; threadId: string }[] }[] };
    expect(intake.results[0].started).toEqual([{ issue: 12, threadId: "thr_1" }]);

    const spawnCalls = host.harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawnCalls).toHaveLength(1);
    const spawnArgs = spawnCalls[0][0] as { prompt: string; title: string; environment: { type: string; hostId: string; workspace: { type: string } } };
    expect(host.harness.inspection.sdk.callsTo("threadSections.create")).toHaveLength(0);
    expect(spawnArgs.title).toBe("cos/issue-12-fix-login");
    expect(spawnArgs.environment).toMatchObject({ type: "host", hostId: "host_1", workspace: { type: "managed-worktree" } });
    expect(spawnArgs.prompt).toContain("Fix login");
    expect(spawnArgs.prompt).toContain("please fix");
    expect(spawnArgs.prompt).toContain("Author: reporter (NONE)");
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
    expect(await roster()).toMatchObject({ status: "done", detail: "done", prNumber: 7, issueUrl: "https://github.com/acme/app/issues/12" });
    expect(archivedIds).toEqual(["thr_1"]);
    // The workflow view carries the task, what each step produced and the run's history.
    type View = { task: { branch: string; prNumber: number; issueUrl: string }; steps: Record<string, { reports: { summary: string }[]; threads: { threadId: string }[] }>; journal: { kind: string; step: string; detail: string | null; actor: string }[] };
    const view = await host.harness.behavior.callRpc("cos_item_workflow", { id: (await roster()).id as string }) as View;
    expect(view.task).toMatchObject({ branch: "cos/issue-12-fix-login", prNumber: 7, issueUrl: "https://github.com/acme/app/issues/12" });
    expect(view.steps.build).toMatchObject({ reports: [{ summary: "Fixed the login bug.\n\nnpm test → 12 passing" }], threads: [{ threadId: "thr_1" }] });
    expect(view.journal.find((e) => e.kind === "reported")).toMatchObject({ step: "build", detail: "Fixed the login bug.\n\nnpm test → 12 passing" });
    expect(view.journal.filter((e) => e.kind === "passed").map((e) => e.step)).toContain("build");
    expect(view.journal[0]).toMatchObject({ kind: "started", step: "build" });
    await sweep();
    expect(ghCalls.some((c) => c.method === "PUT" && c.path.endsWith("/merge"))).toBe(false);

    // The token went to GitHub as a bearer header and nowhere else.
    expect(ghCalls.every((c) => c.auth === "Bearer ghp_secret_token")).toBe(true);
    const status = await host.harness.behavior.runCli(["status", "--all", "--json"]);
    expect(status.stdout).not.toContain("ghp_secret_token");
    const log = await host.harness.behavior.runCli(["log"]);
    expect(log.stdout).not.toContain("ghp_secret_token");
  });

  it("reports occupied capacity separately from a merge waiting on review", async () => {
    await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge" } } }), maxConcurrentTotal: 1 });
    ghRoutes["GET /repos/acme/app/pulls/7/reviews"] = () => ({ body: [] });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build");
    await idle();
    await sweep();
    expect(await roster()).toMatchObject({ detail: "ready", occupiesCapacity: false, prNumber: 7 });
    const overview = await host.harness.behavior.callRpc("cos_overview", null) as { repos: { active: number }[]; occupiedCapacity: number };
    expect(overview.repos[0].active).toBe(0);
    expect(overview.occupiedCapacity).toBe(0);
    host.harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "thr_2", environmentId: "env_2" }));
    const b = await host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", title: "Another task", body: "Work while review waits" }) as { id: string };
    const after = await host.harness.behavior.callRpc("cos_overview", null) as typeof overview;
    expect(after.occupiedCapacity).toBe(1);
    expect(ghCalls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge"))).toHaveLength(0);
    host = await host.harness.lifecycle.reload(plugin);
    await host.harness.behavior.runService("cos-reconcile").done;
    expect(new StateStore(host.bb.storage.database()).listWorkItems().find((i) => i.id !== b.id)).toMatchObject({ status: "ready" });
    ghRoutes["GET /repos/acme/app/pulls/7/reviews"] = () => ({ body: [{ state: "APPROVED", user: { login: "alice" }, submitted_at: "" }] });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60_000);
      await sweep();
    } finally { vi.useRealTimers(); }
    const store = new StateStore(host.bb.storage.database());
    const a = store.listWorkItems().find((i) => i.id !== b.id)!;
    expect(a).toMatchObject({ status: "done", prNumber: 7, finishedAt: expect.any(String) });
    expect(store.getWorkItem(b.id)).toMatchObject({ status: "agent", finishedAt: null });
    expect(store.countOccupied()).toBe(1);
    expect(ghCalls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge"))).toHaveLength(1);
    expect(archivedIds).not.toContain("thr_2");
  });

  it.each(["red CI", "changes requested", "merge rejected"])("does not finalize merge delivery after %s", async (failure) => {
    await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge" } } }) });
    if (failure === "red CI") ghRoutes["GET /repos/acme/app/commits/abc/check-runs"] = () => ({ body: { check_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "failure" }] } });
    if (failure === "changes requested") ghRoutes["GET /repos/acme/app/pulls/7/reviews"] = () => ({ body: [{ state: "APPROVED", user: { login: "alice" } }, { state: "CHANGES_REQUESTED", user: { login: "bob" } }] });
    if (failure === "merge rejected") ghRoutes["PUT /repos/acme/app/pulls/7/merge"] = () => ({ status: 405, body: { message: "Branch protection" } });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build"); await idle(); await sweep();
    const item = new StateStore(host.bb.storage.database()).listWorkItems()[0];
    expect(item.status).not.toBe("done");
    expect(item.finishedAt).toBeNull();
    expect(ghCalls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge"))).toHaveLength(failure === "merge rejected" ? 1 : 0);
  });

  describe("a head with no checks reported (#50)", () => {
    const merges = () => ghCalls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge")).length;
    const status = () => new StateStore(host.bb.storage.database()).listWorkItems()[0]!.status;
    const noChecks = () => {
      ghRoutes["GET /repos/acme/app/commits/abc/check-runs"] = () => ({ body: { total_count: 0, check_runs: [] } });
    };

    it.each([
      { requireApproval: false },
      { requireApproval: true },
    ])("waits for CI to register before merging (requireApproval: $requireApproval)", async ({ requireApproval }) => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge", requireApproval } } }) });
      noChecks();
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await sweep();
        expect(merges()).toBe(0);
        expect(status()).not.toBe("done");
        vi.setSystemTime(Date.now() + 3 * 60_000);
        await sweep();
        expect(merges()).toBe(0);
        // A repository that really has no CI merges once the grace is over.
        vi.setSystemTime(Date.now() + 3 * 60_000);
        await sweep();
        expect(merges()).toBe(1);
        expect(status()).toBe("done");
      } finally { vi.useRealTimers(); }
    });

    it("merges as soon as checks that appear during the grace pass", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge", requireApproval: false } } }) });
      noChecks();
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await sweep();
        expect(merges()).toBe(0);
        ghRoutes["GET /repos/acme/app/commits/abc/check-runs"] = () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "ci", status: "in_progress", conclusion: null }] } });
        vi.setSystemTime(Date.now() + 2 * 60_000);
        await sweep();
        expect(merges()).toBe(0);
        ghRoutes["GET /repos/acme/app/commits/abc/check-runs"] = () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] } });
        vi.setSystemTime(Date.now() + 2 * 60_000);
        await sweep();
        expect(merges()).toBe(1);
        expect(status()).toBe("done");
      } finally { vi.useRealTimers(); }
    });

    it("merges an Actions-only repository once its check runs pass", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge", requireApproval: false } } }) });
      noChecks();
      // What GitHub reports for a commit with no commit statuses.
      ghRoutes["GET /repos/acme/app/commits/abc/status"] = () => ({ body: { state: "pending", total_count: 0 } });
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await sweep();
        expect(merges()).toBe(0);
        ghRoutes["GET /repos/acme/app/commits/abc/check-runs"] = () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] } });
        vi.setSystemTime(Date.now() + 2 * 60_000);
        await sweep();
        expect(merges()).toBe(1);
        expect(status()).toBe("done");
      } finally { vi.useRealTimers(); }
    });

    it("sends a failure that appears during the grace back to build", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge", requireApproval: false } } }) });
      ghRoutes["GET /repos/acme/app/actions/runs/99/jobs"] = () => ({ body: { jobs: [] } });
      noChecks();
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await sweep();
        expect(merges()).toBe(0);
        ghRoutes["GET /repos/acme/app/commits/abc/check-runs"] = () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/app/actions/runs/99" }] } });
        vi.setSystemTime(Date.now() + 2 * 60_000);
        await sweep();
        expect(merges()).toBe(0);
        const fixing = (await roster()) as Entry & { steps: { id: string; attempts: number }[] };
        expect(fixing).toMatchObject({ current: ["Build"] });
        expect(fixing.steps.find((st) => st.id === "ship")!.attempts).toBe(1);
      } finally { vi.useRealTimers(); }
    });
  });

  describe("pull request state (#114)", () => {
    const stored = () => new StateStore(host.bb.storage.database()).listWorkItems()[0]!;
    const merges = () => ghCalls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge")).length;

    it("records an open PR as soon as it opens one", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle();
      expect(ghCalls.some((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")).toBe(true);
      expect(stored().prState).toMatchObject({ number: 7, state: "open", draft: false, checks: null, review: null });
    });

    it("serves the recorded state on the roster only for the task's current PR", async () => {
      const pr = async () => ((await host.harness.behavior.callRpc("cos_roster", { includeDone: true })) as { entries: { pr: unknown }[] }).entries[0]!.pr;
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle();
      expect(await pr()).toEqual({ state: "open", draft: false, checks: null, review: null, checkedAt: expect.any(String) });
      const db = host.bb.storage.database();
      const store = new StateStore(db);
      // Re-shipped with another PR: the recorded state is the old one's.
      store.updateWorkItem(stored().id, { prNumber: 8 });
      expect(await pr()).toBeNull();
      store.updateWorkItem(stored().id, { prNumber: 7 });
      db.prepare("UPDATE work_items SET pr_state = NULL, pr_state_number = NULL, pr_state_json = NULL").run();
      expect(await pr()).toBeNull();
    });

    it("records the state of a PR it finds already open", async () => {
      prCreated = true;
      currentPull = { ...pull, draft: true };
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle();
      expect(ghCalls.some((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")).toBe(false);
      expect(stored().prState).toMatchObject({ number: 7, state: "open", draft: true });
    });

    it.each([
      { name: "an approval", reviews: [{ state: "APPROVED", user: { login: "alice" } }], merged: true },
      { name: "requested changes after an approval", reviews: [{ state: "APPROVED", user: { login: "alice" } }, { state: "CHANGES_REQUESTED", user: { login: "alice" } }], merged: false },
      // A pending review is a draft the reviewer has not submitted: it does not withdraw the approval.
      { name: "an approval, then a pending review", reviews: [{ state: "APPROVED", user: { login: "alice" } }, { state: "PENDING", user: { login: "alice" } }], merged: true },
    ])("merges only on approval: $name", async ({ reviews, merged }) => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge" } } }) });
      ghRoutes["GET /repos/acme/app/pulls/7/reviews"] = () => ({ body: reviews.map((r) => ({ ...r, submitted_at: "" })) });
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle(); await sweep();
      expect(merges()).toBe(merged ? 1 : 0);
      if (merged) expect(stored()).toMatchObject({ status: "done", prState: { number: 7, state: "merged", checks: null, review: null } });
      else expect(stored()).toMatchObject({ status: "ready", waitingReason: null, prState: { state: "open" } });
    });

    it("records a PR merged outside Chief of Staff when it comes to merge it", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge" } } }) });
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build"); await idle();
      const store = new StateStore(host.bb.storage.database());
      const item = stored();
      store.updateWorkItem(item.id, { status: "cos", nodes: { ...item.nodes, ship: { ...item.nodes.ship!, status: "running", phase: "merging" } } });
      currentPull = { ...pull, state: "closed", merged: true, merged_at: "2026-11-05T02:00:00Z" };
      host = await host.harness.lifecycle.reload(plugin);
      await host.harness.behavior.runService("cos-reconcile").done;
      await settleJobs();
      expect(merges()).toBe(0);
      expect(stored()).toMatchObject({ status: "done", prState: { state: "merged" } });
    });
  });

  it("releases capacity at PR creation and starts the next task", async () => {
    await host.harness.behavior.setSettings({ maxConcurrentTotal: 1 });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build"); await idle();
    const store = new StateStore(host.bb.storage.database());
    const a = store.listWorkItems()[0];
    expect(a).toMatchObject({ status: "done", prUrl: pull.html_url, finishedAt: expect.any(String) });
    expect(store.countOccupied()).toBe(0);
    host.harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "thr_2", environmentId: "env_2" }));
    await host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", title: "Next", body: "Next task" });
    expect(store.countOccupied()).toBe(1);
    expect(currentPull.merged).toBe(false);
    expect(store.getWorkItem(a.id)!.status).toBe("done");
  });

  it("does not finish PR-only delivery after PR creation fails", async () => {
    ghRoutes["POST /repos/acme/app/pulls"] = () => ({ status: 503, body: { message: "Unavailable" } });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build"); await idle();
    expect(new StateStore(host.bb.storage.database()).listWorkItems()[0]).toMatchObject({ status: "retrying", finishedAt: null, prNumber: null });
  });

  it("leaves queued repairs untouched during dry-run intake", async () => {
    await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge" } } }) });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build"); await idle();
    const store = new StateStore(host.bb.storage.database());
    const a = store.listWorkItems()[0];
    store.updateWorkItem(a.id, { status: "queued", queuedEvent: { type: "ci_failing", log: "Needs repair" } });
    const sends = sent.length;
    await host.harness.behavior.callRpc("cos_intake_now", { dryRun: true });
    expect(store.getWorkItem(a.id)).toMatchObject({ status: "queued", queuedEvent: { type: "ci_failing" } });
    expect(sent).toHaveLength(sends);
  });

  describe("intake capacity and PR lookup (#54)", () => {
    const issueN = (n: number) => ({ ...issue, number: n, title: `Issue ${n}`, html_url: `https://github.com/acme/app/issues/${n}` });
    type Intake = { results: { considered: number; started: { issue: number; threadId: string }[]; skipped: { issue: number; reason: string }[] }[] };
    const intake = (dryRun = false) => host.harness.behavior.callRpc("cos_intake_now", dryRun ? { dryRun: true } : {}) as Promise<Intake>;
    const configure = async (maxConcurrent: number, maxConcurrentTotal = 10) => {
      await host.harness.behavior.setSettings({ repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, maxConcurrent, checkCommand: "npm test", allow: { intake: true, openPr: true, merge: true, release: false, deploy: false } }] }), maxConcurrentTotal });
    };
    /** Open-PR list requests (state=open, no head filter), told apart from the head lookups. */
    let listCalls: string[] = [];
    beforeEach(() => {
      listCalls = [];
      ghRoutes["GET /repos/acme/app/issues"] = () => ({ body: [issueN(13), issueN(14), issueN(15)] });
      const original = ghRoutes["GET /repos/acme/app/pulls"]!;
      ghRoutes["GET /repos/acme/app/pulls"] = (url, init) => {
        if (!url.searchParams.get("head")) listCalls.push(url.search);
        return original(url, init);
      };
      let serial = 0;
      host.harness.inspection.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: `task_${++serial}`, environmentId: "env_1" }));
    });

    it("lists the open PRs once for the whole run, newest first", async () => {
      const result = await intake();
      expect(result.results[0].started.map((s) => s.issue)).toEqual([13, 14]);
      expect(listCalls).toHaveLength(1);
      expect(listCalls[0]).toContain("direction=desc");
    });

    it("skips an issue whose open PR closes it, and one on its branch, and starts the rest", async () => {
      openPulls = [
        { ...pull, number: 30, body: "Closes #13", head: { ref: "feature/x", sha: "a" } },
        { ...pull, number: 31, body: "", head: { ref: "cos/issue-14-issue-14", sha: "b" } },
      ];
      const result = await intake();
      expect(result.results[0].skipped).toEqual([{ issue: 13, reason: "open PR #30" }, { issue: 14, reason: "open PR #31" }]);
      expect(result.results[0].started.map((s) => s.issue)).toEqual([15]);
      expect(listCalls).toHaveLength(1);
    });

    it("makes no PR request for a repository that is at capacity", async () => {
      await configure(0);
      const result = await intake();
      expect(listCalls).toHaveLength(0);
      expect(result.results[0]).toMatchObject({ considered: 3, started: [] });
      expect(result.results[0].skipped).toEqual([13, 14, 15].map((n) => ({ issue: n, reason: "repo at max concurrency (0)" })));
    });

    it("makes no PR request once the repository fills up during the run, and skips the rest with the capacity reason", async () => {
      await configure(1);
      const result = await intake();
      expect(result.results[0].started.map((s) => s.issue)).toEqual([13]);
      expect(result.results[0].skipped).toEqual([{ issue: 14, reason: "repo at max concurrency (1)" }, { issue: 15, reason: "repo at max concurrency (1)" }]);
      expect(listCalls).toHaveLength(1);
      listCalls.length = 0;
      await intake();
      expect(listCalls).toHaveLength(0);
    });

    it("makes no PR request when every issue already has an active thread", async () => {
      await intake();
      listCalls.length = 0;
      await intake();
      expect(listCalls).toHaveLength(0);
    });

    it("counts a dry run's would-starts against the repository limit and creates no work", async () => {
      await configure(2);
      const result = await intake(true);
      expect(result.results[0].started).toEqual([{ issue: 13, threadId: "(dry-run)" }, { issue: 14, threadId: "(dry-run)" }]);
      expect(result.results[0].skipped).toEqual([{ issue: 15, reason: "repo at max concurrency (2)" }]);
      expect(new StateStore(host.bb.storage.database()).listWorkItems()).toHaveLength(0);
    });

    it("counts a dry run's would-starts against the global limit", async () => {
      await configure(5, 1);
      const result = await intake(true);
      expect(result.results[0].started.map((s) => s.issue)).toEqual([13]);
      expect(result.results[0].skipped).toEqual([{ issue: 14, reason: "global max concurrency (1)" }, { issue: 15, reason: "global max concurrency (1)" }]);
    });

    it("starts in a real run exactly what the dry run reported", async () => {
      await configure(2);
      const dry = await intake(true);
      const real = await intake();
      expect(real.results[0].started.map((s) => s.issue)).toEqual(dry.results[0].started.map((s) => s.issue));
      expect(real.results[0].skipped).toEqual(dry.results[0].skipped);
    });
  });

  describe("an issue whose task finished is not restarted (#48)", () => {
    type Intake = { results: { started: { issue: number; threadId: string }[]; skipped: { issue: number; reason: string }[] }[] };
    const intake = async (dryRun = false) => ((await host.harness.behavior.callRpc("cos_intake_now", dryRun ? { dryRun: true } : {})) as Intake).results[0]!;
    const items = () => new StateStore(host.bb.storage.database()).listWorkItems();
    const action = (act: string) => host.harness.behavior.callRpc("cos_item_action", { id: items()[0]!.id, action: act });
    /** Writes of the issue's status comment ("started an agent"), created or edited. */
    const statusWrites = () => ghCalls.filter((c) => (c.method === "POST" || c.method === "PATCH") && c.path.includes("/issues/") && c.path.includes("/comments") && String((c.body as { body?: string } | undefined)?.body ?? "").startsWith("<!-- cos-status -->")).length;
    const merging = JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge" } } });
    const FAILED = "previous task failed; retry it or relabel the issue";
    const DONE = "previous task is done; relabel the issue to start again";
    const PR_CLOSED = "previous task's PR was closed without merging; relabel the issue to start again";
    const expectNotRestarted = async (reason: string) => {
      const result = await intake();
      expect(result.started).toEqual([]);
      expect(result.skipped).toEqual([{ issue: 12, reason }]);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn").filter(([args]) => String((args as { title?: string }).title).startsWith("cos/"))).toHaveLength(1);
      expect(statusWrites()).toBe(1);
      expect(items()).toHaveLength(1);
    };

    it("after the task is marked failed", async () => {
      await intake();
      await action("mark_failed");
      await expectNotRestarted(FAILED);
    });

    it("after a task without a PR is marked done", async () => {
      await intake();
      await action("mark_done");
      await expectNotRestarted(DONE);
    });

    it("after a workflow that ships by pushing finishes", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "push" } } }) });
      await intake();
      await report("build"); await idle();
      expect(items()[0]).toMatchObject({ status: "done", prNumber: null });
      await expectNotRestarted(DONE);
    });

    it("after its PR is closed without merging", async () => {
      await host.harness.behavior.setSettings({ workflow: merging });
      ghRoutes["GET /repos/acme/app/pulls/7/reviews"] = () => ({ body: [] });
      await intake();
      await report("build"); await idle(); await sweep();
      expect(items()[0]).toMatchObject({ status: "ready" });
      currentPull = { ...pull, state: "closed" };
      // The CI watch runs every two minutes.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 3 * 60_000);
        await sweep();
      } finally { vi.useRealTimers(); }
      expect(items()[0]).toMatchObject({ status: "failed", lastError: "PR closed without merge" });
      await expectNotRestarted(PR_CLOSED);
    });

    it("after its PR is merged and the issue stays open", async () => {
      await host.harness.behavior.setSettings({ workflow: merging });
      await intake();
      await report("build"); await idle(); await sweep();
      expect(items()[0]).toMatchObject({ status: "done", prState: { state: "merged" } });
      await expectNotRestarted(DONE);
    });

    it.each(["thread.failed", "thread.archived", "thread.deleted"])("after the builder thread ends with %s", async (event) => {
      await intake();
      const thread = makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: event === "thread.failed" ? "error" : "idle", ...(event === "thread.archived" ? { archivedAt: Date.now() } : event === "thread.deleted" ? { deletedAt: Date.now() } : {}) });
      await host.harness.behavior.emitThreadEvent(event as "thread.failed", { thread, error: "provider crashed" } as never);
      expect(items()[0]).toMatchObject({ status: "failed" });
      await expectNotRestarted(FAILED);
    });

    it("lets the operator retry the same task instead", async () => {
      await intake();
      await action("mark_failed");
      await action("retry");
      const result = await intake();
      expect(result.started).toEqual([]);
      expect(result.skipped).toEqual([{ issue: 12, reason: "active thread exists" }]);
      expect(items()).toHaveLength(1);
    });

    it("reports the same skip in a dry run and makes no open-PR request for it", async () => {
      await intake();
      await action("mark_failed");
      const listed = () => ghCalls.filter((c) => c.method === "GET" && c.path === "/repos/acme/app/pulls").length;
      const before = listed();
      expect((await intake(true)).skipped).toEqual([{ issue: 12, reason: FAILED }]);
      await expectNotRestarted(FAILED);
      expect(listed()).toBe(before);
    });

    describe("when the PR closes on GitHub before Chief of Staff notices", () => {
      const T0 = Date.parse("2026-11-06T10:00:00Z");
      const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
      const at = (minutes: number) => vi.setSystemTime(T0 + minutes * 60_000);
      beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
      afterEach(() => vi.useRealTimers());

      it("ignores the close time of an earlier PR of the task", async () => {
        at(0);
        await intake();
        const store = new StateStore(host.bb.storage.database());
        const id = items()[0]!.id;
        // PR #7 closed at 1; the task shipped again as #8 and then failed at 5.
        store.setPrState(id, { number: 7, state: "closed", draft: false, checks: null, review: null, checkedAt: iso(1), closedAt: iso(1) });
        store.updateWorkItem(id, { prNumber: 8 });
        at(5);
        await action("mark_failed");
        // Labelled at 2, while the task was still running.
        ghRoutes["GET /repos/acme/app/issues"] = () => ({ body: [{ ...issue, updated_at: iso(6) }] });
        ghRoutes["GET /repos/acme/app/issues/12/events"] = () => ({ body: [{ event: "labeled", created_at: iso(2), label: { name: "agent-ready" } }] });
        at(7);
        expect(await intake()).toMatchObject({ started: [], skipped: [{ issue: 12, reason: FAILED }] });
      });

      it.each([
        ["closed", { state: "closed", closed_at: iso(1) }, "failed"],
        ["merged", { state: "closed", merged: true, merged_at: iso(1), closed_at: iso(1) }, "done"],
      ] as const)("counts a relabel made after the PR was %s, before the CI watch saw it", async (_name, closed, status) => {
        await host.harness.behavior.setSettings({ workflow: merging });
        ghRoutes["GET /repos/acme/app/pulls/7/reviews"] = () => ({ body: [] });
        ghRoutes["PATCH /repos/acme/app/issues/comments/2"] = () => ({ body: { id: 2, body: "", user: null, created_at: "" } });
        at(0);
        await intake();
        await report("build"); await idle(); await sweep();
        expect(items()[0]).toMatchObject({ status: "ready" });
        // Closed on GitHub at 1, relabelled at 2; the CI watch notices at 3.
        currentPull = { ...pull, ...closed };
        ghRoutes["GET /repos/acme/app/issues"] = () => ({ body: [{ ...issue, updated_at: iso(2) }] });
        ghRoutes["GET /repos/acme/app/issues/12/events"] = () => ({ body: [{ event: "labeled", created_at: iso(2), label: { name: "agent-ready" } }] });
        at(3);
        await sweep();
        expect(items()[0]).toMatchObject({ status, finishedAt: iso(3), prState: { closedAt: iso(1) } });
        at(4);
        expect((await intake()).started.map((s) => s.issue)).toEqual([12]);
        expect(items()).toHaveLength(2);
      });
    });

    describe("until a person relabels or reassigns the issue", () => {
      const T0 = Date.parse("2026-11-06T10:00:00Z");
      const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
      const at = (minutes: number) => vi.setSystemTime(T0 + minutes * 60_000);
      const MARKER = "intake:relabelChecked:acme/app#12";
      const builderSpawns = () => host.harness.inspection.sdk.callsTo("threads.spawn").filter(([args]) => String((args as { title?: string }).title).startsWith("cos/")).length;
      const eventCalls = (n = 12) => ghCalls.filter((c) => c.method === "GET" && c.path === `/repos/acme/app/issues/${n}/events`).length;
      const markLatestFailed = () => host.harness.behavior.callRpc("cos_item_action", { id: new StateStore(host.bb.storage.database()).latestForIssue("acme/app", 12)!.id, action: "mark_failed" });
      /** The issue as listed now: `updatedAt` minutes after T0, with these events. */
      const issueNow = (updatedAt: number, events: unknown[] | (() => { status?: number; body?: unknown; headers?: Record<string, string> }), more: unknown[] = []) => {
        ghRoutes["GET /repos/acme/app/issues"] = () => ({ body: [{ ...issue, updated_at: iso(updatedAt) }, ...more] });
        ghRoutes["GET /repos/acme/app/issues/12/events"] = typeof events === "function" ? events : () => ({ body: events });
      };
      const labeled = (minutes: number, name = "agent-ready") => ({ event: "labeled", created_at: iso(minutes), label: { name } });
      beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        // A restart edits the issue's status comment rather than post another.
        ghRoutes["PATCH /repos/acme/app/issues/comments/2"] = () => ({ body: { id: 2, body: "", user: null, created_at: "" } });
        let serial = 0;
        host.harness.inspection.sdk.stub("threads.spawn", async (args: { title?: string }) => makeThreadResponse({ id: `${String(args.title).startsWith("cos/") ? "builder" : "step"}_${++serial}`, environmentId: "env_1" }));
        // The first task starts at T0 and fails a minute later.
        at(0);
        await intake();
        at(1);
        await markLatestFailed();
      });
      afterEach(() => vi.useRealTimers());

      it("starts again once after a filter label is added, then stays stopped", async () => {
        issueNow(2, [{ event: "commented", created_at: iso(0) }, labeled(2)]);
        at(3);
        expect((await intake()).started.map((s) => s.issue)).toEqual([12]);
        expect(builderSpawns()).toBe(2);
        expect(statusWrites()).toBe(2);
        expect(await intake()).toMatchObject({ started: [], skipped: [{ issue: 12, reason: "active thread exists" }] });
        at(4);
        await markLatestFailed();
        const calls = eventCalls();
        expect(await intake()).toMatchObject({ started: [], skipped: [{ issue: 12, reason: FAILED }] });
        expect(eventCalls()).toBe(calls);
        expect(builderSpawns()).toBe(2);
      });

      it.each([
        ["the issue changed without a label event", [{ event: "referenced", created_at: iso(2) }]],
        ["the label was added before the task finished", [labeled(0.5)]],
        ["the label added is not one of the filter's", [labeled(2, "bug")]],
      ])("stays stopped when %s, and asks GitHub once per issue update", async (_name, events) => {
        issueNow(2, events);
        at(3);
        expect(await intake()).toMatchObject({ started: [], skipped: [{ issue: 12, reason: FAILED }] });
        expect(eventCalls()).toBe(1);
        expect(await host.bb.storage.kv.get(MARKER)).toEqual({ itemId: new StateStore(host.bb.storage.database()).latestForIssue("acme/app", 12)!.id, updatedAt: iso(2) });
        await intake();
        expect(eventCalls()).toBe(1);
        // A later update is looked at again.
        issueNow(2.5, events);
        await intake();
        expect(eventCalls()).toBe(2);
        expect(builderSpawns()).toBe(1);
      });

      it("matches the label name regardless of case", async () => {
        issueNow(2, [labeled(2, "Agent-Ready")]);
        at(3);
        expect((await intake()).started.map((s) => s.issue)).toEqual([12]);
      });

      it("starts again after the filter's assignee is assigned again", async () => {
        await host.harness.behavior.setSettings({ repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: [], assignee: "dan" }, maxConcurrent: 2, checkCommand: "npm test", allow: { intake: true, openPr: true, merge: true, release: false, deploy: false } }] }) });
        issueNow(2, [{ event: "assigned", created_at: iso(2), assignee: { login: "someone-else" } }]);
        at(3);
        // Without filter labels, a relabel would not restart it: the reason says to reassign.
        expect(await intake()).toMatchObject({ started: [], skipped: [{ issue: 12, reason: "previous task failed; retry it or reassign the issue" }] });
        issueNow(2.5, [{ event: "assigned", created_at: iso(2.5), assignee: { login: "Dan" } }]);
        expect((await intake()).started.map((s) => s.issue)).toEqual([12]);
      });

      it("counts an assignment to anyone when the filter's assignee is *", async () => {
        await host.harness.behavior.setSettings({ repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: [], assignee: "*" }, maxConcurrent: 2, checkCommand: "npm test", allow: { intake: true, openPr: true, merge: true, release: false, deploy: false } }] }) });
        issueNow(2, [{ event: "assigned", created_at: iso(2), assignee: { login: "someone" } }]);
        at(3);
        expect((await intake()).started.map((s) => s.issue)).toEqual([12]);
      });

      it("makes no events request while the issue has not changed since the task finished", async () => {
        issueNow(0.5, [labeled(0.5)]);
        at(3);
        expect(await intake()).toMatchObject({ skipped: [{ issue: 12, reason: FAILED }] });
        await intake();
        expect(eventCalls()).toBe(0);
        expect(await host.bb.storage.kv.get(MARKER)).toBeUndefined();
      });

      it.each([500, 404])("skips only that issue when the events request fails with %i, and asks again next time", async (status) => {
        const other = { ...issue, number: 13, title: "Other", html_url: "https://github.com/acme/app/issues/13" };
        issueNow(2, () => ({ status, body: { message: "nope" } }), [other]);
        at(3);
        const result = await intake();
        expect(result.skipped).toEqual([{ issue: 12, reason: FAILED }]);
        expect(result.started.map((s) => s.issue)).toEqual([13]);
        expect(await host.bb.storage.kv.get(MARKER)).toBeUndefined();
        issueNow(2, [labeled(2)], [other]);
        expect((await intake()).started.map((s) => s.issue)).toEqual([12]);
      });

      it("stops the repository on a rate limit while reading the events", async () => {
        const other = { ...issue, number: 13, title: "Other", html_url: "https://github.com/acme/app/issues/13" };
        issueNow(2, () => ({ status: 429, headers: { "retry-after": "600" }, body: { message: "API rate limit exceeded" } }), [other]);
        at(3);
        const result = (await host.harness.behavior.callRpc("cos_intake_now", {}) as { results: { started: unknown[]; error?: string }[] }).results[0]!;
        expect(result.error).toMatch(/rate limit/);
        expect(result.started).toEqual([]);
      });

      it("reports a relabelled issue as a start in a dry run, and writes nothing", async () => {
        issueNow(2, [labeled(2)]);
        at(3);
        expect((await intake(true)).started).toEqual([{ issue: 12, threadId: "(dry-run)" }]);
        expect(items()).toHaveLength(1);
        issueNow(2, []);
        expect((await intake(true)).skipped).toEqual([{ issue: 12, reason: FAILED }]);
        expect(await host.bb.storage.kv.get(MARKER)).toBeUndefined();
        expect(items()).toHaveLength(1);
      });
    });
  });

  describe("overlapping intake runs (#49)", () => {
    type Intake = { results: { started: { issue: number; threadId: string }[]; skipped: { issue: number; reason: string }[] }[] };
    const activeFor12 = () => new StateStore(host.bb.storage.database()).listWorkItems().filter((item) => item.issueNumber === 12 && isActiveStatus(item.status));
    /** An item something else started: active, occupying capacity, with no thread to spawn. */
    const otherItem = (id: string, issueNumber: number): NewWorkItem => ({ id, repo: "acme/app", status: "agent", issueTitle: "other", issueNumber, branch: null, threadId: null, environmentId: null, prNumber: null, prUrl: null, providerId: null, model: null, lastError: null, source: "intake", lastActivityAt: null, finishedAt: null, workflow: DEFAULT_WORKFLOW, nodes: {} });
    /** While intake lists the open PRs (after its first check, before its insert), run `during` once. */
    const duringPrLookup = (during: () => void) => {
      const original = ghRoutes["GET /repos/acme/app/pulls"]!;
      let done = false;
      ghRoutes["GET /repos/acme/app/pulls"] = (url, init) => {
        if (!done && !url.searchParams.get("head")) { done = true; during(); }
        return original(url, init);
      };
    };
    const statusComments = () => ghCalls.filter((c) => c.method === "POST" && c.path === "/repos/acme/app/issues/12/comments");

    const intake = (input: { dryRun?: boolean } = {}) => host.harness.behavior.callRpc("cos_intake_now", input) as Promise<Intake>;
    /** Open-PR list requests (no head filter): one per intake run that got past its first check. */
    const prLists = () => ghCalls.filter((c) => c.method === "GET" && c.path === "/repos/acme/app/pulls" && !c.head).length;
    /** Hold the next open-PR list request until `open()`; `reached` settles once it is held. */
    const holdNextPrList = () => {
      let open!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const atGate = new Promise<void>((resolve) => (reached = resolve));
      const inner = globalThis.fetch;
      let held = false;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        if (!held && (init?.method ?? "GET") === "GET" && url.pathname === "/repos/acme/app/pulls" && !url.searchParams.get("head")) {
          held = true;
          reached();
          await gate;
        }
        return inner(input, init);
      }) as typeof fetch;
      return { reached: atGate, open };
    };

    it("starts an issue once when two manual intakes overlap", async () => {
      const [a, b] = await Promise.all([intake(), intake()]);
      await settleJobs();
      // The second run waited for the first, so it skipped at its first check, before any PR request.
      expect(prLists()).toBe(1);
      expect(activeFor12()).toHaveLength(1);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      expect(statusComments()).toHaveLength(1);
      expect([...a.results[0].started, ...b.results[0].started]).toEqual([{ issue: 12, threadId: "thr_1" }]);
      expect([...a.results[0].skipped, ...b.results[0].skipped]).toEqual([{ issue: 12, reason: "active thread exists" }]);
    });

    it("starts an issue once when the sweep's intake overlaps a manual one", async () => {
      await Promise.all([host.harness.behavior.runSchedule("cos-sweep"), intake()]);
      await settleJobs();
      expect(prLists()).toBe(1);
      expect(activeFor12()).toHaveLength(1);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      expect(statusComments()).toHaveLength(1);
    });

    it("runs a dry run without waiting for the real intake in progress", async () => {
      const gate = holdNextPrList();
      const real = intake();
      await gate.reached;
      const dry = await intake({ dryRun: true });
      expect(dry.results[0].started).toEqual([{ issue: 12, threadId: "(dry-run)" }]);
      gate.open();
      expect((await real).results[0].started).toEqual([{ issue: 12, threadId: "thr_1" }]);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    });

    it("runs the next intake after one that throws", async () => {
      const original = StateStore.prototype.listWorkItems;
      let thrown = false;
      const spy = vi.spyOn(StateStore.prototype, "listWorkItems").mockImplementation(function (this: StateStore, ...args) {
        if (!thrown) { thrown = true; throw new Error("store unavailable"); }
        return original.apply(this, args);
      });
      try {
        const [failed, next] = await Promise.allSettled([intake(), intake()]);
        expect(failed).toMatchObject({ status: "rejected", reason: { message: expect.stringContaining("store unavailable") } });
        expect(next).toMatchObject({ status: "fulfilled", value: { results: [{ started: [{ issue: 12, threadId: "thr_1" }] }] } });
      } finally { spy.mockRestore(); }
    });

    it("skips an issue started by something else after its first check, without spawning or commenting", async () => {
      duringPrLookup(() => new StateStore(host.bb.storage.database()).insertWorkItem(otherItem("other", 12)));
      const result = (await host.harness.behavior.callRpc("cos_intake_now", {})) as Intake;
      await settleJobs();
      expect(result.results[0]).toMatchObject({ started: [], skipped: [{ issue: 12, reason: "active thread exists" }] });
      expect(activeFor12().map((item) => item.id)).toEqual(["other"]);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      expect(statusComments()).toHaveLength(0);
    });

    it("skips an issue when its project is paused after its first check", async () => {
      duringPrLookup(() => new StateStore(host.bb.storage.database()).setRepoPaused("acme/app", true));
      const result = await intake();
      expect(result.results[0]).toMatchObject({ started: [], skipped: [{ issue: 12, reason: "paused" }] });
      expect(activeFor12()).toHaveLength(0);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      expect(statusComments()).toHaveLength(0);
    });

    it("skips an issue when the repository filled up after its first check", async () => {
      await host.harness.behavior.setSettings({ repos: repos.replace('"maxConcurrent":2', '"maxConcurrent":1') });
      duringPrLookup(() => new StateStore(host.bb.storage.database()).insertWorkItem(otherItem("other", 99)));
      const result = (await host.harness.behavior.callRpc("cos_intake_now", {})) as Intake;
      expect(result.results[0]).toMatchObject({ started: [], skipped: [{ issue: 12, reason: "repo at max concurrency (1)" }] });
      expect(activeFor12()).toHaveLength(0);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    });
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
    expect(spawns()[0].parentThreadId).toBeUndefined();
    for (const child of spawns().slice(1)) expect(child).toMatchObject({ parentThreadId: "thr_plan-1", parentNotifications: "off" });
    const parallel = spawns().slice(-2);
    expect(parallel.map((p) => p.title.split(":")[0])).toEqual(["Review", "Docs"]);
    for (const p of parallel) {
      expect(p.environment).toEqual({ type: "reuse", environmentId: "env_1" });
      expect(p.parentThreadId).toBe("thr_plan-1");
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
    expect(await roster()).toMatchObject({ detail: "done", prNumber: 7 });
    const pr = ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")!.body as { body: string };
    expect(pr.body).toContain("## Workflow: Careful");
    expect(pr.body).toContain("### Plan (approved)");
    expect(pr.body).toContain("Looks right now");
  });

  it("runs later steps with the model an agent picked, and a model step overrides it", async () => {
    const flow = {
      workflows: [
        {
          id: "adaptive",
          name: "Adaptive",
          steps: [
            {
              id: "triage",
              name: "Triage",
              type: "agent",
              instructions: "Judge how hard the task is.",
              chooses: [
                { id: "easy", when: "small change", model: "haiku" },
                { id: "hard", when: "risky change", providerId: "codex", model: "opus", reasoningLevel: "high" },
              ],
              next: ["build"],
            },
            { id: "build", name: "Build", type: "agent", writes: true, instructions: "Build it.", next: ["pin"] },
            { id: "pin", name: "Pin", type: "model", model: "sonnet", next: ["review"] },
            { id: "review", name: "Review", type: "agent", instructions: "Review it." },
          ],
        },
      ],
      default: "adaptive",
    };
    const repos = JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, workflow: "adaptive", reasoningLevel: "low" }] });
    await host.harness.behavior.setSettings({ workflow: JSON.stringify(flow), repos, defaultModel: "default-model" });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    type Spawn = { title: string; prompt: string; providerId?: string; model?: string; reasoningLevel?: string };
    const spawns = () => host.harness.inspection.sdk.callsTo("threads.spawn").map((c) => c[0] as Spawn);

    // Before any choice: the global default and the repository's reasoning level.
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]).toMatchObject({ title: "Triage: cos/issue-12-fix-login", model: "default-model", reasoningLevel: "low" });
    expect(spawns()[0]!.prompt).toContain("`hard`: risky change");

    // The agent has to pick one of the listed choices.
    const refused = await host.harness.behavior.callAgentTool("cos_report", { step: "triage", outcome: "done", summary: "x", choice: "medium" }, { threadId: "thr_triage" });
    expect(JSON.stringify(refused)).toContain("set `choice` to one of");
    expect(JSON.stringify(await host.harness.behavior.callAgentTool("cos_report", { step: "triage", outcome: "done", summary: "x" }, { threadId: "thr_triage" }))).toContain("set `choice` to one of");
    await host.harness.behavior.callAgentTool("cos_report", { step: "triage", outcome: "done", summary: "Risky: touches auth.", choice: "hard" }, { threadId: "thr_triage" });
    await idle("ok", "thr_triage");

    // The builder spawns with the pick; unset fields (none here) would fall back.
    expect(spawns().at(-1)).toMatchObject({ title: "cos/issue-12-fix-login", providerId: "codex", model: "opus", reasoningLevel: "high" });

    // The model step after it overrides the model and keeps the rest.
    await report("build", "done", "Built");
    await idle();
    expect(spawns().at(-1)).toMatchObject({ title: expect.stringMatching(/^Review:/), providerId: "codex", model: "sonnet", reasoningLevel: "high" });
  });

  const autoFlow = {
    workflows: [
      {
        id: "auto",
        name: "Auto",
        steps: [
          { id: "pick", name: "Pick model", type: "model", mode: "auto", instructions: "This is the task. Choose the best model for the job.", next: ["build"] },
          { id: "build", name: "Build", type: "agent", writes: true, instructions: "Build it." },
        ],
      },
    ],
    default: "auto",
  };
  const useAutoFlow = (repo: Record<string, unknown> = {}) =>
    host.harness.behavior.setSettings({ workflow: JSON.stringify(autoFlow), repos: JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, workflow: "auto", ...repo }] }), defaultModel: "default-model" });

  it("recovers a lost spawn response for an automatic model step", async () => {
    let metadata: Record<string, unknown> = {};
    host.harness.inspection.sdk.stub("threads.spawn", async (args) => {
      metadata = (args as { pluginMetadata: Record<string, unknown> }).pluginMetadata;
      throw new Error("created the thread, lost the response");
    });
    host.harness.inspection.sdk.stub("threads.getPluginMetadata", async () => metadata as never);
    await useAutoFlow();
    await host.harness.behavior.callRpc("cos_intake_now", {});
    expect(metadata.step).toBe("pick");
    expect((await roster()).waitingKind).toBe("cos_error");
    expect(JSON.stringify(await host.harness.behavior.callAgentTool("cos_report", {
      step: "pick", delivery: metadata.delivery, outcome: "done", summary: "Opus", providerId: "claude-code", model: "claude-opus-5-5",
    }, { threadId: "thr_lost" }))).toContain("Recorded");
  });

  it("runs an automatic model step in the project's checkout, not a new worktree, when no code exists yet", async () => {
    await useAutoFlow();
    await host.harness.behavior.callRpc("cos_intake_now", {});
    type Env = { environment: { type: string; hostId?: string; workspace?: { type: string; path?: string | null } } };
    const spawns = () => host.harness.inspection.sdk.callsTo("threads.spawn").map((c) => c[0] as Env);
    expect(spawns()[0]!.environment).toMatchObject({ type: "host", workspace: { type: "unmanaged", path: null } });
    await host.harness.behavior.callAgentTool("cos_report", { step: "pick", outcome: "done", summary: "Opus", providerId: "claude-code", model: "claude-opus-5-5" }, { threadId: "thr_pick-model" });
    await idle("ok", "thr_pick-model");
    // The builder still gets its own worktree.
    expect(spawns().at(-1)!.environment).toMatchObject({ type: "host", workspace: { type: "managed-worktree" } });
  });

  it("spawns the writer with exactly the pick: no reasoning level from the repository", async () => {
    await useAutoFlow({ reasoningLevel: "low", providerId: "claude-code", model: "sonnet" });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await host.harness.behavior.callAgentTool("cos_report", { step: "pick", outcome: "done", summary: "GPT-5", providerId: "codex", model: "gpt-5" }, { threadId: "thr_pick-model" });
    await idle("ok", "thr_pick-model");
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn").at(-1)![0] as Record<string, unknown>;
    expect(spawn).toMatchObject({ providerId: "codex", model: "gpt-5" });
    expect(spawn).not.toHaveProperty("reasoningLevel");
  });

  it("runs an automatic model step as an agent and spawns later steps with its pick", async () => {
    const flow = {
      workflows: [
        {
          id: "auto",
          name: "Auto",
          steps: [
            { id: "pick", name: "Pick model", type: "model", mode: "auto", instructions: "This is the task. Choose the best model for the job.", next: ["build"] },
            { id: "build", name: "Build", type: "agent", writes: true, instructions: "Build it." },
          ],
        },
      ],
      default: "auto",
    };
    const repos = JSON.stringify({ repos: [{ owner: "acme", repo: "app", projectId: "proj_1", issueFilter: { labels: ["agent-ready"] }, workflow: "auto" }] });
    await host.harness.behavior.setSettings({ workflow: JSON.stringify(flow), repos, defaultModel: "default-model" });
    await host.harness.behavior.callRpc("cos_intake_now", {});
    type Spawn = { title: string; prompt: string; providerId?: string; model?: string; reasoningLevel?: string };
    const spawns = () => host.harness.inspection.sdk.callsTo("threads.spawn").map((c) => c[0] as Spawn);

    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]).toMatchObject({ title: "Pick model: cos/issue-12-fix-login", model: "default-model" });
    expect(spawns()[0]!.prompt).toContain("Choose the best model for the job.");
    expect(spawns()[0]!.prompt).toContain("bb provider list --json");

    // A pick needs a provider and a model.
    for (const partial of [{}, { reasoningLevel: "high" }, { providerId: "codex" }, { model: "gpt-5" }]) {
      const refused = await host.harness.behavior.callAgentTool("cos_report", { step: "pick", outcome: "done", summary: "x", ...partial }, { threadId: "thr_pick-model" });
      expect(JSON.stringify(refused)).toContain("This step chooses the model");
    }
    await host.harness.behavior.callAgentTool("cos_report", { step: "pick", outcome: "done", summary: "Touches auth: strongest model.", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }, { threadId: "thr_pick-model" });
    await idle("ok", "thr_pick-model");

    expect(spawns().at(-1)).toMatchObject({ title: "cos/issue-12-fix-login", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    const id = (await roster()).id as string;
    const view = await host.harness.behavior.callRpc("cos_item_workflow", { id }) as { live: Record<string, { picked?: string | null }> };
    expect(view.live.pick?.picked).toBe("claude-code · claude-opus-5-5 · high");
  });

  it("keeps a task's model pick, stats and views after its step details are removed", async () => {
    await useAutoFlow();
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await host.harness.behavior.callAgentTool("cos_report", { step: "pick", outcome: "done", summary: "Touches auth: strongest model.", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }, { threadId: "thr_pick-model" });
    await idle("ok", "thr_pick-model");
    type Spawn = { title: string; providerId?: string; model?: string; reasoningLevel?: string };
    const spawns = () => host.harness.inspection.sdk.callsTo("threads.spawn").map((c) => c[0] as Spawn);
    const picked = { title: "cos/issue-12-fix-login", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
    expect(spawns().at(-1)).toMatchObject(picked);
    const id = (await roster()).id as string;
    await host.harness.behavior.callRpc("cos_item_action", { id, action: "mark_failed" });

    // Finished 91 days ago, then compacted by retention.
    const db = host.bb.storage.database();
    const longAgo = new Date(Date.now() - 91 * 86_400_000).toISOString();
    db.prepare("UPDATE work_items SET finished_at = ?, updated_at = ? WHERE id = ?").run(longAgo, longAgo, id);
    const stats = () => host.harness.behavior.callRpc("cos_stats", { windowDays: 90 });
    const statsBefore = await stats();
    expect(new StateStore(db).compactFinished(new Date(Date.now() - 90 * 86_400_000).toISOString())).toEqual([id]);
    expect(await stats()).toEqual(statsBefore);
    expect(await roster()).toMatchObject({ id, status: "failed" });
    const view = await host.harness.behavior.callRpc("cos_item_workflow", { id }) as { live: Record<string, { picked?: string | null }>; steps: Record<string, { reports: { summary: string }[]; threads: unknown[] }> };
    expect(view.live.pick?.picked).toBe("claude-code · claude-opus-5-5 · high");
    expect(view.steps.pick!.reports).toEqual([expect.objectContaining({ outcome: "done", summary: REMOVED_SUMMARY })]);
    expect(view.steps.build!.threads).toEqual([expect.objectContaining({ threadId: "thr_1" })]);

    // Retry restarts the writer on the model the step picked.
    const before = spawns().length;
    await host.harness.behavior.callRpc("cos_item_action", { id, action: "retry" });
    await settleJobs();
    expect(spawns().length).toBe(before + 1);
    expect(spawns().at(-1)).toMatchObject(picked);
    expect(db.prepare("SELECT detail_pruned_at FROM work_items WHERE id = ?").get(id)).toEqual({ detail_pruned_at: null });
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

  describe("closing a task by hand (#47)", () => {
    const markDone = async () => host.harness.behavior.callRpc("cos_item_action", { id: (await roster()).id, action: "mark_done" });
    /** The issue is no longer offered, so a sweep only syncs the task's threads. */
    const intakeOnce = async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      ghRoutes["GET /repos/acme/app/issues"] = () => ({ body: [] });
    };

    it("stays done when the agent's turn ends afterwards: no nudge, threads archived", async () => {
      await intakeOnce();
      expect(await roster()).toMatchObject({ detail: "agent", current: ["Build"] });
      await markDone();
      expect(await roster()).toMatchObject({ status: "done", detail: "done", current: [], lastError: "Marked done" });
      expect(archivedIds).toEqual(["thr_1"]);
      await idle("I made some changes.");
      await sweep();
      expect(await roster()).toMatchObject({ status: "done", current: [] });
      expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
      expect(ranChecks()).toBe(0);
      const log = (await host.harness.behavior.runCli(["log", "--limit", "20"])).stdout;
      expect(log.match(/marked done/g)).toHaveLength(1);
      // Marking it done again changes and logs nothing.
      await markDone();
      expect((await host.harness.behavior.runCli(["log", "--limit", "20"])).stdout.match(/marked done/g)).toHaveLength(1);
    });

    /** Build reported; the Verify check is running and held until the returned release is called. */
    const checkRunning = async () => {
      await intakeOnce();
      await report("build");
      let release!: () => void;
      checkBlocks = new Promise<void>((resolve) => (release = resolve));
      const updatedAt = tick();
      threadUpdatedAt = updatedAt;
      await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_1", environmentId: "env_1", status: "idle", updatedAt }), lastAssistantText: "done" });
      expect(await roster()).toMatchObject({ current: ["Verify"], detail: "cos" });
      return release;
    };
    const pushes = () => hostCalls.filter((c) => (c.input as { args?: string[] }).args?.[0] === "push").length;

    it("drops the result of a check still running when the task is marked done", async () => {
      const release = await checkRunning();
      await markDone();
      expect(await roster()).toMatchObject({ status: "done", current: [] });
      release();
      await settleJobs();
      await sweep();
      expect(await roster()).toMatchObject({ status: "done", current: [], lastError: "Marked done" });
      expect(ranChecks()).toBe(1);
      expect(pushes()).toBe(0);
      expect(ghCalls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toHaveLength(0);
    });

    it("drops the result of a check still running when the task is marked failed, and retry runs it again", async () => {
      const release = await checkRunning();
      const { id } = await roster();
      await host.harness.behavior.callRpc("cos_item_action", { id, action: "mark_failed" });
      expect(await roster()).toMatchObject({ status: "failed", current: [] });
      release();
      await settleJobs();
      expect(await roster()).toMatchObject({ status: "failed" });
      expect(pushes()).toBe(0);
      await host.harness.behavior.callRpc("cos_item_action", { id, action: "retry" });
      await settleJobs();
      expect(ranChecks()).toBe(2);
      expect(await roster()).toMatchObject({ status: "done", lastError: null });
    });

    it("stays failed while the builder is still working", async () => {
      threadStatus = "active";
      await intakeOnce();
      await host.harness.behavior.callRpc("cos_item_action", { id: (await roster()).id, action: "mark_failed" });
      await sweep();
      expect(await roster()).toMatchObject({ status: "failed", lastError: "Marked failed" });
      expect(archivedIds).toEqual([]);
    });

    const question = { id: "int_1", status: "pending", threadId: "thr_1", createdAt: 1, payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Which database should I use?", allowFreeText: true, multiSelect: false, required: true }] } };
    const notifications = () => host.harness.inspection.sdk.callsTo("plugins.callRpc").length;

    it("ignores questions, resumed turns and late reports on a done task", async () => {
      await intakeOnce();
      await markDone();
      const before = notifications();
      pending = [question];
      await host.harness.behavior.emitThreadEvent("interaction.pending", { thread: makeThreadResponse({ id: "thr_1", status: "active" }), interaction: question as never });
      await host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_1", status: "active" }) } as never);
      expect(await roster()).toMatchObject({ status: "done", waitingKind: null, current: [] });
      expect(notifications()).toBe(before);
      expect(await report("build")).toBe("This task is already finished.");
    });

    it("does not read the turns or questions of a task marked failed", async () => {
      await intakeOnce();
      await host.harness.behavior.callRpc("cos_item_action", { id: (await roster()).id, action: "mark_failed" });
      const reads = () => host.harness.inspection.sdk.callsTo("threads.interactions.list").length;
      const before = [reads(), notifications()];
      await idle("I made some changes.");
      pending = [question];
      await host.harness.behavior.emitThreadEvent("interaction.pending", { thread: makeThreadResponse({ id: "thr_1", status: "active" }), interaction: question as never });
      expect([reads(), notifications()]).toEqual(before);
      expect(await roster()).toMatchObject({ status: "failed", waitingKind: null });
      expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    });

    it("unarchives the threads and restores the workspace when a step of a done task runs again", async () => {
      await intakeOnce();
      const { id } = await roster();
      await markDone();
      expect([...archivedNow]).toEqual(["thr_1"]);
      workspaceRemoved = true;
      await host.harness.behavior.callRpc("cos_item_action", { id, action: "rerun_step", step: "build" });
      await settleJobs();
      expect(host.harness.inspection.sdk.callsTo("threads.unarchive")).toEqual([[{ threadId: "thr_1" }]]);
      expect(host.harness.inspection.sdk.callsTo("threads.restoreEnvironment")).toEqual([[{ threadId: "thr_1" }]]);
      expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
      await sweep();
      expect(await roster()).toMatchObject({ status: "running", detail: "agent", current: ["Build"], lastError: null });
    });

    it("keeps the threads when archiving is turned off", async () => {
      await host.harness.behavior.setSettings({ archiveThreadsOnDone: false });
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await markDone();
      expect(await roster()).toMatchObject({ status: "done" });
      expect(archivedIds).toEqual([]);
    });

    it("archives the threads of a failed task marked done", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_1", status: "error" }), error: "provider crashed" } as never);
      expect((await roster()).detail).toBe("failed");
      await markDone();
      expect(await roster()).toMatchObject({ status: "done", current: [] });
      expect(archivedIds).toEqual(["thr_1"]);
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
    expect(await roster()).toMatchObject({ detail: "done" });
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

  describe("an agent that finished while Chief of Staff missed it (earheart#349)", () => {
    it("runs items whose workflow snapshot predates newer step fields", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      // The item started on a plugin version without model choices: its stored steps lack `chooses`.
      const db = host.bb.storage.database();
      const row = db.prepare("SELECT id, workflow_json FROM work_items").get() as { id: string; workflow_json: string };
      const wf = JSON.parse(row.workflow_json) as { steps: Record<string, unknown>[] };
      for (const step of wf.steps) delete step.chooses;
      db.prepare("UPDATE work_items SET workflow_json = ? WHERE id = ?").run(JSON.stringify(wf), row.id);

      await idle("I made some changes.");
      expect(sentTexts()[0]).toContain("without reporting the step **Build**");
      await report("build");
      await idle();
      expect(ranChecks()).toBe(1);
      expect(await roster()).toMatchObject({ detail: "done", lastError: null });
    });

    it("runs items whose stored steps no longer pass validation", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      const db = host.bb.storage.database();
      const row = db.prepare("SELECT id, workflow_json FROM work_items").get() as { id: string; workflow_json: string };
      const wf = JSON.parse(row.workflow_json) as { steps: Record<string, unknown>[] };
      for (const step of wf.steps) {
        delete step.chooses;
        step.instructions = "x".repeat(20_001); // over today's limit
      }
      db.prepare("UPDATE work_items SET workflow_json = ? WHERE id = ?").run(JSON.stringify(wf), row.id);

      const loaded = new StateStore(db).getWorkItem(row.id)!;
      expect(loaded.workflow.steps.find((s) => s.type === "agent")).toMatchObject({ chooses: [], next: expect.any(Array) });
      await report("build");
      await idle();
      expect(ranChecks()).toBe(1);
      expect(await roster()).toMatchObject({ detail: "done", lastError: null });
    });

    it("keeps the agent's report when handling its turn end fails, says so, and moves on at the next sweep", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build");
      engine.failNext = "turn_ended";
      await idle().catch(() => undefined);
      expect(ranChecks()).toBe(0);
      const stuck = await roster();
      expect(stuck).toMatchObject({ current: ["Build"] });
      expect(stuck.lastError).toContain("could not handle turn_ended");
      expect(stuck.lastError).toContain("reading 'length'");
      const alerts = () => JSON.stringify(host.harness.inspection.sdk.callsTo("plugins.callRpc")).split("Chief of Staff needs help").length - 1;
      expect(alerts()).toBe(1);

      const engineLog = new StateStore(host.bb.storage.database()).listLog({ workItemId: stuck.id }).find((e) => e.kind === "engine");
      expect(engineLog?.message).toMatch(/reading 'length'\)\n.*TypeError[\s\S]*\n\s+at /);

      await sweep();
      expect(ranChecks()).toBe(1);
      expect(sentTexts()).toHaveLength(0); // the report was kept: no nudge
      // Handled now: the error must not stay on the card.
      expect(await roster()).toMatchObject({ detail: "done", lastError: null });
    });

    it("reads a turn end again when it was marked handled but the step never moved", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await host.harness.behavior.callRpc("cos_intake_now", {});
        await report("build");
        // The idle was recorded as handled, yet nothing acted on it (a crash, a reload).
        const finishedAt = Date.now() + 1000;
        threadUpdatedAt = finishedAt;
        new StateStore(host.bb.storage.database()).updateThread("thr_1", { idleSeenAt: finishedAt });

        vi.setSystemTime(finishedAt + 60_000);
        await sweep();
        expect(ranChecks()).toBe(0); // a turn end may still be on its way

        vi.setSystemTime(finishedAt + SETTLED_IDLE_MS + 1000);
        await sweep();
        expect(ranChecks()).toBe(1);
        expect(sentTexts()).toHaveLength(0);
        expect(await roster()).toMatchObject({ detail: "done" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("nudges an idle agent that never reported instead of calling it stalled", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await host.harness.behavior.callRpc("cos_intake_now", {});
        const finishedAt = Date.now() + 1000;
        threadUpdatedAt = finishedAt;
        new StateStore(host.bb.storage.database()).updateThread("thr_1", { idleSeenAt: finishedAt });
        // Past the 30-minute stall threshold, the agent's thread idle the whole time.
        vi.setSystemTime(finishedAt + 31 * 60_000);
        await sweep();
        const entry = await roster();
        expect(entry.detail).not.toBe("blocked");
        expect(entry.waitingKind).toBeNull();
        expect(sentTexts()).toHaveLength(1);
        expect(sentTexts()[0]).toContain("without reporting the step **Build**");
      } finally {
        vi.useRealTimers();
      }
    });

    it("hands a step to a human when its agent stays idle and nothing moves it on", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await host.harness.behavior.callRpc("cos_intake_now", {});
        const finishedAt = Date.now() + 1000;
        threadUpdatedAt = finishedAt;
        // State sync cannot act on (the thread row is for another round), so only the stall check can.
        host.bb.storage.database().prepare("UPDATE item_threads SET round = 99").run();
        vi.setSystemTime(finishedAt + 31 * 60_000);
        await sweep();
        const entry = await roster();
        expect(entry).toMatchObject({ waitingKind: "stalled" });
        expect(entry.waitingReason).toContain("turn ended, but Chief of Staff could not move the step on");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("accepts a Stage report block from agents without the tool", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await idle("All set.\n\n## Stage report\nstage: build\noutcome: done\nsummary: Fixed login via text report");
    expect(ranChecks()).toBe(1);
    const pr = ghCalls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls")!.body as { body: string };
    expect(pr.body).toContain("Fixed login via text report");
  });

  it("redacts the token from check output, and serves long history details in full on request", async () => {
    checkExit = 1;
    checkLeak = `\nAuthorization: token ghp_secret_token\n${"x".repeat(1_000)}\nlast line`;
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build");
    await idle();
    expect(sentTexts()[0]).not.toContain("ghp_secret_token");
    expect(sentTexts()[0]).toContain("<redacted>");
    type View = { journal: { id: number; kind: string; detail: string | null; truncated?: boolean }[] };
    const { id } = await roster();
    const view = await host.harness.behavior.callRpc("cos_item_workflow", { id }) as View;
    expect(JSON.stringify(view)).not.toContain("ghp_secret_token");
    const failed = view.journal.find((e) => e.kind === "failed")!;
    expect(failed).toMatchObject({ truncated: true });
    expect(failed.detail!.length).toBeLessThan(700);
    expect(failed.detail!.trimEnd().endsWith("last line")).toBe(true);
    const full = await host.harness.behavior.callRpc("cos_journal_detail", { itemId: id, id: failed.id }) as { detail: string };
    expect(full.detail).toContain("1 failing");
    expect(full.detail).toContain("<redacted>");
    expect(await host.harness.behavior.callRpc("cos_journal_detail", { itemId: "another", id: failed.id })).toEqual({ detail: null });
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
    expect(await roster()).toMatchObject({ detail: "done" });
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
    expect(await roster()).toMatchObject({ detail: "done" });
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
      expect(await roster()).toMatchObject({ detail: "done", waitingReason: null });
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
    expect(entry.detail).toBe("done");
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
    expect(await roster()).toMatchObject({ detail: "done" });
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
    await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge", maxCiFixes: 1 } } }) });
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

  it("shows the steps a finished task left running or waiting as stopped, without rewriting them", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0]!;
    type Step = { id: string; status: string; phase: string | null; retrying: boolean; waitingKind: string | null };
    const steps = async () => ((await roster()) as unknown as { steps: Step[] }).steps;
    // Active: live states pass through untouched.
    expect((await steps()).find((st) => st.id === "build")).toMatchObject({ status: "running" });
    const nodes = {
      ...item.nodes,
      build: { ...item.nodes.build!, status: "waiting" as const, waiting: { kind: "question" as const, reason: "Which login?" } },
      ship: { ...item.nodes.ship!, status: "running" as const, phase: "ci" as const, retry: { effect: { type: "merge", step: "ship" }, at: new Date().toISOString(), count: 1 } },
    } as typeof item.nodes;
    store.updateWorkItem(item.id, { status: "failed", lastError: "thread archived", finishedAt: new Date().toISOString(), nodes, waitingReason: "Build: Which login?" });
    const settled = { status: "stopped", phase: null, retrying: false, waitingKind: null };
    expect(await roster()).toMatchObject({ current: [], outcome: "failed", activity: "Failed: thread archived" });
    expect((await steps()).find((st) => st.id === "ship")).toMatchObject(settled);
    expect((await steps()).find((st) => st.id === "build")).toMatchObject(settled);
    const view = await host.harness.behavior.callRpc("cos_item_workflow", { id: item.id }) as { live: Record<string, Step>; task: { waitingReason: string | null }; steps: Record<string, { waitingReason: string | null }> };
    // Nobody is waiting on a finished task: no "needs you" callouts in the sheet.
    expect(view.task.waitingReason).toBeNull();
    expect(view.steps.build!.waitingReason).toBeNull();
    expect(view.live.ship).toMatchObject(settled);
    expect(view.live.build).toMatchObject(settled);
    // Pending steps never ran: they stay pending.
    expect(Object.values(view.live).map((l) => l.status)).not.toContain("running");
    const stored = store.getWorkItem(item.id)!.nodes;
    expect(stored.ship).toMatchObject({ status: "running", phase: "ci" });
    expect(stored.build).toMatchObject({ status: "waiting" });
  });

  it("says a task marked done by hand ended that way, and when", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const before = await roster();
    expect(before).toMatchObject({ outcome: null, finishedAt: null });
    await host.harness.behavior.callRpc("cos_item_action", { id: before.id, action: "mark_done" });
    expect(await roster()).toMatchObject({ detail: "done", outcome: "marked_done", finishedAt: expect.any(String), activity: "Marked done" });
  });

  it("reads a task marked failed by hand, even with an error stored", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const { id } = await roster();
    new StateStore(host.bb.storage.database()).updateWorkItem(id, { lastError: "push rejected" });
    await host.harness.behavior.callRpc("cos_item_action", { id, action: "mark_failed" });
    // Mark failed stores MARKED_FAILED over the earlier error (#146), so the activity is the label alone.
    expect(await roster()).toMatchObject({ detail: "failed", outcome: "marked_failed", lastError: "Marked failed", activity: "Marked failed" });
  });

  it.each([
    { phase: "ci", merged: false, state: "open", expected: "done" },
    { phase: "ready", merged: true, state: "closed", expected: "done" },
    { phase: "ready", merged: false, state: "closed", expected: "failed" },
  ] as const)("reconciles a stored PR-only item: $phase / $state / merged=$merged", async ({ phase, merged, state, expected }) => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build"); await idle();
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    store.updateWorkItem(item.id, { status: phase, finishedAt: null, nodes: { ...item.nodes, ship: { ...item.nodes.ship!, status: "running", phase } } });
    currentPull = { ...currentPull, merged, state };
    host = await host.harness.lifecycle.reload(plugin);
    await host.harness.behavior.runService("cos-reconcile").done;
    await settleJobs();
    expect(await roster()).toMatchObject({ detail: expected, prNumber: 7, occupiesCapacity: false });
    if (expected === "failed") expect((await roster()).lastError).toBe("PR closed without merge");
    // CI watching records what it saw on its merged and closed exits.
    if (state === "closed") expect(new StateStore(host.bb.storage.database()).getWorkItem(item.id)!.prState).toMatchObject({ number: 7, state: merged ? "merged" : "closed" });
    expect(await roster()).toMatchObject({ outcome: expected === "failed" ? "pr_closed" : "pr_opened", finishedAt: expect.any(String) });
    expect(ghCalls.filter((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toHaveLength(1);
    const count = archivedIds.length;
    await host.harness.behavior.runService("cos-reconcile").done;
    expect(archivedIds).toHaveLength(count);
  });

  it("does not confirm PR-only completion when GitHub is unavailable", async () => {
    await host.harness.behavior.callRpc("cos_intake_now", {});
    await report("build"); await idle();
    const store = new StateStore(host.bb.storage.database());
    const item = store.listWorkItems()[0];
    store.updateWorkItem(item.id, { status: "ready", finishedAt: null, nodes: { ...item.nodes, ship: { ...item.nodes.ship!, status: "running", phase: "ready" } } });
    archivedNow.clear(); // A task still waiting on its PR has live threads.
    ghRoutes["GET /repos/acme/app/pulls/7"] = () => ({ status: 503 });
    host = await host.harness.lifecycle.reload(plugin);
    await host.harness.behavior.runService("cos-reconcile").done;
    expect(await roster()).toMatchObject({ detail: "ready", occupiesCapacity: false });
    ghRoutes["GET /repos/acme/app/pulls/7"] = () => ({ body: currentPull });
    await sweep();
    expect(await roster()).toMatchObject({ detail: "done" });
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
    expect(byIssue(30)).toMatchObject({ detail: "done" });
    // A confirmed open PR finishes the converted PR-only workflow.
    expect(byIssue(31)).toMatchObject({ detail: "done", prNumber: 7 });
    expect(byIssue(31).steps.find((st) => st.id === "ship")).toMatchObject({ status: "done" });
    // Was waiting on a question: still waiting, same question.
    expect(byIssue(32)).toMatchObject({ detail: "waiting_on_human", waitingKind: "question", waitingReason: "Build: Question: which DB?" });
  });

  describe("provider usage limits (the Claude or Codex 5-hour window)", () => {
    const START = Date.parse("2026-11-06T10:00:00Z");
    const RESET = Date.parse("2026-11-06T12:30:00Z");
    const limitOf = (resetsAtMs: number) => ({
      errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null },
      rateLimits: { kind: "subscription-window", status: "blocked", providerId: "claude-code", overageReason: null, overageStatus: null, reachedReason: null, windows: [{ label: "5h", providerKey: null, resetsAtMs, status: "blocked" }] },
    });
    /** The thread's turn fails on the limit: BB announces thread.failed, then turn.failed. */
    const hitLimit = async (threadId: string, resetsAtMs = RESET, opts: { turnFailed?: boolean; eventsReadable?: boolean } = {}) => {
      if (opts.eventsReadable !== false) failures[threadId] = limitOf(resetsAtMs);
      perThread[threadId] = { status: "error", updatedAt: Date.now() };
      await host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: threadId, status: "error" }), error: "Claude usage limit reached" } as never);
      await settleJobs();
      if (opts.turnFailed !== false) {
        await host.harness.behavior.emitThreadEvent("turn.failed", { threadId, requestId: "req_1", turnId: null, inputAccepted: true, attemptNumber: 1, originPluginId: "chief-of-staff", ...limitOf(resetsAtMs) } as never);
        await settleJobs();
      }
    };
    /** BB's retry runs once the window resets: the thread works again. */
    const resumed = async (threadId: string) => {
      perThread[threadId] = { status: "active", updatedAt: Date.now() };
      delete failures[threadId];
      queuedRetry[threadId] = false;
      await sweep();
    };
    const at = (ms: number) => vi.setSystemTime(ms);

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      at(START);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits out the builder's limit and continues the same turn after the reset", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      const prompts = sent.length;
      await hitLimit("thr_1");
      expect(await roster()).toMatchObject({ detail: "retrying", actor: "system", current: ["Build"], lastError: null, activity: "Build: usage limit reached; continues after 12:30 UTC" });
      // One retry of the failed turn, shortly after the reset.
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ threadId: "thr_1", reason: expect.stringContaining("usage limit resets") });
      expect(retries[0]!.sendAt).toBeGreaterThanOrEqual(RESET + 15_000);
      expect(retries[0]!.sendAt).toBeLessThan(RESET + 60_000);

      // Hours of sweeps before the reset: not failed, not stalled, nothing re-sent.
      for (let t = START; t < RESET; t += 40 * 60_000) {
        at(t);
        await sweep();
        expect(await roster()).toMatchObject({ detail: "retrying", stalled: false });
      }
      expect(retries).toHaveLength(1);
      expect(sent.length).toBe(prompts);

      at(RESET + 60_000);
      await resumed("thr_1");
      expect(await roster()).toMatchObject({ detail: "agent", activity: "Build: agent working" });
      await report("build");
      await idle();
      expect(ranChecks()).toBe(1);
      expect(sent.length).toBe(prompts);
    });

    it("leaves the retry to BB when provider-retry already queued one", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      queuedRetry.thr_1 = true;
      await hitLimit("thr_1");
      expect(await roster()).toMatchObject({ detail: "retrying" });
      expect(retries).toEqual([]);
    });

    it("handles thread.failed and turn.failed arriving back to back once", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      failures.thr_1 = limitOf(RESET);
      perThread.thr_1 = { status: "error", updatedAt: Date.now() };
      await Promise.all([
        host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_1", status: "error" }), error: "Claude usage limit reached" } as never),
        host.harness.behavior.emitThreadEvent("turn.failed", { threadId: "thr_1", requestId: "req_1", turnId: null, inputAccepted: true, attemptNumber: 1, originPluginId: "chief-of-staff", ...limitOf(RESET) } as never),
      ]);
      await settleJobs();
      expect(await roster()).toMatchObject({ detail: "retrying" });
      expect(retries).toHaveLength(1);
      const store = new StateStore(host.bb.storage.database());
      expect(store.listLog({ limit: 50 }).filter((e) => e.kind === "usage_limit")).toHaveLength(1);
    });

    it("takes back a builder failure recorded before BB said it was a usage limit", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await hitLimit("thr_1", RESET, { eventsReadable: false });
      expect(await roster()).toMatchObject({ detail: "retrying", lastError: null, activity: "Build: usage limit reached; continues after 12:30 UTC" });
      expect(retries).toHaveLength(1);
    });

    it("waits out a step thread's limit and takes the report of the retried turn", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false } } }) });
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build");
      await idle();
      expect(await roster()).toMatchObject({ current: ["Review"], detail: "agent" });
      await hitLimit("thr_review");
      expect(await roster()).toMatchObject({ current: ["Review"], detail: "retrying", waitingKind: null, activity: "Review: usage limit reached; continues after 12:30 UTC" });
      at(RESET + 60_000);
      await resumed("thr_review");
      expect(await roster()).toMatchObject({ current: ["Review"], detail: "agent" });
      await report("review", "done", "Looks good", "thr_review");
      await idle("Looks good", "thr_review");
      expect((await roster()).current).not.toContain("Review");
    });

    it("hands a limit that resets days away to a person, as before", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await hitLimit("thr_1", START + 3 * 24 * 60 * 60_000);
      expect(await roster()).toMatchObject({ detail: "failed", lastError: "Claude usage limit reached" });
      expect(retries).toEqual([]);
    });

    it("retries itself when nobody did, and hands the step to a person when the limit does not lift", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await hitLimit("thr_1");
      // The scheduled retry was lost (deleted from the queue): Chief of Staff asks again after the reset.
      queuedRetry.thr_1 = false;
      at(RESET + 10 * 60_000 + 30_000);
      await sweep();
      expect(retries).toHaveLength(2);
      expect(retries[1]!.sendAt).toBeUndefined();
      expect(await roster()).toMatchObject({ detail: "retrying" });
      // Still failing two hours on: a person decides.
      queuedRetry.thr_1 = false;
      at(RESET + 2 * 60 * 60_000 + 60_000);
      await sweep();
      expect(await roster()).toMatchObject({ detail: "failed", lastError: expect.stringContaining("usage limit did not lift") });
    });

    it("does not give up while BB's retry is still scheduled for later", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await hitLimit("thr_1");
      queuedRetry.thr_1 = RESET + 3 * 60 * 60_000; // e.g. an account pool's later retry time
      at(RESET + 2 * 60 * 60_000 + 60_000);
      await sweep();
      expect(await roster()).toMatchObject({ detail: "retrying" });
      at(RESET + 3 * 60 * 60_000 + 60_000);
      await sweep();
      expect(await roster()).toMatchObject({ detail: "failed", lastError: expect.stringContaining("usage limit did not lift") });
    });

    it("lifts the wait when the thread is idle again after the reset", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await hitLimit("thr_1");
      at(RESET + 11 * 60_000);
      delete failures.thr_1;
      perThread.thr_1 = { status: "idle", updatedAt: Date.now() };
      await sweep();
      expect((await roster()).detail).not.toBe("retrying");
    });

    it("does not read a parked step thread's events on every sweep", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false } } }) });
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build");
      await idle();
      perThread.thr_review = { status: "error", updatedAt: Date.now() };
      await host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_review", status: "error" }), error: "provider crashed" } as never);
      await settleJobs();
      expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingKind: "cos_error" });
      const reads = () => host.harness.inspection.sdk.callsTo("threads.events.list").filter((c) => (c[0] as { types?: string[] }).types?.includes("provider/error")).length;
      const before = reads();
      await sweep();
      expect(reads()).toBe(before);
    });

    it("keeps a step thread whose limit did not lift with the person on later sweeps", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false } } }) });
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build");
      await idle();
      await hitLimit("thr_review");
      queuedRetry.thr_review = true; // BB's retry stays queued but the thread never recovers
      at(RESET + 2 * 60 * 60_000 + 60_000);
      await sweep();
      const parked = await roster();
      expect(parked).toMatchObject({ detail: "waiting_on_human", waitingKind: "cos_error", current: ["Review"] });
      expect(parked.waitingReason).toContain("usage limit did not lift");
      for (let i = 1; i <= 3; i++) {
        at(RESET + 2 * 60 * 60_000 + 60_000 + i * 60_000);
        await sweep();
        expect(await roster()).toMatchObject({ detail: "waiting_on_human", waitingKind: "cos_error" });
      }
    });
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
    const tool = await host.harness.behavior.callAgentTool("cos_start_task", { repo: "acme/app", description: "Do more" }, { threadId: "thr_parent" });
    expect(JSON.stringify(tool)).toContain("Do more");
  });

  it("starts from a prompt alone and preserves its full text", async () => {
    const body = "Fix login errors.\n" + "Keep the context. ".repeat(20);
    await host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", body });
    expect(await roster()).toMatchObject({ issueTitle: body.replace(/\s+/g, " ").slice(0, 200) });
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
    expect(spawn.prompt).toContain(body.trim());
  });

  it("starts a task from a CLI prompt alone", async () => {
    const result = await host.harness.behavior.runCli(["task", "Fix login errors", "--repo", "acme/app"]);
    expect(result.exitCode).toBe(0);
    expect(await roster()).toMatchObject({ issueTitle: "Fix login errors" });
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
    expect(spawn.prompt).toContain("Fix login errors");
  });

  it("rejects an empty prompt without starting work", async () => {
    await expect(host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", body: "  \n " })).rejects.toThrow(/needs a prompt/);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("starts a described task through the configured workflow with intake disabled and no issue", async () => {
    const paused = JSON.parse(repos);
    paused.repos[0].allow.intake = false;
    await host.harness.behavior.setSettings({ repos: JSON.stringify(paused) });
    const started = await host.harness.behavior.callRpc("cos_start_task", { repo: "acme/app", title: "Improve login", body: "Explain errors" }) as { id: string; workflow: string };
    expect(started.workflow).toBe("acme/app (converted)");
    const entry = await roster();
    expect(entry).toMatchObject({ id: started.id, issueNumber: null, issueUrl: null, current: ["Build"] });
    const spawn = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
    expect(spawn.prompt).toContain("Explain errors");
    expect(ghCalls.some((call) => call.path === "/repos/acme/app/issues")).toBe(false);
    // The activity log names the task each row belongs to: here a standalone task, by its title alone.
    const log = (await host.harness.behavior.callRpc("cos_log", { workItemId: started.id })) as { entries: { workItemId: string; issueNumber: number | null; issueTitle: string | null }[] };
    expect(log.entries.length).toBeGreaterThan(0);
    for (const e of log.entries) expect(e).toMatchObject({ workItemId: started.id, issueNumber: null, issueTitle: "Improve login" });
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

  it("lists an active task older than 250 finished ones, with or without finished, and pages the rest (#106)", async () => {
    const db = host.bb.storage.database();
    const insert = db.prepare(
      `INSERT INTO work_items (id, repo, issue_number, issue_title, thread_id, pr_number, pr_url, status, source, created_at, updated_at, finished_at, waiting_kind, waiting_reason)
       VALUES (@id, 'acme/app', @issue, @title, @thread, @pr, @prUrl, @status, 'task', @created, @created, @finished, @kind, @reason)`,
    );
    const base = Date.parse("2026-01-01T00:00:00Z");
    const iso = (ms: number) => new Date(base + ms).toISOString();
    insert.run({ id: "old-active", issue: 1, title: "Old approval", thread: "thr_old", pr: 99, prUrl: "https://github.com/acme/app/pull/99", status: "waiting_on_human", created: iso(0), finished: null, kind: "approval", reason: "Approve the plan" });
    for (let i = 1; i <= 250; i++) insert.run({ id: `done-${i}`, issue: 1000 + i, title: `Done ${i}`, thread: `thr_done_${i}`, pr: null, prUrl: null, status: i % 7 ? "done" : "failed", created: iso(i * 60_000), finished: iso(i * 60_000 + 1_000), kind: null, reason: null });
    type Page = { entries: { id: string; detail: string; prNumber: number | null }[]; nextBefore: string | null };
    const roster = async (input: Record<string, unknown>) => (await host.harness.behavior.callRpc("cos_roster", input)) as Page;

    const activeOnly = await roster({});
    expect(activeOnly.entries.map((e) => e.id)).toEqual(["old-active"]);
    expect(activeOnly.nextBefore).toBeNull();

    threadListCalls.length = 0;
    const first = await roster({ includeDone: true });
    // Active first, then the 50 most recently finished.
    expect(first.entries[0]).toMatchObject({ id: "old-active", prNumber: 99 });
    expect(first.entries.slice(1).map((e) => e.id)).toEqual(Array.from({ length: 50 }, (_, k) => `done-${250 - k}`));
    expect(first.nextBefore).toEqual(expect.any(String));
    expect(threadListCalls[0]?.[0]).toBe("thr_old");

    const seen = first.entries.slice(1).map((e) => e.id);
    let before = first.nextBefore;
    while (before) {
      const page = await roster({ includeDone: true, before });
      expect(page.entries.every((e) => e.detail === "done" || e.detail === "failed")).toBe(true);
      seen.push(...page.entries.map((e) => e.id));
      before = page.nextBefore;
    }
    expect(seen).toEqual(Array.from({ length: 250 }, (_, k) => `done-${250 - k}`));

    // A large page looks every thread up, 200 ids per call, active ones first.
    threadListCalls.length = 0;
    const big = await roster({ includeDone: true, finishedLimit: 300 });
    expect(big.entries).toHaveLength(251);
    expect(big.nextBefore).toBeNull();
    expect(threadListCalls.map((ids) => ids?.length)).toEqual([200, 51]);
    expect(threadListCalls[0]?.[0]).toBe("thr_old");

    // The agent tool and the CLI page the same way.
    const tool = await host.harness.behavior.callAgentTool("chief_of_staff_status", { includeDone: true, finishedLimit: 2 });
    const text = typeof tool === "string" ? tool : tool.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("Old approval");
    expect(text).toMatch(/more finished: before=\S+/);
    const json = JSON.parse((await host.harness.behavior.runCli(["status", "--all", "--finished-limit", "2", "--json"])).stdout) as Page;
    expect(json.entries.map((e) => e.id)).toEqual(["old-active", "done-250", "done-249"]);
    expect(json.nextBefore).toEqual(expect.any(String));
    // A page larger than the text output limit is still whole, parseable JSON with its cursor.
    const bigJson = (await host.harness.behavior.runCli(["status", "--all", "--finished-limit", "200", "--json"])).stdout;
    expect(bigJson.length).toBeGreaterThan(60_000);
    const parsed = JSON.parse(bigJson) as Page;
    expect(parsed.entries).toHaveLength(201);
    expect(parsed.nextBefore).toEqual(expect.any(String));
    const next = await host.harness.behavior.runCli(["status", "--before", json.nextBefore!, "--finished-limit", "2"]);
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain("acme/app#1248");
    expect(next.stdout).not.toContain("acme/app#1 ");
    expect(next.stdout).toMatch(/More finished: bb cos status --all --finished-limit 2 --before \S+/);
    const text2 = (await host.harness.behavior.runCli(["status", "--all"])).stdout;
    expect(text2).toMatch(/More finished: bb cos status --all --before \S+/);
    // The next-page command keeps the flags that shape the page.
    const withFlags = (await host.harness.behavior.runCli(["status", "--all", "--repo", "acme/app", "--usage"])).stdout;
    expect(withFlags).toMatch(/More finished: bb cos status --all --repo acme\/app --usage --before \S+/);
    expect((await host.harness.behavior.runCli(["status"])).stdout).not.toContain("More finished");
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

  describe("GitHub rate limits", () => {
    const T0 = Date.parse("2026-11-06T10:00:00Z");
    const at = (minutes: number) => vi.setSystemTime(T0 + minutes * 60_000);
    const limited = { status: 429, headers: { "retry-after": "600" }, body: { message: "API rate limit exceeded" } };
    const itemNodes = () => new StateStore(host.bb.storage.database()).listWorkItems()[0]!.nodes;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      at(0);
    });
    afterEach(() => vi.useRealTimers());

    it("opens the PR after the reset without using up a retry or asking a person", async () => {
      let refuse = true;
      ghRoutes["POST /repos/acme/app/pulls"] = () => {
        if (refuse) { refuse = false; return limited; }
        prCreated = true;
        return { status: 201, body: currentPull };
      };
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build");
      await idle();
      expect(itemNodes().ship!.retry).toMatchObject({ count: 0, at: "2026-11-06T10:10:00.000Z" });
      expect(await roster()).toMatchObject({ detail: "retrying", waitingKind: null });
      at(5);
      await sweep();
      const posts = () => ghCalls.filter((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls").length;
      expect(posts()).toBe(1);
      at(10);
      await sweep();
      expect(posts()).toBe(2);
      expect(await roster()).toMatchObject({ detail: "done", prNumber: 7, waitingKind: null });
    });

    it("defers a spawn whose issue cannot be read rather than brief the agent without it", async () => {
      let refuse = true;
      ghRoutes["GET /repos/acme/app/issues/12"] = () => {
        if (refuse) { refuse = false; return limited; }
        return { body: issue };
      };
      await host.harness.behavior.callRpc("cos_intake_now", {});
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
      expect(itemNodes().build!.agentRetries?.[0]).toMatchObject({ count: 0, at: "2026-11-06T10:10:00.000Z" });
      expect(await roster()).toMatchObject({ detail: "retrying", waitingKind: null });
      at(10);
      await sweep();
      const spawns = host.harness.inspection.sdk.callsTo("threads.spawn");
      expect(spawns).toHaveLength(1);
      expect((spawns[0]![0] as { prompt: string }).prompt).toContain("Login breaks");
    });

    it("still records the environment branch when the spawn's issue comment is refused", async () => {
      ghRoutes["POST /repos/acme/app/issues/12/comments"] = () => limited;
      host.harness.inspection.sdk.stub("environments.get", async () => ({ id: "env_1", hostId: "host_1", path: "/work/app/.bb/wt-1", branchName: "bb/fix-login-thr_1", status: "ready" }) as never);
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await vi.waitFor(() => expect(new StateStore(host.bb.storage.database()).listWorkItems()[0]!.branch).toBe("bb/fix-login-thr_1"));
      expect(itemNodes().build!).toMatchObject({ status: "running", retry: null });
      expect(await roster()).toMatchObject({ detail: "agent" });
    });

    it("skips GitHub work in the sweep while limited, keeps syncing threads, and resumes after the reset", async () => {
      await host.harness.behavior.callRpc("cos_intake_now", {});
      ghRoutes["GET /repos/acme/app/issues"] = () => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((T0 + 30 * 60_000) / 1000) }, body: { message: "API rate limit exceeded" } });
      await sweep();
      const kv = host.bb.storage.kv;
      expect(await kv.get("sweep:lastIntakeAt")).toBe("2026-11-06T10:00:00.000Z");
      // Intake hit the limit, so CI polling was not stamped either.
      expect(await kv.get("sweep:lastCiAt")).toBeUndefined();
      expect((await host.harness.behavior.runCli(["log", "--limit", "20"])).stdout).toContain("GitHub API rate limit reached; GitHub work paused until 2026-11-06T10:30:00.000Z");

      ghCalls.length = 0;
      const listed = host.harness.inspection.sdk.callsTo("threads.list").length;
      at(11);
      await sweep();
      expect(ghCalls).toEqual([]);
      expect(await kv.get("sweep:lastIntakeAt")).toBe("2026-11-06T10:00:00.000Z");
      expect(await kv.get("sweep:lastCiAt")).toBeUndefined();
      expect(host.harness.inspection.sdk.callsTo("threads.list").length).toBeGreaterThan(listed);

      // The overview and `cos status` say so, with the reset time.
      const warning = "GitHub API rate limit reached: intake, CI polling and GitHub steps resume at 10:30 UTC (in 19 min).";
      const overview = async () => ((await host.harness.behavior.callRpc("cos_overview", null)) as { warnings: string[] }).warnings;
      expect(await overview()).toContain(warning);
      expect((await host.harness.behavior.runCli(["status"])).stdout).toContain(`warning: ${warning}`);
      expect(JSON.parse((await host.harness.behavior.runCli(["status", "--json"])).stdout).warnings).toContain(warning);

      ghRoutes["GET /repos/acme/app/issues"] = () => ({ body: [issue] });
      at(30);
      expect((await overview()).filter((w) => w.includes("rate limit"))).toEqual([]);
      await sweep();
      expect(ghCalls.some((c) => c.path === "/repos/acme/app/issues")).toBe(true);
      expect(await kv.get("sweep:lastIntakeAt")).toBe("2026-11-06T10:30:00.000Z");
      expect(await kv.get("sweep:lastCiAt")).toBe("2026-11-06T10:30:00.000Z");
    });

    it("stops intake between issues at the time budget and still syncs threads in the same sweep", async () => {
      const issue13 = { ...issue, number: 13, title: "Fix logout", html_url: "https://github.com/acme/app/issues/13" };
      ghRoutes["GET /repos/acme/app/issues"] = () => ({ body: [issue, issue13] });
      ghRoutes["GET /repos/acme/app/issues/13"] = () => ({ body: issue13 });
      ghRoutes["GET /repos/acme/app/issues/13/comments"] = () => ({ body: [] });
      ghRoutes["POST /repos/acme/app/issues/13/comments"] = () => ({ status: 201, body: { id: 3, body: "", user: null, created_at: "" } });
      // Looking for an open PR for the first issue is slow: the budget runs out during it.
      ghRoutes["GET /repos/acme/app/pulls"] = () => {
        vi.setSystemTime(Date.now() + 3 * 60_000);
        return { body: openPulls };
      };
      await sweep();
      const items = new StateStore(host.bb.storage.database()).listWorkItems();
      // The issue in hand finished starting; the next one waits for a later sweep.
      expect(items.map((i) => [i.issueNumber, i.status])).toEqual([[12, "agent"]]);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
      expect(await host.bb.storage.kv.get("sweep:lastCiAt")).toBeUndefined();
      expect(host.harness.inspection.sdk.callsTo("threads.list").length).toBeGreaterThan(0);
    });

    it("does not react to failing CI until the logs can be downloaded", async () => {
      await host.harness.behavior.setSettings({ workflow: JSON.stringify({ workflow: { plan: { enabled: false }, review: { enabled: false }, ship: { action: "merge" } } }) });
      ghRoutes["GET /repos/acme/app/commits/abc/check-runs"] = () => ({ body: { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/app/actions/runs/99" }] } });
      ghRoutes["GET /repos/acme/app/actions/runs/99/jobs"] = () => ({ body: { jobs: [{ id: 5, name: "test", conclusion: "failure" }] } });
      let refuse = true;
      ghRoutes["GET /repos/acme/app/actions/jobs/5/logs"] = () => {
        if (refuse) { refuse = false; return limited; }
        return { text: "AssertionError: expected 1 to be 2" };
      };
      await host.harness.behavior.callRpc("cos_intake_now", {});
      await report("build");
      await idle();
      expect(await roster()).toMatchObject({ detail: "ci" });
      await sweep();
      const id = (await roster()).id;
      expect(await roster()).toMatchObject({ detail: "ci" });
      expect(await host.bb.storage.kv.get(`ci-failed:${id}`)).toBeUndefined();
      at(10);
      await sweep();
      expect(await roster()).toMatchObject({ current: ["Build"] });
      expect(itemNodes().build!.feedback).toContain("AssertionError");
    });
  });

  it("quotes the newest maintainer comments of a long issue in the brief", async () => {
    ghRoutes["GET /repos/acme/app/issues/12/comments"] = (url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      const base = "https://api.github.com/repos/acme/app/issues/12/comments?per_page=100";
      const ids = Array.from({ length: page === 3 ? 50 : 100 }, (_, i) => (page - 1) * 100 + i + 1);
      // The newest five come from outsiders and must not push maintainers' comments out.
      return { body: ids.map((id) => ({ id, body: `comment ${id}`, user: { login: "dan" }, created_at: "", author_association: id > 245 ? "NONE" : "MEMBER" })), headers: page < 3 ? { link: `<${base}&page=${page + 1}>; rel="next", <${base}&page=3>; rel="last"` } : ({} as Record<string, string>) };
    };
    await host.harness.behavior.callRpc("cos_intake_now", {});
    const { prompt } = host.harness.inspection.sdk.callsTo("threads.spawn")[0][0] as { prompt: string };
    expect(prompt).toContain("comment 236");
    expect(prompt).toContain("comment 245");
    expect(prompt).not.toContain("comment 235");
    expect(prompt).not.toContain("comment 246");
    expect(prompt).toContain("5 of the latest 100 comments were left out");
  });

  it("validates and stores the workflow from the configurator", async () => {
    await expect(host.harness.behavior.callRpc("cos_set_config", { workflow: JSON.stringify({ workflow: { ship: { action: "deploy" } } }) })).rejects.toThrow(/workflow/);
    await host.harness.behavior.callRpc("cos_set_config", { workflow: JSON.stringify({ workflow: { review: { mode: "self", instructions: "Check a11y" } } }) });
    const config = (await host.harness.behavior.callRpc("cos_get_config", null)) as { workflow: string };
    expect(JSON.parse(config.workflow).workflow.review).toEqual({ mode: "self", instructions: "Check a11y" });
  });

});
