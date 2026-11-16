// Step reports: how an agent tells Chief of Staff it finished a workflow step.
// Preferred path is the cos_report agent tool; providers without plugin tools
// end their message with a "## Step report" block, parsed here.
import type { ReportOutcome, StepReport } from "./machine";

export const REPORT_OUTCOMES: ReportOutcome[] = ["done", "failed", "needs_input", "resolved"];

const ALIASES: Record<string, ReportOutcome> = {
  done: "done",
  pass: "done",
  passed: "done",
  approve: "done",
  approved: "done",
  failed: "failed",
  fail: "failed",
  changes_requested: "failed",
  needs_input: "needs_input",
  resolved: "resolved",
  already_resolved: "resolved",
  already_done: "resolved",
};

/** Parse a trailing "## Step report" (or legacy "## Stage report") block. Null when absent or malformed. */
export function parseTextReport(text: string | null | undefined, at: string): (StepReport & { step: string }) | null {
  if (!text) return null;
  const heading = /^#{1,4}\s*(?:Step|Stage) report\s*$/gim;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = heading.exec(text))) last = match;
  if (!last) return null;
  const block = text.slice(last.index + last[0].length).replace(/^\s*```\w*\s*$/gm, "");
  const fieldIn = (part: string, name: string) => new RegExp(`^\\s*[-*]?\\s*\\**(?:${name})\\**\\s*:\\s*(.*)$`, "im").exec(part)?.[1]?.trim().replace(/^[`"']|[`"']$/g, "") ?? null;
  const field = (name: string) => fieldIn(block, name);
  const step = (field("step") ?? field("stage"))?.toLowerCase();
  const outcome = ALIASES[field("outcome")?.toLowerCase().replace(/[\s-]+/g, "_") ?? ""];
  if (!step || !outcome) return null;
  // The summary runs from its label to the end of the block (it may span lines).
  const summaryStart = /^\s*[-*]?\s*\**summary\**\s*:\s*/im.exec(block);
  const summary = summaryStart ? block.slice(summaryStart.index + summaryStart[0].length).trim() : "";
  const question = field("question");
  const choice = field("choice");
  // A model pick comes from its own lines above the summary, never from the summary's prose.
  const header = summaryStart ? block.slice(0, summaryStart.index) : block;
  const pick = { providerId: fieldIn(header, "providerId|provider"), model: fieldIn(header, "model"), reasoningLevel: fieldIn(header, "reasoningLevel|reasoning") };
  const resolvedBy = outcome === "resolved" ? parseResolvedBy(fieldIn(header, "resolvedPr|resolved_pr"), fieldIn(header, "resolvedCommit|resolved_commit")) : null;
  // Fall back to the message before the block when the summary is empty.
  const body = summary || text.slice(0, last.index).trim().slice(-8000);
  return { ...(field("delivery") ? { delivery: field("delivery")! } : {}), step, outcome, summary: body, question: question || null, ...(choice ? { choice } : {}), ...(pick.providerId || pick.model || pick.reasoningLevel ? { pick } : {}), ...(resolvedBy ? { resolvedBy } : {}), at, via: "text" };
}

/** A commit id as an agent may write it: 7 to 40 hex digits. */
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/** The evidence of a "resolved" report: "#920", "920" or a PR URL, and a hex commit id. Null when neither is usable. */
export function parseResolvedBy(pr: string | number | null | undefined, commit: string | null | undefined): { pr?: number; commit?: string } | null {
  // "#920", "920", "#920 (merged into main)" or a URL ending in /pull/920: the PR's URL number, else the first number.
  const text = pr?.toString().trim() ?? "";
  const prNumber = typeof pr === "number" ? pr : Number((/\/pull\/(\d+)/.exec(text) ?? /^#?(\d+)\b/.exec(text))?.[1] ?? NaN);
  const sha = commit?.trim();
  const out = { ...(Number.isInteger(prNumber) && prNumber > 0 ? { pr: prNumber } : {}), ...(sha && COMMIT_SHA.test(sha) ? { commit: sha.toLowerCase() } : {}) };
  return out.pr || out.commit ? out : null;
}
