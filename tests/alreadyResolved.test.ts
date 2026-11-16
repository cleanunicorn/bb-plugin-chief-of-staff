// A task already done on the default branch (Theralexis/canary#929): the agent
// reports "resolved" with evidence, Chief of Staff verifies it on GitHub, closes
// the issue and ends the task; unverified evidence waits on a person.
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrationsForDatabase, StateStore, type NewWorkItem, type WorkItem } from "../src/state";
import { ALREADY_RESOLVED, DEFAULT_POLICY, deriveStatus, freshNode, initialNodes, transition, type Effect, type MachineEvent, type StepReport } from "../src/machine";
import { applyTransition, DEFAULT_BRANCH_TTL_MS, defaultBranch, dispatch, settleJobs } from "../src/delivery";
import { finishedOutcome } from "../src/outcome";
import { parseResolvedBy, parseTextReport } from "../src/report";
import { checkEvidence, RESOLVED_MARKER } from "../src/resolve";
import { observeFailure, observeIdle, tickItems } from "../src/sync";
import { describeActivity } from "../src/roster";
import { resolveAgent, settingsFor, workflowSchema, type Workflow } from "../src/workflow";
import { nudgePrompt, stepPrompt } from "../src/prompts";
import { GitHubError } from "../src/github";
import type { Cos } from "../src/context";
import type { RepoConfig } from "../src/config";

const NOW = new Date("2026-11-16T10:00:00.000Z");
const flow = workflowSchema.parse({ id: "t", name: "Test", steps: [
  { id: "plan", name: "Plan", type: "agent", next: ["build"] },
  { id: "build", name: "Build", type: "agent", writes: true, next: ["ship"] },
  { id: "ship", name: "Ship", type: "ship", action: "pr", watchCi: true, onFail: "build" },
] });

function itemFor(workflow: Workflow, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w1", repo: "acme/app", issueNumber: 929, issueTitle: "Retry crashes", threadId: null, environmentId: null, branch: "cos/issue-929-retry",
    prNumber: null, prUrl: null, status: "queued", providerId: null, model: null, fixAttempts: 0, retryCount: 0, lastError: null, source: "intake",
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), lastActivityAt: null, finishedAt: null, waitingReason: null, waitingKind: null,
    jobStartedAt: null, taskBody: null, workflow, nodes: initialNodes(workflow), prState: null, ...over,
  };
}
function run(item: WorkItem, event: MachineEvent): [WorkItem, Effect[]] {
  const t = transition(item, event, DEFAULT_POLICY, NOW);
  return [{ ...item, ...applyTransition(item, t.nodes, t.patch) }, t.effects];
}
/** The default workflow's shape: Plan waits for approval. */
const gated = workflowSchema.parse({ ...flow, steps: flow.steps.map((s) => (s.id === "plan" ? { ...s, approval: true } : s)) });
const resolved = (by: StepReport["resolvedBy"] = { pr: 920 }): StepReport => ({ outcome: "resolved", summary: "#920 already added reload()", resolvedBy: by, at: NOW.toISOString(), via: "tool" });
const ended = (step: string, report: StepReport, item: WorkItem): MachineEvent => ({ type: "turn_ended", step, agent: 0, round: item.nodes[step]!.round, report, question: null });

