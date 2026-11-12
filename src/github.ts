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

export interface GitHubClientOptions {
  token: string | null;
  fetch?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
}

export class GitHubClient {
  readonly #token: string | null;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #userAgent: string;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#userAgent = options.userAgent ?? "bb-plugin-chief-of-staff";
  }

  get hasToken(): boolean {
    return Boolean(this.#token);
  }

  async request<T>(method: string, path: string, body?: unknown, opts: { accept?: string; raw?: boolean } = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.#baseUrl}${path}`;
    const headers: Record<string, string> = {
      accept: opts.accept ?? "application/vnd.github+json",
      "user-agent": this.#userAgent,
      "x-github-api-version": "2022-11-28",
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.#fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "follow" });
    if (!response.ok) {
      let detail = "";
      try {
        const text = await response.text();
        detail = text.slice(0, 500);
      } catch {
        /* ignore */
      }
      // Strip the token defensively should GitHub ever echo headers back.
      const safeDetail = this.#token ? detail.split(this.#token).join("<redacted>") : detail;
      throw new GitHubError(`GitHub ${method} ${path} failed with ${response.status}: ${safeDetail}`, response.status, path);
    }
    if (response.status === 204 || response.status === 202) return undefined as T;
    if (opts.raw) return (await response.text()) as T;
    return (await response.json()) as T;
  }

  async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    let pages = 0;
    while (url && pages < maxPages) {
      const full: string = url.startsWith("http") ? url : `${this.#baseUrl}${url}`;
      const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": this.#userAgent, "x-github-api-version": "2022-11-28" };
      if (this.#token) headers.authorization = `Bearer ${this.#token}`;
      const response = await this.#fetch(full, { headers });
      if (!response.ok) throw new GitHubError(`GitHub GET ${url} failed with ${response.status}`, response.status, url);
      results.push(...((await response.json()) as T[]));
      const link = response.headers.get("link") ?? "";
      const next = /<([^>]+)>;\s*rel="next"/.exec(link);
      url = next ? next[1] : null;
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

  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<GitHubComment> {
    return this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
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

function runIdFromUrl(url: string): number | null {
  const match = /\/actions\/runs\/(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

/** Remove a token from any string before it reaches a log. */
export function redact(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join("<redacted>");
}
