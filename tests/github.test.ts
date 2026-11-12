import { describe, expect, it } from "vitest";
import { GitHubClient, matchOpenPullForIssue, type GitHubPull } from "../src/github";

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