describe("engine: a resolved report", () => {
  it("holds the step while Chief of Staff verifies, without taking the job slot", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const [after, fx] = run(started, ended("plan", resolved(), started));
    expect(fx).toEqual([{ type: "resolve", step: "plan" }]);
    expect(after.nodes.plan).toMatchObject({ status: "running", phase: "closing" });
    expect(after.status).toBe("cos");
    expect(after.jobStartedAt).toBeNull();
    expect(describeActivity(after)).toBe("Plan: closing as already resolved");
    // No approval gate and no stall while it is Chief of Staff's turn.
    expect(run(after, { type: "stalled", step: "plan", agent: 0 })[0].nodes.plan!.status).toBe("running");
  });

  it("verified: ends the task as Already resolved, leaving never-run steps pending and sending no Shipped notice", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const [verifying] = run(started, ended("plan", resolved(), started));
    const [done, fx] = run(verifying, { type: "resolve_result", step: "plan", ok: true, detail: "pull request #920 (merged into main). Closed issue #929." });
    expect(done).toMatchObject({ status: "done", lastError: ALREADY_RESOLVED, finishedAt: NOW.toISOString() });
    expect(done.nodes.plan!.status).toBe("done");
    expect(done.nodes.build!.status).toBe("pending");
    expect(done.nodes.ship!.status).toBe("pending");
    expect(fx).toEqual([{ type: "notify", title: "Already resolved: acme/app#929", body: "By pull request #920 (merged into main). Closed issue #929." }]);
    expect(finishedOutcome(done, null)).toBe("already_resolved");
    // A closed task ignores a late duplicate result.
    expect(run(done, { type: "resolve_result", step: "plan", ok: false, detail: "x" })[0]).toMatchObject({ status: "done" });
  });

  it("unverified: waits on a person; Approve continues the workflow, as if the step were done", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const [verifying] = run(started, ended("plan", resolved({ pr: 1 }), started));
    const [waiting] = run(verifying, { type: "resolve_result", step: "plan", ok: false, detail: "pull request #1 is not merged." });
    expect(waiting.nodes.plan).toMatchObject({ status: "waiting", phase: null, waiting: { kind: "escalation" } });
    expect(waiting.waitingReason).toContain("could not confirm it: pull request #1 is not merged.");
    const [approved, fx] = run(waiting, { type: "approve" });
    expect(approved.nodes.plan!.status).toBe("done");
    expect(approved.nodes.build!.status).toBe("running");
    expect(fx.some((e) => e.type === "agent" && e.step === "build")).toBe(true);
  });

  it("a GitHub error retries with backoff and never clears another job's slot", () => {
    const parallel = workflowSchema.parse({ id: "p", name: "P", steps: [
      { id: "build", name: "Build", type: "agent", writes: true, next: ["review", "test"] },
      { id: "review", name: "Review", type: "agent" },
      { id: "test", name: "Test", type: "check", command: "npm test" },
    ] });
    let [item] = run(itemFor(parallel), { type: "start" });
    [item] = run(item, ended("build", { outcome: "done", summary: "built", at: NOW.toISOString(), via: "tool" }, item));
    const checkToken = item.jobStartedAt;
    expect(checkToken).toBe(NOW.toISOString());
    [item] = run(item, ended("review", resolved({ commit: "28371b83" }), item));
    [item] = run(item, { type: "effect_error", step: "review", effect: { type: "resolve", step: "review" }, message: "GitHub 502" });
    expect(item.jobStartedAt).toBe(checkToken);
    expect(item.nodes.review!.retry?.at).toBeTruthy();
    expect(item.nodes.review!.phase).toBe("closing");
    // The sweep dispatches retry_due once the backoff is over.
    const [due, fx] = run(item, { type: "retry_due", step: "review" });
    expect(fx).toEqual([{ type: "resolve", step: "review" }]);
    expect(due.jobStartedAt).toBe(checkToken);
    expect(due.nodes.test!.status).toBe("running");
  });

  it("with an approval gate: verifies only, waits for approval, then verifies again and closes", () => {
    const [started] = run(itemFor(gated), { type: "start" });
    const [verifying, fx1] = run(started, ended("plan", resolved(), started));
    expect(fx1).toEqual([{ type: "resolve", step: "plan" }]);
    expect(verifying.nodes.plan!.phase).toBe("resolving");
    const [gate] = run(verifying, { type: "resolve_result", step: "plan", ok: true, detail: "pull request #920 (merged into main)." });
    expect(gate.nodes.plan).toMatchObject({ status: "waiting", phase: "resolving", waiting: { kind: "approval" } });
    expect(gate.waitingReason).toBe("Plan: Already resolved by pull request #920 (merged into main). Approve to close the issue and end the task, or send the agent back.");
    const [closing, fx2] = run(gate, { type: "approve" });
    expect(closing.nodes.plan).toMatchObject({ status: "running", phase: "closing" });
    expect(fx2).toEqual([{ type: "resolve", step: "plan" }]);
    expect(closing.nodes.build!.status).toBe("pending");
    const [done] = run(closing, { type: "resolve_result", step: "plan", ok: true, detail: "pull request #920 (merged into main). Closed issue #929." });
    expect(done).toMatchObject({ status: "done", lastError: ALREADY_RESOLVED });
  });

  it("with an approval gate: Revise sends the agent back instead of closing", () => {
    const [started] = run(itemFor(gated), { type: "start" });
    const [verifying] = run(started, ended("plan", resolved(), started));
    const [gate] = run(verifying, { type: "resolve_result", step: "plan", ok: true, detail: "pull request #920 (merged into main)." });
    const [revised, fx] = run(gate, { type: "revise", feedback: "#920 only fixed two of the three pages" });
    expect(revised.nodes.plan).toMatchObject({ status: "running", phase: null, round: 2 });
    expect(fx.some((e) => e.type === "agent" && e.step === "plan")).toBe(true);
    expect(fx.some((e) => e.type === "resolve")).toBe(false);
  });

  it("resume_resolve verifies again after a restart, and only steps still resolving", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const [verifying] = run(started, ended("plan", resolved(), started));
    expect(run(verifying, { type: "resume_resolve" })[1]).toEqual([{ type: "resolve", step: "plan" }]);
    expect(run(started, { type: "resume_resolve" })[1]).toEqual([]);
  });

  it("agents that disagree (one resolved, one failed) wait on a person; nothing is verified or closed", () => {
    const pair = workflowSchema.parse({ id: "r", name: "R", steps: [{ id: "review", name: "Review", type: "agent", agents: 2, verdict: true }] });
    let [item] = run(itemFor(pair), { type: "start" });
    [item] = run(item, ended("review", resolved(), item));
    const failing: StepReport = { outcome: "failed", summary: "reload() still drops the cache.", at: NOW.toISOString(), via: "tool" };
    const [after, fx] = run(item, { ...ended("review", failing, item), agent: 1 } as MachineEvent);
    expect(after.nodes.review).toMatchObject({ status: "waiting", phase: null, waiting: { kind: "escalation" } });
    expect(after.waitingReason).toContain("reload() still drops the cache.");
    expect(fx.some((e) => e.type === "resolve")).toBe(false);
    expect(after.status).not.toBe("done");
  });

  it("derives cos, not agent, for a step whose agents all reported resolved", () => {
    const [started] = run(itemFor(flow), { type: "start" });
    const [verifying] = run(started, ended("plan", resolved(), started));
    expect(deriveStatus({ status: "queued", workflow: flow }, verifying.nodes).status).toBe("cos");
  });
});

