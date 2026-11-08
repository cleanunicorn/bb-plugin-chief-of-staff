// Step reports: how an agent tells Chief of Staff it finished a workflow step.
// Preferred path is the cos_report agent tool; providers without plugin tools
// end their message with a "## Step report" block, parsed here.
import type { ReportOutcome, StepReport } from "./machine";

export const REPORT_OUTCOMES: ReportOutcome[] = ["done", "failed", "needs_input"];

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
  const field = (name: string) => new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**\\s*:\\s*(.*)$`, "im").exec(block)?.[1]?.trim().replace(/^[`"']|[`"']$/g, "") ?? null;
  const step = (field("step") ?? field("stage"))?.toLowerCase();
  const outcome = ALIASES[field("outcome")?.toLowerCase().replace(/[\s-]+/g, "_") ?? ""];
  if (!step || !outcome) return null;
  // The summary runs from its label to the end of the block (it may span lines).
  const summaryStart = /^\s*[-*]?\s*\**summary\**\s*:\s*/im.exec(block);
  const summary = summaryStart ? block.slice(summaryStart.index + summaryStart[0].length).trim() : "";
  const question = field("question");
  const choice = field("choice");
  // Fall back to the message before the block when the summary is empty.
  const body = summary || text.slice(0, last.index).trim().slice(-8000);
  return { step, outcome, summary: body, question: question || null, ...(choice ? { choice } : {}), at, via: "text" };
}
