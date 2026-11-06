// Agent tools: the stage report every workflow agent files, the roster, and
// starting a task from a conversation.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Cos } from "./context";
import { buildRoster } from "./roster";
import { REPORT_OUTCOMES } from "./report";
import { roleOf } from "./sync";
import { startTask } from "./intake";
import type { ReportOutcome } from "./state";
import { STAGE_LABEL, STAGES, type Stage } from "./workflow";

const ALLOWED: Record<Stage, ReportOutcome[]> = {
  plan: ["done", "needs_input"],
  build: ["done", "needs_input"],
  verify: ["done", "failed", "needs_input"],
  review: ["done", "changes_requested", "needs_input"],
  ship: ["done", "needs_input"],
};

export function registerTools(bb: BbPluginApi, cos: Cos): void {
  bb.agents.registerTool({
    name: "cos_report",
    description:
      "Report to Chief of Staff that you finished the current workflow stage (plan, build, verify, review, ship), or that you need a human decision. Chief of Staff moves the task to the next stage when your turn ends. Only for threads Chief of Staff started.",
    parameters: z.object({
      stage: z.enum(STAGES).describe("The stage you are reporting on (Chief of Staff named it in your prompt)"),
      outcome: z.enum(REPORT_OUTCOMES as [ReportOutcome, ...ReportOutcome[]]).describe('"done"; verify may be "failed"; review may be "changes_requested"; "needs_input" when a person must decide'),
      summary: z.string().min(1).max(40_000).describe("Stage result in Markdown: the plan, what changed, the evidence, the review findings, or the PR description"),
      question: z.string().max(4_000).optional().describe('With outcome "needs_input": the question for the human'),
    }),
    async execute(params, ctx) {
      const item = cos.store.getWorkItemByThread(ctx.threadId);
      if (!item) return { content: [{ type: "text", text: "This thread is not tracked by Chief of Staff; nothing to report." }], isError: true };
      const role = roleOf(item, ctx.threadId);
      if (item.stage === "done") return "This task is already finished.";
      if (params.stage !== item.stage) {
        return { content: [{ type: "text", text: `Chief of Staff has this task in the ${STAGE_LABEL[item.stage]} stage, not ${STAGE_LABEL[params.stage]}. Report stage "${item.stage}".` }], isError: true };
      }
      if (item.stage === "review" && role === "builder" && item.reviewThreadId) {
        return { content: [{ type: "text", text: "The review stage is reported by the reviewer thread, not the builder." }], isError: true };
      }
      if (!ALLOWED[params.stage].includes(params.outcome)) {
        return { content: [{ type: "text", text: `Outcome "${params.outcome}" is not valid for ${STAGE_LABEL[params.stage]}; use one of: ${ALLOWED[params.stage].join(", ")}.` }], isError: true };
      }
      if (params.outcome === "needs_input" && !params.question?.trim()) {
        return { content: [{ type: "text", text: 'With outcome "needs_input", put the question for the human in `question`.' }], isError: true };
      }
      cos.store.updateWorkItem(item.id, {
        pendingReport: { stage: params.stage, outcome: params.outcome, summary: params.summary, question: params.question ?? null, at: cos.now().toISOString(), via: "tool" },
        lastActivityAt: cos.now().toISOString(),
      });
      cos.store.log({ level: "info", kind: "report", repo: item.repo, workItemId: item.id, message: `${role ?? "agent"} reported ${params.stage}: ${params.outcome}`, actor: `tool:${ctx.threadId}` });
      cos.invalidate();
      return params.outcome === "needs_input"
        ? "Recorded. End your turn; your question goes to a human and their answer comes back to this thread."
        : `Recorded ${STAGE_LABEL[params.stage]}: ${params.outcome}. End your turn now; Chief of Staff takes it from here.`;
    },
  });

  bb.agents.registerTool({
    name: "chief_of_staff_status",
    description: "Roster of agent threads the Chief of Staff plugin runs: workflow stage, who holds the ball (agent, Chief of Staff, human), repo, issue, PR, activity.",
    parameters: z.object({
      repo: z.string().optional().describe("Limit to one owner/repo"),
      includeDone: z.boolean().default(false).describe("Include finished and failed items"),
    }),
    async execute(params) {
      const entries = await buildRoster(cos, { repo: params.repo, includeDone: params.includeDone });
      const lines = entries.map(
        (e) =>
          `- [${e.stage}/${e.actor}] ${e.repo}${e.issueNumber ? `#${e.issueNumber}` : ""} "${e.issueTitle}": ${e.activity}${e.stalled ? " (stalled)" : ""}${e.prNumber ? ` PR #${e.prNumber}` : ""} thread=${e.threadId ?? "-"}${e.reviewThreadId ? ` reviewer=${e.reviewThreadId}` : ""} id=${e.id}${e.waitingReason ? ` waiting_on="${e.waitingReason.slice(0, 200)}"` : ""}`,
      );
      const text = [`${entries.length} tracked item(s)`, ...lines];
      return text.join("\n").slice(0, 20_000);
    },
  });

  bb.agents.registerTool({
    name: "cos_start_task",
    description: "Hand a task to Chief of Staff: it starts an agent on a configured repository and takes the task through the workflow (plan, build, verify, review, ship). Use when the user asks to delegate work to Chief of Staff.",
    parameters: z.object({
      repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/).describe("owner/repo, as configured in Chief of Staff"),
      title: z.string().min(1).max(200).describe("Short task title"),
      description: z.string().min(1).max(20_000).describe("What needs doing and why, with any acceptance criteria"),
    }),
    async execute(params, ctx) {
      const item = await startTask(cos, { repo: params.repo, title: params.title, body: params.description }, `tool:${ctx.threadId}`);
      if (!item) return { content: [{ type: "text", text: "Could not start the task." }], isError: true };
      return `Started "${params.title}" on ${params.repo} (item ${item.id}, stage ${item.stage}${item.threadId ? `, thread ${item.threadId}` : ""}). Track it with chief_of_staff_status.`;
    },
  });
}