describe("reporting resolved", () => {
  it("parses a text report's evidence, in either spelling", () => {
    const text = ["Done already.", "## Step report", "step: plan", "outcome: already resolved", "resolved_pr: #920", "resolvedCommit: 28371B83", "summary: #920 fixed it"].join("\n");
    expect(parseTextReport(text, NOW.toISOString())).toMatchObject({ outcome: "resolved", resolvedBy: { pr: 920, commit: "28371b83" }, summary: "#920 fixed it" });
    // A template line left unfilled is no evidence, and a done report carries none.
    const done = ["## Step report", "step: plan", "outcome: done", "resolvedPr: <only with outcome resolved: the PR number>", "summary: ok"].join("\n");
    expect(parseTextReport(done, NOW.toISOString())!.resolvedBy).toBeUndefined();
  });

  it("reads PR numbers and URLs, and rejects what is not evidence", () => {
    expect(parseResolvedBy("https://github.com/acme/app/pull/920", null)).toEqual({ pr: 920 });
    expect(parseResolvedBy("#920 (merged into main)", null)).toEqual({ pr: 920 });
    expect(parseResolvedBy("the one before", null)).toBeNull();
    expect(parseResolvedBy(null, "not-a-sha")).toBeNull();
    expect(parseResolvedBy("#0", "")).toBeNull();
  });

  it("tells every agent how to report it, against the fetched default branch", () => {
    const item = itemFor(flow);
    const prompt = stepPrompt(item, flow.steps[0] as never, 0, { defaultBranch: "main", delivery: "d1" });
    expect(prompt).toContain('outcome: "resolved"');
    expect(prompt).toContain("`origin/main` after `git fetch`");
    expect(prompt).toContain("resolvedPr");
    expect(prompt).not.toContain("once a person approves");
    expect(stepPrompt(itemFor(gated), gated.steps[0] as never, 0, { defaultBranch: "main" })).toContain("once a person approves");
    // The Step report template stays as it was: the evidence lines are named in the sentence above it.
    expect(prompt).not.toMatch(/^resolvedPr: /m);
  });

  it("reminds an agent that stopped without reporting that resolved is an option", () => {
    expect(nudgePrompt(flow.steps[0] as never, "d1")).toContain('outcome: "resolved"');
  });
});

