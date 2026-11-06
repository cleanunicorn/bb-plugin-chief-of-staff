// Stage reports: how the agent tells Chief of Staff a stage is finished.
// Preferred path is the cos_report agent tool; providers without plugin tools
// end their message with a "## Stage report" block, parsed here.
import type { ReportOutcome, StageReport } from "./state";
import { STAGES, type Stage } from "./workflow";

export const REPORT_OUTCOMES: ReportOutcome[] = ["done", "changes_requested", "failed", "needs_input"];

/** Parse a trailing "## Stage report" block. Null when absent or malformed. */
export function parseTextReport(text: string | null | undefined, at: string): StageReport | null {
  if (!text) return null;
  const heading = /^#{1,4}\s*Stage report\s*$/gim;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = heading.exec(text))) last = match;
  if (!last) return null;
  const block = text.slice(last.index + last[0].length).replace(/^\s*```\w*\s*$/gm, "");
  const field = (name: string) => new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**\\s*:\\s*(.*)$`, "im").exec(block)?.[1]?.trim().replace(/^[`"']|[`"']$/g, "") ?? null;
  const stage = field("stage")?.toLowerCase();
  const outcome = field("outcome")?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!stage || !STAGES.includes(stage as Stage)) return null;
  if (!outcome || !REPORT_OUTCOMES.includes(outcome as ReportOutcome)) return null;
  // The summary runs from its label to the end of the block (it may span lines).
  const summaryStart = /^\s*[-*]?\s*\**summary\**\s*:\s*/im.exec(block);
  const summary = summaryStart ? block.slice(summaryStart.index + summaryStart[0].length).trim() : "";
  const question = field("question");
  // Fall back to the message before the block when the summary is empty.
  const body = summary || text.slice(0, last.index).trim().slice(-8000);
  return { stage: stage as Stage, outcome: outcome as ReportOutcome, summary: body, question: question || null, at, via: "text" };
}
