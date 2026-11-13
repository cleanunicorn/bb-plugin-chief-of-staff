// Minimal GitHub REST client over fetch. The token is held in a closure and
// never appears in logs, errors, or returned values.
import type { PrState } from "./state";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  labels: { name: string }[];
  milestone: { title: string } | null;
  assignees: { login: string }[];
  pull_request?: unknown;
  updated_at: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
}

export interface GitHubPull {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels: { name: string }[];
  created_at: string;
  updated_at: string;
  mergeable: boolean | null;
  mergeable_state?: string;
  user: { login: string } | null;
}

export interface GitHubRepo {
  default_branch: string;
  full_name: string;
}

export interface CombinedStatus {
  state: "success" | "failure" | "pending" | "error";
  total_count: number;
}

export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  html_url: string;
  details_url?: string;
}

export interface Review {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  user: { login: string } | null;
  submitted_at: string;
}

export type CiSummary = { state: "passing" | "failing" | "pending" | "no_checks"; failed: { name: string; url: string; runId: number | null }[]; total: number };

/** The reviewers' verdict on a pull request: what the merge gate and the PR state show. */
export type ReviewVerdict = "approved" | "changes_requested" | null;

/**
 * Each reviewer's latest APPROVED, CHANGES_REQUESTED or DISMISSED review
 * decides; comments and pending reviews do not, and a dismissal clears that
 * reviewer's earlier verdict. Any requested changes outweigh approvals.
 * Reviews come oldest first, as GitHub lists them.
 */
export function reduceReviews(reviews: readonly Review[]): ReviewVerdict {
  const latest = new Map<string, Review["state"]>();
  for (const review of reviews) {
    if (!review.user || review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.user.login, review.state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  return states.includes("APPROVED") ? "approved" : null;
}

/**
 * A PrState from a pull request read from GitHub, with its CI and review
 * verdict when they were read (they are kept for open PRs only). List
 * endpoints can omit `merged`, so a merge time also counts.
 */
export function prStateFrom(pr: Pick<GitHubPull, "number" | "state" | "draft" | "merged" | "merged_at">, now: Date, ci?: CiSummary, review?: ReviewVerdict): PrState {
  const state = pr.merged || pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open";
  const open = state === "open";
  return {
    number: pr.number,
    state,
    draft: Boolean(pr.draft),
    checks: open && ci ? (ci.state === "no_checks" ? "none" : ci.state) : null,
    review: open ? (review ?? null) : null,
    checkedAt: now.toISOString(),
  };
}

/** The open PR that already covers an issue: its branch is the issue's, or its body closes the issue. */
export function matchOpenPullForIssue(pulls: GitHubPull[], issueNumber: number, branchPrefix: string): GitHubPull | null {
  const closesRe = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i");
  return pulls.find((pr) => pr.head.ref.startsWith(`${branchPrefix}issue-${issueNumber}-`) || closesRe.test(pr.body ?? "")) ?? null;
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
    this.name = "GitHubError";
  }
}

/** GitHub refused, or would refuse, a request for a rate limit; nothing was done. */
export class GitHubRateLimitError extends GitHubError {
  constructor(message: string, url: string, readonly resetAt: Date) {
    super(message, 429, url);
    this.name = "GitHubRateLimitError";
  }
}

/** "14:05 UTC (in 23 min)": when a rate limit resets, for logs and warnings. */
export function describeReset(until: Date, now: Date): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  return `${until.toISOString().slice(11, 16)} UTC (in ${minutes} min)`;
}

/** A catch handler that falls back on any error but a rate limit, which it passes on. */
export function unlessRateLimited<T>(fallback: () => T): (error: unknown) => T {
  return (error) => {
    if (error instanceof GitHubRateLimitError) throw error;
    return fallback();
  };
}

/** Bounds on how long a rate limit pauses GitHub work. */
const MIN_LIMIT_MS = 30_000;
const MAX_LIMIT_MS = 60 * 60_000;
/** GitHub's advice when a secondary limit names no reset time. */
const DEFAULT_LIMIT_MS = 60_000;

/**
 * The rate limit in force for one token, shared by every client built for
 * it, so a limit one request hit pauses all of them until the reset.
 * In memory only: after a restart the first request finds it again.
 */
export class GitHubLimiter {
  #until: number | null = null;
  #reason = "";

  /** @param onLimit called once per limit episode (not again while one is in force). */
  constructor(private readonly onLimit?: (until: Date, reason: string) => void) {}

  /** The limit in force at `now`, or null. A limit ends exactly at its reset time. */
  limitedUntil(now: number): { until: Date; reason: string } | null {
    return this.#until !== null && now < this.#until ? { until: new Date(this.#until), reason: this.#reason } : null;
  }