describe("checkEvidence", () => {
  const repo = { owner: "acme", repo: "app" } as RepoConfig;
  const pull = (over: object) => ({ merged: true, merged_at: "2026-11-16T09:38:10Z", base: { ref: "main" }, ...over });
  const gh = (over: { pull?: object | Error; ahead?: number | Error }) => ({
    getPull: async () => { if (over.pull instanceof Error) throw over.pull; return pull(over.pull ?? {}) as never; },
    compareCommits: async () => { if (over.ahead instanceof Error) throw over.ahead; return { status: over.ahead ? "diverged" : "behind", ahead_by: over.ahead ?? 0, behind_by: 3 }; },
  });

  it.each([
    ["a PR merged into the default branch", {}, { pr: 920 }, { ok: true, evidence: "pull request #920 (merged into main)" }],
    ["a PR not merged", { pull: { merged: false, merged_at: null } }, { pr: 920 }, { ok: false, reason: "pull request #920 is not merged." }],
    ["a PR merged elsewhere", { pull: { base: { ref: "release" } } }, { pr: 920 }, { ok: false, reason: "pull request #920 was merged into release, not main." }],
    ["a missing PR", { pull: new GitHubError("nope", 404, "/x") }, { pr: 9 }, { ok: false, reason: "pull request #9 was not found in acme/app." }],
    ["a commit on the default branch", {}, { commit: "28371b833aeb" }, { ok: true, evidence: "commit 28371b833aeb (on main)" }],
    ["a commit not on it", { ahead: 2 }, { commit: "abcdef1" }, { ok: false, reason: "commit abcdef1 is not on main (2 commit(s) ahead of it)." }],
    ["a missing PR with a commit to fall back on", { pull: new GitHubError("nope", 404, "/x") }, { pr: 9, commit: "abcdef1" }, { ok: true, evidence: "commit abcdef1 (on main)" }],
    ["no evidence", {}, null, { ok: false, reason: "the report names no merged pull request or commit." }],
  ])("%s", async (_, over, by, expected) => {
    expect(await checkEvidence(gh(over), repo, "main", by)).toEqual(expected);
  });

  it("throws a server error, so it is retried rather than taken as an answer", async () => {
    await expect(checkEvidence(gh({ pull: new GitHubError("bad gateway", 502, "/x") }), repo, "main", { pr: 920 })).rejects.toThrow("bad gateway");
  });
});

