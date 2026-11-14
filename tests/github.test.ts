// The GitHub client on its own: deadlines, error format, rate limits and the
// newest-comments fetch, against a fake fetch.
import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, GitHubLimiter, GitHubRateLimitError, matchOpenPullForIssue, prStateFrom, reduceReviews, type GitHubPull, type Review } from "../src/github";

const TOKEN = "ghp_secret_token";

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };

/** A fake fetch answering from `reply(url, init)`; records every call. */
function fakeFetch(reply: (url: URL, init: RequestInit) => Reply | Promise<Reply>) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const r = await reply(url, init);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : (r.text ?? JSON.stringify(r.body ?? {})), { status, headers: { "content-type": "application/json", ...r.headers } });
  });
}

/** A fetch that never answers; it rejects only when its signal aborts. */
function hangingFetch() {
  return vi.fn((_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }),
  );
}

/** Headers arrive at once; the body never does, and its stream errors on abort. */
function stallingBodyFetch() {
  return vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("GitHubClient requests", () => {
  it("cuts a request that never answers at its deadline, naming the method and path", async () => {
    const client = new GitHubClient({ token: TOKEN, fetch: hangingFetch() as typeof fetch, timeoutMs: 50 });
    const error = await client.getIssue("acme", "app", 12).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(0);
    expect((error as GitHubError).message).toBe("GitHub GET /repos/acme/app/issues/12 timed out after 50ms");
  });

  it("cuts a body that stalls after the headers arrived", async () => {
    const client = new GitHubClient({ token: TOKEN, fetch: stallingBodyFetch() as typeof fetch, timeoutMs: 50 });
    const error = await client.paginate("/repos/acme/app/issues").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(0);
    expect((error as GitHubError).message).toMatch(/^GitHub GET \/repos\/acme\/app\/issues\?per_page=100 timed out/);
  });

  it("keeps a network error's message and names the request", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    });
    const error = await new GitHubClient({ token: TOKEN, fetch: fetch as typeof globalThis.fetch }).getRepo("acme", "app").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).message).toBe("GitHub GET /repos/acme/app failed: fetch failed for <redacted>");
  });

  it("puts the redacted body in request and paginate errors alike", async () => {
    const fetch = fakeFetch(() => ({ status: 500, body: { message: `boom ${TOKEN}` } }));
    const client = new GitHubClient({ token: TOKEN, fetch: fetch as typeof globalThis.fetch });
    const paged = (await client.paginate("/repos/acme/app/issues").catch((e: unknown) => e)) as GitHubError;
    const single = (await client.getRepo("acme", "app").catch((e: unknown) => e)) as GitHubError;
    expect(paged.message).toBe('GitHub GET /repos/acme/app/issues?per_page=100 failed with 500: {"message":"boom <redacted>"}');
    expect(single.message).toBe('GitHub GET /repos/acme/app failed with 500: {"message":"boom <redacted>"}');
    expect(paged.status).toBe(500);
  });

  it("returns nothing for 204/202, text when raw, and follows next links", async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname.endsWith("/merge")) return { status: 204 };
      if (url.pathname.endsWith("/logs")) return { text: "log line" };
      const page = Number(url.searchParams.get("page") ?? "1");
      return { body: [page], headers: page < 3 ? { link: `<https://api.github.com/x?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/x?per_page=100&page=3>; rel="last"` } : ({} as Record<string, string>) };
    });
    const client = new GitHubClient({ token: TOKEN, fetch: fetch as typeof globalThis.fetch });
    expect(await client.request("PUT", "/repos/acme/app/pulls/1/merge", {})).toBeUndefined();
    expect(await client.request("GET", "/repos/acme/app/actions/jobs/1/logs", undefined, { raw: true })).toBe("log line");
    expect(await client.paginate("/x")).toEqual([1, 2, 3]);
    const sent = fetch.mock.calls[0]![1] as RequestInit;
    expect((sent.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GitHub rate limits", () => {
  const NOW = Date.parse("2026-11-12T10:00:00Z");

  /** A client on a shared limiter whose fetch answers `reply` and counts calls. */
  function setup(reply: Reply) {
    const onLimit = vi.fn();
    const limiter = new GitHubLimiter(onLimit);
    let now = NOW;
    const fetch = fakeFetch(() => reply);
    const client = () => new GitHubClient({ token: TOKEN, fetch: fetch as typeof globalThis.fetch, limiter, now: () => now });
    return { fetch, limiter, onLimit, client, setNow: (t: number) => (now = t) };
  }
  const resetOf = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    return (error as GitHubRateLimitError).resetAt.getTime();
  };

  it("waits retry-after seconds on a 429", async () => {
    const { client } = setup({ status: 429, headers: { "retry-after": "120" } });
    expect(await resetOf(client().getRepo("acme", "app"))).toBe(NOW + 120_000);
  });

  it("waits until x-ratelimit-reset when the primary window is used up", async () => {
    const reset = NOW / 1000 + 900;
    const { client } = setup({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    expect(await resetOf(client().getRepo("acme", "app"))).toBe(reset * 1000);
  });

  it("waits a minute on a secondary limit that names no reset", async () => {
    const { client } = setup({ status: 403, body: { message: "You have exceeded a secondary rate limit." } });
    expect(await resetOf(client().paginate("/repos/acme/app/issues"))).toBe(NOW + 60_000);
  });

  it("clamps a far reset to one hour", async () => {
    const { client } = setup({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 86_400) } });
    expect(await resetOf(client().getRepo("acme", "app"))).toBe(NOW + 60 * 60_000);
  });

  it("treats a plain 403 as a permission error and arms nothing", async () => {
    const { client, limiter, fetch } = setup({ status: 403, body: { message: "Resource not accessible by integration" } });
    const error = await client().getRepo("acme", "app").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).not.toBeInstanceOf(GitHubRateLimitError);
    expect(limiter.limitedUntil(NOW)).toBeNull();
    await client().getRepo("acme", "app").catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails fast on every client sharing the limiter until the reset, then sends again", async () => {
    const s = setup({ status: 429, headers: { "retry-after": "120" } });
    await s.client().getRepo("acme", "app").catch(() => undefined);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    for (const c of [s.client(), s.client()]) expect(await resetOf(c.getIssue("acme", "app", 1))).toBe(NOW + 120_000);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.onLimit).toHaveBeenCalledTimes(1);
    s.setNow(NOW + 120_000);
    await s.client().getRepo("acme", "app").catch(() => undefined);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    // A new episode is reported again.
    expect(s.onLimit).toHaveBeenCalledTimes(2);
  });

  it("arms the limiter on a success that used up the window, and still returns its body", async () => {
    const reset = NOW / 1000 + 300;
    const s = setup({ body: { default_branch: "main" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    expect((await s.client().getRepo("acme", "app")).default_branch).toBe("main");
    expect(s.limiter.limitedUntil(NOW)?.until.getTime()).toBe(reset * 1000);
    expect(await resetOf(s.client().getRepo("acme", "app"))).toBe(reset * 1000);
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it("is cleared on demand (a new token)", async () => {
    const s = setup({ status: 429, headers: { "retry-after": "600" } });
    await s.client().getRepo("acme", "app").catch(() => undefined);
    s.limiter.clear();
    expect(s.limiter.limitedUntil(NOW)).toBeNull();
  });
});

/** GitHub's pages of a list with `total` entries, oldest first: ids 1..total, 100 per page. */
function pagedFetch(total: number, entry: (id: number) => object) {
  return fakeFetch((url) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    const pages = Math.max(1, Math.ceil(total / 100));
    const ids = Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, i) => (page - 1) * 100 + i + 1);
    const base = `https://api.github.com${url.pathname}?per_page=100`;
    const link = pages > 1 && page < pages ? `<${base}&page=${page + 1}>; rel="next", <${base}&page=${pages}>; rel="last"` : pages > 1 ? `<${base}&page=1>; rel="first", <${base}&page=${page - 1}>; rel="prev"` : "";
    return { body: ids.map(entry), headers: link ? { link } : ({} as Record<string, string>) };
  });
}
const pagesAsked = (fetch: ReturnType<typeof fakeFetch>) => fetch.mock.calls.map(([u]) => new URL(String(u)).searchParams.get("page") ?? "1");
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("newest issue comments and truncated lists", () => {
  const commentsFetch = (total: number) => pagedFetch(total, (id) => ({ id, body: `c${id}`, user: null, created_at: "" }));
  const newest = async (total: number) => {
    const fetch = commentsFetch(total);
    const comments = await new GitHubClient({ token: TOKEN, fetch: fetch as typeof globalThis.fetch }).listIssueComments("acme", "app", 12, { newest: 10 });
    return { ids: comments.map((c) => c.id), pages: pagesAsked(fetch) };
  };

  it("keeps the default comment scan bounded to three pages for marker recovery", async () => {
    const fetch = commentsFetch(350);
    const comments = await new GitHubClient({ token: TOKEN, fetch: fetch as typeof globalThis.fetch }).listIssueComments("acme", "app", 12);
    expect(comments.map((c) => c.id)).toEqual(range(1, 300));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reads the last page of a long issue", async () => {
    expect(await newest(250)).toEqual({ ids: range(241, 250), pages: ["1", "3"] });
  });

  it("reads the page before a short last page", async () => {
    expect(await newest(205)).toEqual({ ids: range(196, 205), pages: ["1", "3", "2"] });
  });

  it("reuses page 1 when it is the page before a short page 2", async () => {
    expect(await newest(105)).toEqual({ ids: range(96, 105), pages: ["1", "2"] });
  });

  it("makes one request for a short issue", async () => {
    expect(await newest(7)).toEqual({ ids: range(1, 7), pages: ["1"] });
  });

  it("warns once when a list stops at its page limit", async () => {
    const log = vi.fn();
    const fetch = commentsFetch(350);
    const all = await new GitHubClient({ token: TOKEN, fetch: fetch as typeof globalThis.fetch, log }).paginate("/repos/acme/app/issues/12/comments", 2);
    expect(all).toHaveLength(200);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("GitHub list /repos/acme/app/issues/12/comments truncated at 2 pages");
    await new GitHubClient({ token: TOKEN, fetch: commentsFetch(150) as typeof globalThis.fetch, log }).paginate("/repos/acme/app/issues/12/comments", 2);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("GitHubClient.listIssueEvents", () => {
  /** Events of an issue with `total` of them, oldest first; the id doubles as the event's minute. */
  const events = async (total: number) => {
    const fetch = pagedFetch(total, (id) => ({ id, event: "labeled", created_at: new Date(Date.UTC(2026, 10, 1, 0, id)).toISOString(), label: { name: "agent-ready" } }));
    const list = await new GitHubClient({ token: TOKEN, fetch: fetch as typeof globalThis.fetch }).listIssueEvents("acme", "app", 12);
    expect(fetch.mock.calls.every(([u]) => new URL(String(u)).pathname === "/repos/acme/app/issues/12/events")).toBe(true);
    return { ids: list.map((e) => (e as unknown as { id: number }).id), pages: pagesAsked(fetch) };
  };

  it("makes one request for an issue with few events", async () => {
    expect(await events(7)).toEqual({ ids: range(1, 7), pages: ["1"] });
  });

  it("reads page 1 and the last page of a long history, oldest first", async () => {
    expect(await events(300)).toEqual({ ids: [...range(1, 100), ...range(201, 300)], pages: ["1", "3"] });
  });

  it("reads the page before a short last page, in at most three requests", async () => {
    expect(await events(1205)).toEqual({ ids: [...range(1101, 1200), ...range(1201, 1205)], pages: ["1", "13", "12"] });
  });

  it("reads both pages of a two-page history", async () => {
    expect(await events(105)).toEqual({ ids: range(1, 105), pages: ["1", "2"] });
  });
});

const pr = (number: number, ref: string, body: string | null = null): GitHubPull => ({ number, title: `PR ${number}`, body, head: { ref, sha: "abc" } }) as GitHubPull;

describe("matchOpenPullForIssue", () => {
  it("matches the branch prefix for the issue", () => {
    expect(matchOpenPullForIssue([pr(1, "main-x"), pr(2, "cos/issue-12-fix-login")], 12, "cos/")?.number).toBe(2);
  });

  it.each(["Closes #12", "fixes #12", "Resolved #12", "This PR closed #12 for good", "FIX #12"])("matches the body %j", (body) => {
    expect(matchOpenPullForIssue([pr(3, "feature", body)], 12, "cos/")?.number).toBe(3);
  });

  it("returns null when nothing matches", () => {
    expect(matchOpenPullForIssue([pr(1, "feature", "unrelated")], 12, "cos/")).toBeNull();
    expect(matchOpenPullForIssue([], 12, "cos/")).toBeNull();
  });

  it("ignores a mention without a closing keyword", () => {
    expect(matchOpenPullForIssue([pr(1, "feature", "Related to #12, see also #12")], 12, "cos/")).toBeNull();
  });

  it("does not confuse #123 with #12, or issue-123- with issue-12-", () => {
    expect(matchOpenPullForIssue([pr(1, "cos/issue-123-other", "Closes #123")], 12, "cos/")).toBeNull();
  });

  it("tolerates a null body", () => {
    expect(matchOpenPullForIssue([pr(1, "feature", null)], 12, "cos/")).toBeNull();
  });
});

describe("GitHubClient.listOpenPulls", () => {
  function client(pages: number) {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (page < pages) headers.link = `<https://api.github.com/repos/acme/app/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page + 1}>; rel="next"`;
      return new Response(JSON.stringify([pr(page, `branch-${page}`)]), { status: 200, headers });
    }) as typeof fetch;
    return { github: new GitHubClient({ token: "t", fetch: fetchImpl }), urls };
  }

  it("asks for the newest open PRs first", async () => {
    const { github, urls } = client(1);
    await github.listOpenPulls("acme", "app");
    expect(urls).toHaveLength(1);
    const query = new URL(urls[0]!).searchParams;
    expect(query.get("state")).toBe("open");
    expect(query.get("sort")).toBe("created");
    expect(query.get("direction")).toBe("desc");
  });

  it("follows the next link and stops after 5 pages", async () => {
    const { github, urls } = client(9);
    const pulls = await github.listOpenPulls("acme", "app");
    expect(urls).toHaveLength(5);
    expect(pulls).toHaveLength(5);
  });
});

describe("reduceReviews", () => {
  const review = (login: string, state: Review["state"], at: string): Review => ({ user: { login }, state, submitted_at: at });

  it("keeps each reviewer's latest verdict", () => {
    expect(reduceReviews([review("a", "CHANGES_REQUESTED", "1"), review("a", "APPROVED", "2")])).toBe("approved");
    expect(reduceReviews([review("a", "APPROVED", "1"), review("a", "CHANGES_REQUESTED", "2")])).toBe("changes_requested");
  });

  it("lets a dismissal clear that reviewer's earlier verdict", () => {
    expect(reduceReviews([review("a", "CHANGES_REQUESTED", "1"), review("a", "DISMISSED", "2")])).toBeNull();
    expect(reduceReviews([review("a", "CHANGES_REQUESTED", "1"), review("a", "DISMISSED", "2"), review("b", "APPROVED", "3")])).toBe("approved");
  });

  it("ignores comments, pending reviews and reviews without a user", () => {
    expect(reduceReviews([review("a", "APPROVED", "1"), review("a", "COMMENTED", "2"), review("a", "PENDING", "3")])).toBe("approved");
    expect(reduceReviews([{ user: null, state: "CHANGES_REQUESTED", submitted_at: "1" }])).toBeNull();
    expect(reduceReviews([review("a", "COMMENTED", "1")])).toBeNull();
  });

  it("lets requested changes outweigh another reviewer's approval", () => {
    expect(reduceReviews([review("a", "APPROVED", "1"), review("b", "CHANGES_REQUESTED", "2")])).toBe("changes_requested");
  });
});

describe("prStateFrom", () => {
  const at = new Date("2026-11-13T10:00:00Z");
  const pr = (over: Partial<GitHubPull> = {}) => ({ number: 7, state: "open", draft: false, merged: false, merged_at: null, ...over }) as GitHubPull;

  it("reads open, draft, merged and closed", () => {
    expect(prStateFrom(pr(), at)).toEqual({ number: 7, state: "open", draft: false, checks: null, review: null, checkedAt: at.toISOString() });
    expect(prStateFrom(pr({ draft: true }), at)).toMatchObject({ state: "open", draft: true });
    expect(prStateFrom(pr({ state: "closed", merged: true, merged_at: "x" }), at)).toMatchObject({ state: "merged", checks: null, review: null });
    expect(prStateFrom(pr({ state: "closed" }), at)).toMatchObject({ state: "closed" });
  });

  it("records when GitHub merged or closed the PR, and nothing for an open one", () => {
    expect(prStateFrom(pr({ state: "closed", merged: true, merged_at: "2026-11-13T09:00:00Z", closed_at: "2026-11-13T09:00:00Z" }), at).closedAt).toBe("2026-11-13T09:00:00Z");
    expect(prStateFrom(pr({ state: "closed", closed_at: "2026-11-13T08:00:00Z" }), at).closedAt).toBe("2026-11-13T08:00:00Z");
    expect(prStateFrom(pr({ closed_at: "2026-11-13T08:00:00Z" }), at)).not.toHaveProperty("closedAt");
    expect(prStateFrom(pr({ state: "closed" }), at)).not.toHaveProperty("closedAt");
  });

  it("treats a merge time as merged when the list endpoint omits `merged`", () => {
    const listed = { number: 7, state: "closed", draft: false, merged_at: "2026-11-13T09:00:00Z" } as unknown as GitHubPull;
    expect(prStateFrom(listed, at).state).toBe("merged");
  });

  it("carries checks and review for an open PR only", () => {
    expect(prStateFrom(pr(), at, { state: "no_checks", failed: [], total: 0 }, "approved")).toMatchObject({ checks: "none", review: "approved" });
    expect(prStateFrom(pr(), at, { state: "failing", failed: [], total: 1 }, null)).toMatchObject({ checks: "failing", review: null });
    expect(prStateFrom(pr({ state: "closed", merged: true }), at, { state: "failing", failed: [], total: 1 }, "approved")).toMatchObject({ checks: null, review: null });
  });
});