  record(until: number, reason: string, now: number): void {
    const fresh = this.limitedUntil(now) === null;
    this.#until = fresh ? until : Math.max(this.#until!, until);
    this.#reason = reason;
    if (fresh) this.onLimit?.(new Date(this.#until), reason);
  }

  clear(): void {
    this.#until = null;
    this.#reason = "";
  }
}

export interface GitHubClientOptions {
  token: string | null;
  fetch?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
  /** Per-request deadline, headers and body included. */
  timeoutMs?: number;
  /** Shared rate-limit state (one per token); a private one by default. */
  limiter?: GitHubLimiter;
  now?: () => number;
  /** Where the client reports things worth a warning (a truncated list). */
  log?: (message: string) => void;
}

/** Default per-request deadline. */
export const GITHUB_TIMEOUT_MS = 30_000;

/** One response, body already read (inside the request's deadline). */
interface Sent {
  status: number;
  headers: Headers;
  text: string;
}

export class GitHubClient {
  readonly #token: string | null;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #limiter: GitHubLimiter;
  readonly #now: () => number;
  readonly #log: (message: string) => void;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#userAgent = options.userAgent ?? "bb-plugin-chief-of-staff";
    this.#timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
    this.#limiter = options.limiter ?? new GitHubLimiter();
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => undefined);
  }

