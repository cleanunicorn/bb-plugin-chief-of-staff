// The GitHub client on its own: deadlines, error format, rate limits and the
// newest-comments fetch, against a fake fetch.
import { describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, GitHubLimiter, GitHubRateLimitError } from "../src/github";

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