describe("dispatch: verify, close and finish", () => {
  const hosts: ReturnType<typeof createFakePluginHost>[] = [];
  afterEach(async () => { await settleJobs(); for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

  function setup(github: { issueState?: "open" | "closed" | "gone"; closeStatus?: number; ownPr?: "open" | "closed"; merged?: boolean; workflow?: Workflow } = {}) {
    const host = createFakePluginHost({ pluginId: "test" });
    hosts.push(host);
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, migrationsForDatabase(db));
    const clock = { now: NOW.getTime() };
    const store = new StateStore(db, () => new Date(clock.now));
    const calls: string[] = [];
    const fake = {
      getRepo: async () => ({ default_branch: "main" }),
      getPull: async (_o: string, _r: string, n: number) => {
        calls.push(`getPull ${n}`);
        return n === 920 ? { merged: github.merged ?? true, merged_at: github.merged === false ? null : "x", base: { ref: "main" }, state: "closed" } : { state: github.ownPr ?? "closed", merged: false, base: { ref: "main" } };
      },
      compareCommits: async () => ({ ahead_by: 0 }),
      getIssue: async () => {
        if (github.issueState === "gone") throw new GitHubError("Not Found", 404, "/x");
        return { state: github.issueState ?? "open" };
      },
      closeIssue: async (_o: string, _r: string, n: number) => {
        calls.push(`close ${n}`);
        if (github.closeStatus) throw new GitHubError("Resource not accessible", github.closeStatus, "/x");
      },
      createIssueComment: async (_o: string, _r: string, n: number, body: string) => {
        // The hidden marker first, so a later run can tell the comment is Chief of Staff's.
        expect(body.startsWith(`${RESOLVED_MARKER}\n`)).toBe(true);
        calls.push(`comment ${n}: ${body.split("\n")[1]}`);
        return { id: 1 };
      },
    };
    const repo = { owner: "acme", repo: "app", maxConcurrent: 2, issueComments: true } as unknown as RepoConfig;
    const cos = {
      bb: host.bb, store, now: () => new Date(clock.now), github: async () => fake, repo: async () => repo, safe: async (s: string) => s, invalidate: () => {}, notify: async () => {},
      config: async () => ({ policy: DEFAULT_POLICY, repos: [repo], values: { maxConcurrentTotal: 4, archiveThreadsOnDone: false } }),
    } as unknown as Cos;
    const nodes = { ...initialNodes(flow), plan: { ...freshNode(), status: "running" as const, round: 1, reports: [null], nudges: [0], deliveries: { 0: { id: "d1", round: 1, threadId: "t1", state: "accepted" as const, sentAt: 0 } } } };
    store.insertWorkItem({ id: "w1", repo: "acme/app", status: "agent", issueTitle: "Retry crashes", issueNumber: 929, branch: "cos/issue-929", threadId: null, environmentId: null, prNumber: github.ownPr ? 950 : null, prUrl: null, providerId: null, model: null, lastError: null, source: "intake", lastActivityAt: null, finishedAt: null, workflow: github.workflow ?? flow, nodes } satisfies NewWorkItem);
    store.upsertThread({ threadId: "t1", itemId: "w1", role: "step", stepId: "plan", agent: 0, environmentId: null, round: 1, promptSentAt: 0 });
    return { cos, store, calls, clock };
  }
  const report = (cos: Cos, by: StepReport["resolvedBy"] = { pr: 920 }) => dispatch(cos, "w1", { type: "turn_ended", step: "plan", agent: 0, round: 1, report: resolved(by), question: null }, "test");

  it("closes the issue, then comments the evidence, and ends the task", async () => {
    const { cos, store, calls } = setup();
    await report(cos);
    expect(calls).toEqual(["getPull 920", "close 929", "comment 929: 🤖 Chief of Staff closed this issue: it is already resolved by pull request #920 (merged into main)."]);
    const item = store.getWorkItem("w1")!;
    expect(item).toMatchObject({ status: "done", lastError: ALREADY_RESOLVED });
    expect(finishedOutcome(item, null)).toBe("already_resolved");
    expect(store.listLog({ limit: 20 }).some((e) => e.kind === "resolve" && e.message.includes("Closed issue #929"))).toBe(true);
  });

  it("takes the report the agent filed with cos_report through the sweep's idle check", async () => {
    const { cos, store, calls } = setup();
    store.updateThread("t1", { pendingReport: { ...resolved({ pr: 920 }), step: "plan", round: 1, delivery: "d1" } });
    await observeIdle(cos, "w1", "t1", { updatedAt: 1_000 }, "", "test");
    expect(calls).toContain("close 929");
    expect(store.getWorkItem("w1")!.status).toBe("done");
  });

  it("takes a text report's evidence the same way", async () => {
    const { cos, store, calls } = setup();
    const text = ["## Step report", "step: plan", "delivery: d1", "outcome: resolved", "resolvedCommit: 28371b83", "summary: #920 fixed it"].join("\n");
    await observeIdle(cos, "w1", "t1", { updatedAt: 1_000 }, text, "test");
    expect(calls).toContain("close 929");
    expect(store.getWorkItem("w1")!.lastError).toBe(ALREADY_RESOLVED);
  });

  it("verifies again from the sweep when a restart cut verification off", async () => {
    const { cos, store, calls, clock } = setup();
    const item = store.getWorkItem("w1")!;
    item.nodes.plan = { ...item.nodes.plan!, reports: [resolved()], phase: "closing" };
    store.updateWorkItem("w1", { nodes: item.nodes, status: "cos" });
    await tickItems(cos, "test");
    expect(calls).toEqual([]);
    clock.now += 60_000;
    await tickItems(cos, "test");
    expect(calls).toContain("close 929");
    expect(store.getWorkItem("w1")!.status).toBe("done");
  });

  it("with an approval gate, closes nothing until approved", async () => {
    const { cos, store, calls } = setup({ workflow: gated });
    await report(cos);
    expect(calls).toEqual(["getPull 920"]);
    expect(store.getWorkItem("w1")!).toMatchObject({ status: "waiting_on_human", waitingKind: "approval" });
    await dispatch(cos, "w1", { type: "approve" }, "test");
    expect(calls).toEqual(["getPull 920", "getPull 920", "close 929", "comment 929: 🤖 Chief of Staff closed this issue: it is already resolved by pull request #920 (merged into main)."]);
    expect(store.getWorkItem("w1")!).toMatchObject({ status: "done", lastError: ALREADY_RESOLVED });
  });

  it("finishes when the issue is gone (deleted or transferred)", async () => {
    const { cos, store, calls } = setup({ issueState: "gone" });
    await report(cos);
    expect(calls).toEqual(["getPull 920"]);
    expect(store.getWorkItem("w1")!.status).toBe("done");
    expect(store.listJournal("w1").some((j) => j.detail?.includes("could not be found to close"))).toBe(true);
  });

  it("leaves an issue someone already closed alone", async () => {
    const { cos, store, calls } = setup({ issueState: "closed" });
    await report(cos);
    expect(calls).toEqual(["getPull 920"]);
    expect(store.getWorkItem("w1")!.status).toBe("done");
  });

  it("still finishes when GitHub refuses the close, and says so on the task", async () => {
    const { cos, store, calls } = setup({ closeStatus: 403 });
    await report(cos);
    expect(calls).toEqual(["getPull 920", "close 929"]);
    expect(store.getWorkItem("w1")!.status).toBe("done");
    const journal = store.listJournal("w1").map((j) => j.detail ?? "");
    expect(journal.some((d) => d.includes("could not close issue #929 (GitHub said 403)"))).toBe(true);
  });

  it("does not discard the task's own open pull request", async () => {
    const { cos, store, calls } = setup({ ownPr: "open" });
    await report(cos);
    expect(calls).toEqual(["getPull 950"]);
    const item = store.getWorkItem("w1")!;
    expect(item.status).toBe("waiting_on_human");
    expect(item.waitingReason).toContain("its own open pull request #950");
  });

  it("asks a person when the PR is not merged, and touches nothing on GitHub", async () => {
    const { cos, store, calls } = setup({ merged: false });
    await report(cos);
    expect(calls).toEqual(["getPull 920"]);
    expect(store.getWorkItem("w1")!).toMatchObject({ status: "waiting_on_human", waitingKind: "escalation" });
  });
});

describe("default branch for prompts", () => {
  it("asks GitHub once per repository per hour, and keeps an older answer when GitHub fails", async () => {
    let calls = 0;
    let fail = false;
    const clock = { now: NOW.getTime() };
    const cos = { now: () => new Date(clock.now), github: async () => ({ getRepo: async () => { calls += 1; if (fail) throw new Error("down"); return { default_branch: "main" }; } }) } as unknown as Cos;
    const repo = { owner: "cache", repo: `r${Math.random()}` } as RepoConfig;
    expect(await defaultBranch(cos, repo)).toBe("main");
    expect(await defaultBranch(cos, repo)).toBe("main");
    expect(calls).toBe(1);
    clock.now += DEFAULT_BRANCH_TTL_MS;
    fail = true;
    expect(await defaultBranch(cos, repo)).toBe("main");
    expect(calls).toBe(2);
  });
});

describe("a replaced thread's late failure (canary#929 retry)", () => {
  it("does not park the step its new thread is working on", async () => {
    const host = createFakePluginHost({ pluginId: "test" });
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, migrationsForDatabase(db));
    const store = new StateStore(db);
    const cos = { bb: host.bb, store, now: () => NOW, safe: async (s: string) => s, invalidate: () => {}, notify: async () => {}, config: async () => ({ policy: DEFAULT_POLICY, repos: [], values: { maxConcurrentTotal: 4, archiveThreadsOnDone: false } }) } as unknown as Cos;
    const delivery = (threadId: string | null) => ({ 0: { id: "d", round: 1, threadId, state: "accepted" as const, sentAt: 0 } });
    const nodes = { ...initialNodes(flow), plan: { ...freshNode(), status: "running" as const, round: 1, reports: [null], nudges: [0], deliveries: delivery("new") } };
    store.insertWorkItem({ id: "w1", repo: "acme/app", status: "agent", issueTitle: "t", issueNumber: 929, branch: "b", threadId: null, environmentId: null, prNumber: null, prUrl: null, providerId: null, model: null, lastError: null, source: "intake", lastActivityAt: null, finishedAt: null, workflow: flow, nodes } satisfies NewWorkItem);
    for (const threadId of ["old", "new"]) store.upsertThread({ threadId, itemId: "w1", role: "step", stepId: "plan", agent: 0, environmentId: null, round: 1, promptSentAt: 0 });

    await observeFailure(cos, "w1", "old", "thread errored", "test");
    expect(store.getWorkItem("w1")!.nodes.plan!.status).toBe("running");

    await observeFailure(cos, "w1", "new", "thread errored", "test");
    expect(store.getWorkItem("w1")!.nodes.plan!.waiting?.kind).toBe("cos_error");
    await host.harness.lifecycle.dispose();
  });
});