  get hasToken(): boolean {
    return Boolean(this.#token);
  }

  /** The path to name in errors: relative to the API base when it is under it. */
  #display(pathOrUrl: string): string {
    return pathOrUrl.startsWith(this.#baseUrl) ? pathOrUrl.slice(this.#baseUrl.length) || "/" : pathOrUrl;
  }

  /**
   * The one way a request reaches GitHub: headers, a deadline covering the
   * body read, and one error format (status, redacted body detail).
   */
  async #send(method: string, pathOrUrl: string, opts: { body?: unknown; accept?: string } = {}): Promise<Sent> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.#baseUrl}${pathOrUrl}`;
    const path = this.#display(pathOrUrl);
    const headers: Record<string, string> = {
      accept: opts.accept ?? "application/vnd.github+json",
      "user-agent": this.#userAgent,
      "x-github-api-version": "2022-11-28",
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    // While a limit is in force, fail fast: another request would only extend it.
    const active = this.#limiter.limitedUntil(this.#now());
    if (active) throw new GitHubRateLimitError(`GitHub ${method} ${path} not sent: ${active.reason} until ${active.until.toISOString()}`, path, active.until);
    let sent: Sent;
    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: "follow",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      let text = "";
      try {
        text = await response.text();
      } catch (error) {
        // A failed body read of an error response only loses its detail.
        if (response.ok || isAbort(error)) throw error;
      }
      sent = { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (isAbort(error)) throw new GitHubError(`GitHub ${method} ${path} timed out after ${this.#timeoutMs >= 1000 ? `${Math.round(this.#timeoutMs / 1000)}s` : `${this.#timeoutMs}ms`}`, 0, path);
      throw new GitHubError(redact(`GitHub ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`, this.#token), 0, path);
    }
    const limit = rateLimit(sent, this.#now());
    if (limit && (sent.status === 403 || sent.status === 429)) {
      this.#limiter.record(limit.until, limit.reason, this.#now());
      throw new GitHubRateLimitError(`GitHub ${method} ${path} hit the ${limit.reason} (${sent.status}); GitHub work waits until ${new Date(limit.until).toISOString()}`, path, new Date(limit.until));
    }
    // The window is used up (this response still counts): wait for the reset rather than draw a 403.
    if (limit) this.#limiter.record(limit.until, limit.reason, this.#now());
    if (sent.status < 200 || sent.status >= 300) {
      // Strip the token defensively should GitHub ever echo headers back.
      throw new GitHubError(`GitHub ${method} ${path} failed with ${sent.status}: ${redact(sent.text.slice(0, 500), this.#token)}`, sent.status, path);
    }
    return sent;
  }

  async request<T>(method: string, path: string, body?: unknown, opts: { accept?: string; raw?: boolean } = {}): Promise<T> {
    const sent = await this.#send(method, path, { body, accept: opts.accept });
    if (sent.status === 204 || sent.status === 202) return undefined as T;
    if (opts.raw) return sent.text as T;
    return JSON.parse(sent.text) as T;
  }

  async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    let pages = 0;
    while (url && pages < maxPages) {
      const sent = await this.#send("GET", url);
      results.push(...(JSON.parse(sent.text) as T[]));
      url = linkUrl(sent.headers, "next");
      pages += 1;
    }
    if (url) this.#log(`GitHub list ${path} truncated at ${maxPages} page${maxPages === 1 ? "" : "s"}`);
    return results;
  }

  getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request("GET", `/repos/${owner}/${repo}`);
  }

  async listOpenIssues(owner: string, repo: string, filter: { labels?: string[]; assignee?: string }): Promise<GitHubIssue[]> {
    const params = new URLSearchParams({ state: "open" });
    if (filter.labels?.length) params.set("labels", filter.labels.join(","));
    if (filter.assignee) params.set("assignee", filter.assignee);
    const issues = await this.paginate<GitHubIssue>(`/repos/${owner}/${repo}/issues?${params.toString()}`);
    return issues.filter((issue) => !issue.pull_request);
  }

  getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    return this.request("GET", `/repos/${owner}/${repo}/issues/${number}`);
  }

  /**
   * Scan up to three pages, oldest first, for status-comment recovery.
   * With `newest`, fetch only the latest comments for a task brief instead:
   * page 1, the last page, and the one before it when the last is short.
   * Both modes make at most three requests.
   */
  async listIssueComments(owner: string, repo: string, number: number, opts: { newest?: number } = {}): Promise<GitHubComment[]> {
    if (opts.newest === undefined) return this.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`, 3);
    const newest = Math.max(1, Math.min(100, opts.newest));
    const first = await this.#send("GET", `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
    const pages = [JSON.parse(first.text) as GitHubComment[]];
    const last = linkUrl(first.headers, "last");
    const lastPage = last ? Number(new URL(last).searchParams.get("page")) : 1;
    if (last && lastPage > 1) {
      const tail = JSON.parse((await this.#send("GET", last)).text) as GitHubComment[];
      if (tail.length < newest && lastPage > 2) {
        const before = new URL(last);
        before.searchParams.set("page", String(lastPage - 1));
        pages[0] = JSON.parse((await this.#send("GET", before.toString())).text) as GitHubComment[];
      }
      pages.push(tail);
    }
    return pages.flat().slice(-newest);
  }

  createIssueComment(owner: string, repo: string, number: number, body: string): Promise<GitHubComment> {
    return this.request("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }

  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GitHubComment> {
    return this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  }

  /** The newest open PRs first, capped at 5 pages (500), so the PRs Chief of Staff opened recently are always seen. */
  listOpenPulls(owner: string, repo: string): Promise<GitHubPull[]> {
    return this.paginate(`/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=desc`, 5);
  }

  async findPullByHead(owner: string, repo: string, head: string): Promise<GitHubPull | null> {
    const pulls = await this.paginate<GitHubPull>(`/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}`, 1);
    return pulls[0] ?? null;
  }

  getPull(owner: string, repo: string, number: number): Promise<GitHubPull> {
    return this.request("GET", `/repos/${owner}/${repo}/pulls/${number}`);
  }

  createPull(owner: string, repo: string, input: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<GitHubPull> {
    return this.request("POST", `/repos/${owner}/${repo}/pulls`, input);
  }

  requestReviewers(owner: string, repo: string, number: number, reviewers: string[], teamReviewers: string[]): Promise<unknown> {
    return this.request("POST", `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, { reviewers, team_reviewers: teamReviewers });
  }

  listReviews(owner: string, repo: string, number: number): Promise<Review[]> {
    return this.paginate(`/repos/${owner}/${repo}/pulls/${number}/reviews`, 2);
  }

  /**
   * Every check run on a ref, up to `maxPages` pages of 100. `complete` is
   * false when the list stopped at the cap or holds fewer runs than GitHub
   * counts, so a caller never takes a partial list for the whole.
   */
  async listCheckRuns(owner: string, repo: string, ref: string, maxPages = 10): Promise<{ runs: CheckRun[]; total: number; complete: boolean }> {
    const path = `/repos/${owner}/${repo}/commits/${ref}/check-runs`;
    const runs: CheckRun[] = [];
    let total = 0;
    let url: string | null = `${path}?per_page=100`;
    let pages = 0;
    while (url && pages < maxPages) {
      const sent = await this.#send("GET", url);
      const page = JSON.parse(sent.text) as { total_count?: number; check_runs: CheckRun[] };
      runs.push(...page.check_runs);
      total = Math.max(total, page.total_count ?? 0);
      url = linkUrl(sent.headers, "next");
      pages += 1;
    }
    if (url) this.#log(`GitHub list ${path} truncated at ${maxPages} page${maxPages === 1 ? "" : "s"}`);
    return { runs, total: Math.max(total, runs.length), complete: !url && runs.length >= total };
  }

  getCombinedStatus(owner: string, repo: string, ref: string): Promise<CombinedStatus> {
    return this.request("GET", `/repos/${owner}/${repo}/commits/${ref}/status`);
  }

  async ciSummary(owner: string, repo: string, ref: string): Promise<CiSummary> {
    const [list, status] = await Promise.all([this.listCheckRuns(owner, repo, ref), this.getCombinedStatus(owner, repo, ref)]);
    const checks = list.runs;
    const failed = checks
      .filter((c) => c.status === "completed" && c.conclusion && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion))
      .map((c) => ({ name: c.name, url: c.html_url, runId: runIdFromUrl(c.html_url ?? c.details_url ?? "") }));
    // A run past the pages read may still be running or red: never call a partial list green.
    const pending = !list.complete || checks.some((c) => c.status !== "completed") || status.state === "pending";
    const total = list.total + status.total_count;
    if (total === 0) return { state: "no_checks", failed: [], total: 0 };
    if (failed.length || status.state === "failure" || status.state === "error") return { state: "failing", failed, total };
    if (pending) return { state: "pending", failed: [], total };
    return { state: "passing", failed: [], total };
  }

  /** Download the plain-text log of a failed workflow job (bounded tail). */
  async getJobLogsForRun(owner: string, repo: string, runId: number, maxChars = 20_000): Promise<string> {
    const jobs = await this.request<{ jobs: { id: number; name: string; conclusion: string | null }[] }>("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=50`);
    const failing = jobs.jobs.filter((j) => j.conclusion && j.conclusion !== "success" && j.conclusion !== "skipped");
    const chunks: string[] = [];
    for (const job of failing.slice(0, 3)) {
      try {
        const text = await this.request<string>("GET", `/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`, undefined, { raw: true, accept: "text/plain" });
        chunks.push(`### Job: ${job.name}\n${text.slice(-Math.floor(maxChars / Math.max(1, Math.min(3, failing.length))))}`);
      } catch (error) {
        if (error instanceof GitHubRateLimitError) throw error;
        chunks.push(`### Job: ${job.name}\n(log unavailable: ${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return chunks.join("\n\n").slice(-maxChars);
  }

  mergePull(owner: string, repo: string, number: number, method: "merge" | "squash" | "rebase", sha?: string): Promise<{ merged: boolean; message: string; sha?: string }> {
    return this.request("PUT", `/repos/${owner}/${repo}/pulls/${number}/merge`, { merge_method: method, sha });
  }

  async getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    try {
      const result = await this.request<{ content?: string; encoding?: string }>("GET", `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
      if (!result.content) return null;
      return Buffer.from(result.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }
}

/** A URL from a Link header (`rel="next"`, `rel="last"`), or null. */
function linkUrl(headers: Headers, rel: string): string | null {
  const match = new RegExp(`<([^>]+)>;\\s*rel="${rel}"`).exec(headers.get("link") ?? "");
  return match ? match[1]! : null;
}

/**
 * Whether a response says a rate limit is in force, and until when (GitHub
 * REST docs, "Rate limits for the REST API"):
 * - 429, or 403 with `retry-after`, `x-ratelimit-remaining: 0`, or a body
 *   naming a secondary rate limit (a plain 403 is a permission error);
 * - any response with `x-ratelimit-remaining: 0` (the window is used up).
 * Reset: `retry-after` seconds, else `x-ratelimit-reset` when the window is
 * used up, else one minute; clamped to [30 s, 1 h].
 */
function rateLimit(sent: Sent, now: number): { until: number; reason: string } | null {
  const retryAfter = sent.headers.get("retry-after");
  const exhausted = sent.headers.get("x-ratelimit-remaining") === "0";
  const limited =
    exhausted ||
    sent.status === 429 ||
    (sent.status === 403 && (retryAfter !== null || /secondary rate limit/i.test(sent.text)));
  if (!limited) return null;
  const reset = Number(sent.headers.get("x-ratelimit-reset"));
  let until = now + DEFAULT_LIMIT_MS;
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) until = now + Number(retryAfter) * 1000;
  else if (exhausted && Number.isFinite(reset) && reset > 0) until = reset * 1000;
  return {
    until: Math.min(now + MAX_LIMIT_MS, Math.max(now + MIN_LIMIT_MS, until)),
    reason: exhausted ? "GitHub API rate limit" : "GitHub secondary rate limit",
  };
}

/** The fetch was cut by its deadline (or aborted). */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function runIdFromUrl(url: string): number | null {
  const match = /\/actions\/runs\/(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

/** Remove a token from any string before it reaches a log. */
export function redact(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join("<redacted>");
}
