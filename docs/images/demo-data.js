// Demo data for the README screenshots. Injected into the BB page before load
// (evaluateOnNewDocument), it answers the plugin's RPC calls so the real UI
// renders invented tasks instead of live ones.
(() => {
  if (window.__cosDemo) return; window.__cosDemo = true;
  const now = Date.now(), ago = (m) => new Date(now - m * 60000).toISOString();
  const S = (id, name, type, depth, status, x = {}) => ({ id, name, type, depth, status, phase: null, agents: 1, reported: status === "done" && type === "agent" ? 1 : 0, nudged: 0, attempts: 0, round: 1, waitingKind: null, retrying: false, ...x });
  const careful = (st, x = {}) => [
    S("plan", "Plan", "agent", 0, st[0], { agents: 2, reported: st[0] === "done" || st[0] === "waiting" ? 2 : 1, ...(x.plan || {}) }),
    S("build", "Build", "agent", 1, st[1], x.build), S("test", "Tests", "check", 2, st[2], x.test),
    S("review", "Review", "agent", 3, st[3], x.review), S("docs", "Docs", "agent", 3, st[4], x.docs), S("ship", "Ship", "ship", 4, st[5], x.ship)];
  const quick = (st, x = {}) => [S("build", "Build", "agent", 0, st[0], x.build), S("test", "Tests", "check", 1, st[1], x.test), S("ship", "Ship", "ship", 2, st[2], x.ship)];
  // Like the server: issue-backed tasks carry the issue URL, standalone tasks null.
  const withIssueUrl = (e) => ({ ...e, issueUrl: e.issueNumber ? `https://github.com/${e.repo}/issues/${e.issueNumber}` : null });
  const E = (o) => withIssueUrl({ occupiesCapacity: true, status: "running", detail: "agent", workflowName: "Careful", steps: [], current: [], actor: "agent", activity: "", waitingKind: null, repo: "acme/storefront", issueNumber: null, issueTitle: "", threadId: null, threadStatus: "working", threadTitle: null, branch: null, prNumber: null, prUrl: null, pr: null, startedAt: ago(30), lastActivityAt: ago(1), stalled: false, fixAttempts: 0, retryCount: 0, lastError: null, waitingReason: null, providerId: "claude-code", model: null, source: "intake", usage: null, ...o });
  const U = (t, c) => ({ inputTokens: null, outputTokens: null, totalTokens: t, cost: c == null ? null : { amount: c, currency: "USD" } });
  const active = [
    E({ id: "t1", issueNumber: 212, issueTitle: "Add CSV export to the orders table", steps: careful(["done", "done", "done", "running", "running", "pending"]), current: ["Review", "Docs"], activity: "Review: agent working · Docs: agent working", threadId: "thr_demo1", branch: "cos/issue-212-add-csv-export", startedAt: ago(47), usage: U(1284000, 3.92) }),
    E({ id: "t2", issueNumber: 208, issueTitle: "Rate-limit the password reset endpoint", repo: "acme/api", status: "waiting on human", detail: "waiting_on_human", actor: "human", waitingKind: "approval", waitingReason: "Plan: needs your approval", steps: careful(["waiting", "pending", "pending", "pending", "pending", "pending"], { plan: { waitingKind: "approval" } }), current: ["Plan"], activity: "Plan: needs your approval", threadId: "thr_demo2", threadStatus: "idle", startedAt: ago(12), lastActivityAt: ago(4), usage: U(186000, 0.61) }),
    E({ id: "t3", issueNumber: 197, issueTitle: "Checkout total is wrong when a coupon and gift card combine", detail: "ci", actor: "system", occupiesCapacity: false, steps: careful(["done", "done", "done", "done", "done", "running"], { ship: { phase: "ci" }, build: { round: 3 }, test: { round: 3, attempts: 1 }, review: { round: 2, attempts: 1 }, docs: { round: 2 } }), current: ["Ship"], activity: "Ship: PR #231 open, waiting for CI", threadId: "thr_demo3", threadStatus: "idle", prNumber: 231, prUrl: "https://github.com/acme/storefront/pull/231", pr: { state: "open", draft: false, checks: "pending", review: null, checkedAt: ago(4) }, branch: "cos/issue-197-checkout-total", startedAt: ago(96), lastActivityAt: ago(6), usage: U(2410000, 7.35) }),
    E({ id: "t4", issueTitle: "Upgrade the image pipeline to sharp 0.34", repo: "acme/api", source: "task", workflowName: "Quick fix", detail: "cos", actor: "cos", steps: quick(["done", "running", "pending"]), current: ["Tests"], activity: "Tests: running the check", threadId: "thr_demo4", threadStatus: "idle", branch: "cos/upgrade-image-pipeline", startedAt: ago(21), usage: U(642000, 1.88) }),
    E({ id: "t5", issueNumber: 215, issueTitle: "Show delivery estimates on the product page", steps: careful(["done", "running", "pending", "pending", "pending", "pending"]), current: ["Build"], activity: "Build: agent working", threadId: "thr_demo5", branch: "cos/issue-215-delivery-estimates", startedAt: ago(18), usage: U(498000, 1.42) }),
    E({ id: "t6", issueNumber: 219, issueTitle: "Paginate the audit log API", repo: "acme/api", status: "queued", detail: "queued", actor: "none", occupiesCapacity: false, steps: careful(["pending", "pending", "pending", "pending", "pending", "pending"]), activity: "Waiting to start", threadStatus: null, startedAt: ago(3), lastActivityAt: null }),
  ];
  const done = [
    E({ id: "d1", issueNumber: 204, issueTitle: "Fix flaky cart session test", status: "done", detail: "done", actor: "none", occupiesCapacity: false, steps: careful(["done", "done", "done", "done", "done", "done"]), activity: "Done", threadStatus: "idle", prNumber: 229, prUrl: "https://github.com/acme/storefront/pull/229", pr: { state: "merged", draft: false, checks: null, review: null, checkedAt: ago(215) }, startedAt: ago(260), lastActivityAt: ago(215), usage: U(1730000, 5.1) }),
  ];
  const wf = {
    workflows: [
      { id: "careful", name: "Careful", steps: [
        { id: "plan", position: { x: 0, y: 0 }, name: "Plan", type: "agent", agents: 2, approval: true, writes: false, verdict: false, maxRounds: 2, chooses: [], instructions: "Investigate the codebase and write an implementation plan: approach, files, risks, and how you will test it.", next: ["build"] },
        { id: "build", position: { x: 0, y: 130 }, name: "Build", type: "agent", agents: 1, approval: false, writes: true, verdict: false, maxRounds: 2, chooses: [], instructions: "Use /tdd, then implement the plan.", next: ["test"] },
        { id: "test", position: { x: 0, y: 260 }, name: "Tests", type: "check", command: "npm test", timeoutMinutes: 10, onFail: "build", maxAttempts: 2, next: ["review", "docs"] },
        { id: "review", position: { x: -140, y: 390 }, name: "Review", type: "agent", agents: 1, approval: false, writes: false, verdict: true, onFail: "build", maxRounds: 2, chooses: [], instructions: "Review the changes on this branch. Pass if ready; fail with concrete findings.", next: ["ship"] },
        { id: "docs", position: { x: 140, y: 390 }, name: "Docs", type: "agent", agents: 1, approval: false, writes: false, verdict: false, maxRounds: 2, chooses: [], instructions: "Check the docs cover the change.", next: ["ship"] },
        { id: "ship", position: { x: 0, y: 520 }, name: "Ship", type: "ship", action: "pr", draft: false, requireApproval: true, onFail: "build", maxAttempts: 2, instructions: "", next: [] } ] },
      { id: "quick", name: "Quick fix", steps: [
        { id: "build", name: "Build", type: "agent", agents: 1, approval: false, writes: true, verdict: false, maxRounds: 2, chooses: [], instructions: "Implement the task. Add or update tests.", next: ["test"] },
        { id: "test", name: "Tests", type: "check", command: "npm test", timeoutMinutes: 10, onFail: "build", maxAttempts: 2, next: ["ship"] },
        { id: "ship", name: "Ship", type: "ship", action: "pr", draft: false, requireApproval: true, onFail: "build", maxAttempts: 2, instructions: "", next: [] } ] } ],
    default: "careful" };
  const repos = { repos: [
    { owner: "acme", repo: "storefront", projectId: "proj_storefront", intake: true, issueFilter: { labels: ["agent-ready"] }, maxConcurrent: 3, reviewers: ["alice"], mergeStrategy: "squash", workflow: "careful" },
    { owner: "acme", repo: "api", projectId: "proj_api", intake: true, issueFilter: { labels: ["agent-ready", "backend"] }, maxConcurrent: 2, mergeStrategy: "squash", workflow: "careful" } ] };
  const names = ["Plan", "Build", "Tests", "Review", "Docs", "Ship"];
  const daily = [2, 3, 1, 0, 0, 4, 5, 3, 4, 2, 0, 1, 6, 3].map((d, i) => ({ date: new Date(now - (13 - i) * 864e5).toISOString().slice(0, 10), started: d + (i % 3 === 0 ? 1 : 0), done: d, failed: i % 5 === 2 ? 1 : 0 }));
  const L = (id, m, kind, repo, message, actor = "chief-of-staff", level = "info") => ({ id, at: ago(m), level, kind, repo, workItemId: null, message, actor });
  const live = (steps) => Object.fromEntries(steps.map((s) => [s.id, { status: s.status, phase: s.phase, reported: s.reported, agents: s.agents, waitingKind: s.waitingKind, retrying: s.retrying, attempts: s.attempts, round: s.round }]));
  // Task t3's run history: Tests and Review each sent work back to Build once.
  const planSum = "**Approach.** Combine coupon and gift card discounts in `cartTotal()`: apply percentage coupons first, then gift cards, clamping at zero.\n\n- `src/cart/total.ts`: reorder the discount pipeline\n- `tests/cart.total.test.ts`: coupon + gift card cases";
  const buildSum = "Reordered discounts in `cartTotal()` and clamped the total at zero. Added a null check for carts without a coupon.\n\n- 3 new tests in `tests/cart.total.test.ts`\n- `npm test` → 48 passing";
  const reviewFail = "1. `src/cart/total.ts:42` — the gift card can push the total below zero when the coupon is 100%.\n2. Missing a test for an expired gift card.";
  const testFail = "FAIL tests/cart.total.test.ts\n  ● cart total › coupon and gift card\n    expected 1250 to be 1000\n\nTests: 1 failed, 45 passed";
  let jid = 0; const J = (m, step, round, kind, x = {}) => ({ id: ++jid, at: ago(m), step, round, kind, detail: null, actor: "chief-of-staff", ...x });
  const journal = [
    J(96, "plan", 1, "started"), J(88, "plan", 1, "reported", { agent: 0, detail: planSum }), J(87, "plan", 1, "reported", { agent: 1, detail: planSum }),
    J(87, "plan", 1, "waiting", { detail: "Plan is ready for your approval." }), J(80, "plan", 1, "passed", { detail: "Approved", actor: "rpc:client" }),
    J(80, "build", 1, "started"), J(64, "build", 1, "reported", { agent: 0, detail: "Reordered discounts in cartTotal()." }), J(64, "build", 1, "passed"),
    J(64, "test", 1, "started"), J(62, "test", 1, "failed", { from: "test", to: "build", detail: testFail }),
    J(62, "build", 2, "started", { detail: "Tests failed:\n\n" + testFail }), J(50, "build", 2, "reported", { agent: 0, detail: "Fixed the rounding in the coupon step." }), J(50, "build", 2, "passed"),
    J(50, "test", 2, "started"), J(48, "test", 2, "passed", { detail: "Tests: 46 passed" }),
    J(48, "review", 1, "started"), J(48, "docs", 1, "started"), J(40, "docs", 1, "reported", { agent: 0, detail: "README covers discounts; no change needed." }), J(40, "docs", 1, "passed"),
    J(36, "review", 1, "reported", { agent: 0, detail: reviewFail }), J(36, "review", 1, "failed", { from: "review", to: "build", detail: reviewFail }),
    J(36, "build", 3, "started", { detail: "Review failed:\n\n" + reviewFail }), J(20, "build", 3, "reported", { agent: 0, detail: buildSum }), J(20, "build", 3, "passed"),
    J(20, "test", 3, "started"), J(18, "test", 3, "passed", { detail: "Tests: 48 passed" }),
    J(18, "review", 2, "started", { detail: null }), J(18, "docs", 2, "started"), J(12, "docs", 2, "reported", { agent: 0, detail: "Docs still accurate." }), J(12, "docs", 2, "passed"),
    J(9, "review", 2, "reported", { agent: 0, detail: "No findings: the total is clamped and both new cases are tested." }), J(9, "review", 2, "passed"),
    J(9, "ship", 1, "started"),
  ];
  const SD = (x = {}) => ({ startedAt: null, finishedAt: null, feedback: null, output: null, waitingReason: null, reports: [], threads: [], ...x });
  const steps = {
    plan: SD({ startedAt: ago(96), finishedAt: ago(80), reports: [{ agent: 0, outcome: "done", summary: planSum, at: ago(88) }, { agent: 1, outcome: "done", summary: planSum, at: ago(87) }], threads: [{ threadId: "thr_p1", agent: 0 }, { threadId: "thr_p2", agent: 1 }] }),
    build: SD({ startedAt: ago(36), finishedAt: ago(20), reports: [{ agent: 0, outcome: "done", summary: buildSum, at: ago(20) }], threads: [{ threadId: "thr_b", agent: 0 }] }),
    test: SD({ startedAt: ago(20), finishedAt: ago(18), output: "Tests: 48 passed (48)\nDuration 6.1s" }),
    review: SD({ startedAt: ago(18), finishedAt: ago(9), reports: [{ agent: 0, outcome: "done", summary: "No findings: the total is clamped and both new cases are tested.", at: ago(9) }], threads: [{ threadId: "thr_r", agent: 0 }] }),
    docs: SD({ startedAt: ago(18), finishedAt: ago(12), reports: [{ agent: 0, outcome: "done", summary: "Docs still accurate.", at: ago(12) }], threads: [{ threadId: "thr_d", agent: 0 }] }),
    ship: SD({ startedAt: ago(9) }),
  };
  const history = { journal, steps };
  const R = {
    cos_roster: (i) => ({ entries: i && i.includeDone ? [...active, ...done] : active }),
    cos_stats: () => ({ byStatus: { queued: 1, agent: 2, cos: 1, ci: 1, ready: 0, waiting_on_human: 1, retrying: 0, blocked: 0, done: 34, failed: 3 }, daily, windowDays: 14, startedInWindow: 43, doneInWindow: 34, failedInWindow: 3, medianCycleMinutes: 38, totalTracked: 43 }),
    cos_overview: () => ({ paused: false, occupiedCapacity: 4, tokenSource: "gh-cli", errors: [], warnings: [], settings: { stallThresholdMinutes: 30, maxConcurrentTotal: 8, intakeIntervalMinutes: 10 }, repos: [
      { key: "acme/storefront", projectId: "proj_storefront", maxConcurrent: 3, active: 2, labels: ["agent-ready"], intake: true, paused: false, workflowId: "careful", workflowName: "Careful", stepNames: names },
      { key: "acme/api", projectId: "proj_api", maxConcurrent: 2, active: 2, labels: ["agent-ready", "backend"], intake: true, paused: false, workflowId: "careful", workflowName: "Careful", stepNames: names } ] }),
    cos_log: () => ({ entries: [
      L(9, 1, "report", "acme/storefront", "#212 Tests passed (npm test, 48s); starting Review and Docs"),
      L(8, 3, "intake", "acme/api", "picked up #219 Paginate the audit log API"),
      L(7, 4, "transition", "acme/api", "#208 Plan: 2/2 agents reported, waiting for your approval"),
      L(6, 6, "pr", "acme/storefront", "#197 opened PR #231, watching CI"),
      L(5, 14, "transition", "acme/storefront", "#197 Review failed (round 1): sent back to Build with 2 findings", "chief-of-staff", "warn"),
      L(4, 18, "spawn", "acme/storefront", "#215 Build: started builder thread in a new worktree"),
      L(3, 21, "manual", "acme/api", "task started: Upgrade the image pipeline to sharp 0.34", "alice"),
      L(2, 215, "pr", "acme/storefront", "#204 PR #229 merged"),
    ], nextCursor: null }),
    cos_get_config: () => ({ repos: JSON.stringify(repos), workflow: JSON.stringify(wf) }),
    cos_get_settings: () => ({ values: { maxConcurrentTotal: 8, stallThresholdMinutes: 30, intakeIntervalMinutes: 10, defaultProviderId: "claude-code", defaultModel: "", notifyPush: true, archiveThreadsOnDone: true }, token: { stored: false, source: "gh-cli" },
      projects: [{ id: "proj_storefront", name: "storefront", remote: "https://github.com/acme/storefront.git" }, { id: "proj_api", name: "api", remote: "https://github.com/acme/api.git" }],
      providers: [{ id: "claude-code", displayName: "Claude Code", available: true, enabled: true }, { id: "codex", displayName: "Codex", available: true, enabled: true }] }),
    cos_skills: () => ({ skills: [{ name: "tdd", description: "Write the failing test first.", scope: "project" }, { name: "review", description: "Review the branch diff.", scope: "project" }] }),
    cos_item_workflow: (i) => {
      const e = [...active, ...done].find((x) => x.id === i.id) || active[0];
      const task = { repo: e.repo, issueNumber: e.issueNumber, issueUrl: e.issueUrl, body: e.id === "t3" ? "When a cart has both a percentage coupon and a gift card, the checkout total is higher than expected. The gift card should apply after the coupon." : null, status: e.detail, branch: e.branch, prNumber: e.prNumber, prUrl: e.prUrl, threadId: e.threadId, waitingReason: e.waitingReason, lastError: e.lastError, createdAt: e.startedAt, lastActivityAt: e.lastActivityAt, finishedAt: null };
      return { title: (e.issueNumber ? "#" + e.issueNumber + " " : "") + e.issueTitle, workflow: wf.workflows[e.workflowName === "Quick fix" ? 1 : 0], live: live(e.steps), task, ...(e.id === "t3" ? history : { steps: {}, journal: [] }) };
    },
    cos_question: () => ({ itemId: "t2", repo: "acme/api", issueNumber: 208, issueTitle: "Rate-limit the password reset endpoint", threadId: "thr_demo2", threadUrl: null, status: "waiting_on_human", stepId: "plan", stepName: "Plan", waitingKind: "approval", waitingReason: "Plan: needs your approval",
      report: "## Plan (agent 1)\n\n**Approach.** Add a sliding-window limiter keyed on account email and client IP in front of `POST /auth/reset`: 5 requests per 15 minutes, answered with `429` and a `Retry-After` header.\n\n**Files.**\n\n- `src/middleware/rateLimit.ts`: new limiter backed by the existing Redis client\n- `src/routes/auth.ts`: apply it to the reset route\n- `tests/auth.reset.test.ts`: limit, window expiry, per-IP isolation\n\n**Risks.** Shared office IPs could trip the limit; the email key keeps one user from locking out another.\n\n## Plan (agent 2)\n\nSame design. Also proposes logging limited attempts to the audit log so abuse is visible.",
      decidable: true, open: [], lastMessage: null, checkOutput: null, lastError: null }),
  };
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const m = /\/plugins\/chief-of-staff\/rpc\/(\w+)/.exec(url);
    if (!m) return real(input, init);
    let body = null; try { body = JSON.parse((init && init.body) || (typeof input !== "string" ? await input.clone().text() : "null")); } catch {}
    const h = R[m[1]];
    const payload = h ? { ok: true, result: h(body) } : { ok: false, error: { code: "demo", message: "Not available in the demo" } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
})();
