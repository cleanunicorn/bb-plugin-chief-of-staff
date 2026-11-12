// Minimal GitHub REST client over fetch. The token is held in a closure and
// never appears in logs, errors, or returned values.
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

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#userAgent = options.userAgent ?? "bb-plugin-chief-of-staff";
    this.#timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
    this.#limiter = options.limiter ?? new GitHubLimiter();
    this.#now = options.now ?? Date.now;
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
    return results;
  }

  getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request("GET", `/repos/${owner}/${repo}`);
  }

  async listOpenIssues(owner: string, repo: string, filter: { labels?: string[]; milestone?: string; assignee?: string }): Promise<GitHubIssue[]> {
    const params = new URLSearchParams({ state: "open" });
    if (filter.labels?.length) params.set("labels", filter.labels.join(","));
    if (filter.assignee) params.set("assignee", filter.assignee);
    if (filter.milestone) {
      const milestones = await this.paginate<{ number: number; title: string }>(`/repos/${owner}/${repo}/milestones?state=all`);
      const match = milestones.find((m) => m.title === filter.milestone);
      if (!match) return [];
      params.set("milestone", String(match.number));
    }
    const issues = await this.paginate<GitHubIssue>(`/repos/${owner}/${repo}/issues?${params.toString()}`);
    return issues.filter((issue) => !issue.pull_request);
  }

  getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    return this.request("GET", `/repos/${owner}/${repo}/issues/${number}`);
  }

  listIssueComments(owner: string, repo: string, number: number): Promise<GitHubComment[]> {
    return this.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`, 3);
  }

  createIssueComment(owner: string, repo: string, number: number, body: string): Promise<GitHubComment> {
    return this.request("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }

  listOpenPulls(owner: string, repo: string): Promise<GitHubPull[]> {
    return this.paginate(`/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=asc`, 5);
  }

  async findOpenPullForIssue(owner: string, repo: string, issueNumber: number, branchPrefix: string): Promise<GitHubPull | null> {
    const pulls = await this.listOpenPulls(owner, repo);
    const closesRe = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i");
    return (
      pulls.find((pr) => pr.head.ref.startsWith(`${branchPrefix}issue-${issueNumber}-`) || closesRe.test(pr.body ?? "")) ?? null
    );
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

  async listCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]> {
    const result = await this.request<{ check_runs: CheckRun[] }>("GET", `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`);
    return result.check_runs;
  }

  getCombinedStatus(owner: string, repo: string, ref: string): Promise<CombinedStatus> {
    return this.request("GET", `/repos/${owner}/${repo}/commits/${ref}/status`);
  }

  async ciSummary(owner: string, repo: string, ref: string): Promise<CiSummary> {
    const [checks, status] = await Promise.all([this.listCheckRuns(owner, repo, ref), this.getCombinedStatus(owner, repo, ref)]);
    const failed = checks
      .filter((c) => c.status === "completed" && c.conclusion && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion))
      .map((c) => ({ name: c.name, url: c.html_url, runId: runIdFromUrl(c.html_url ?? c.details_url ?? "") }));
    const pending = checks.some((c) => c.status !== "completed") || status.state === "pending";
    const total = checks.length + status.total_count;
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