describe("resolveAgent: a model is inherited only for its own provider", () => {
  const defaults = { providerId: "claude-code", model: "Opus" };
  it("gives a repository on Codex without a model Codex's default, not the global Claude model", () => {
    expect(resolveAgent({}, { providerId: "codex" }, defaults)).toEqual({ providerId: "codex", model: undefined, reasoningLevel: undefined });
  });
  it("keeps a model set without a provider, for the provider it inherits", () => {
    expect(resolveAgent({}, { model: "Sonnet" }, defaults)).toEqual({ providerId: "claude-code", model: "Sonnet", reasoningLevel: undefined });
    expect(resolveAgent({ model: "gpt-6.1-sol" }, { providerId: "codex" }, defaults)).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol" });
  });
  it("drops an earlier Model step's model when a later one switches provider", () => {
    const steps = workflowSchema.parse({ id: "m", name: "M", steps: [
      { id: "m1", name: "M1", type: "model", mode: "fixed", providerId: "claude-code", model: "Opus", reasoningLevel: "high", next: ["m2"] },
      { id: "m2", name: "M2", type: "model", mode: "fixed", providerId: "codex", next: ["a"] },
      { id: "a", name: "A", type: "agent" },
    ] });
    expect(settingsFor(steps, "a")).toEqual({ providerId: "codex" });
  });
  it("with no global provider, the global model reaches only agents for which nothing names a provider", () => {
    const unset = { providerId: "", model: "Opus" };
    expect(resolveAgent({}, {}, unset)).toEqual({ providerId: undefined, model: "Opus", reasoningLevel: undefined });
    // Chief of Staff cannot tell which provider the host defaults to: a named one, even Claude Code, keeps its own default.
    expect(resolveAgent({}, { providerId: "claude-code" }, unset)).toEqual({ providerId: "claude-code", model: undefined, reasoningLevel: undefined });
    expect(resolveAgent({}, { providerId: "codex" }, unset)).toEqual({ providerId: "codex", model: undefined, reasoningLevel: undefined });
  });
  it("drops a repository's model and level when a step switches provider", () => {
    expect(resolveAgent({ providerId: "codex" }, { providerId: "claude-code", model: "Opus", reasoningLevel: "high" }, defaults)).toEqual({ providerId: "codex", model: undefined, reasoningLevel: undefined });
  });
});
