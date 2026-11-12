// Agent tools: the step report every workflow agent files, the roster, and
// starting a task from a conversation.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Cos } from "./context";
import { buildRoster } from "./roster";
import { REPORT_OUTCOMES } from "./report";
import { threadContext } from "./sync";
import { startTask } from "./intake";
import type { ReportOutcome } from "./machine";
import { withItemLock } from "./delivery";
import { acknowledgeReport, deliveryWait, reportMatches, recoverSpawn } from "./deliveryReport";
import { chosenModel, pickedModel } from "./workflow";

export function registerTools(bb: BbPluginApi, cos: Cos): void {
  bb.agents.registerTool({
    name: "cos_report",
    description:
      "Tell Chief of Staff you finished your current workflow step, or need a human decision; then end your turn. Only for threads Chief of Staff started; your prompt names the step and delivery ids.",
    parameters: z.object({
      delivery: z.string().max(100).optional().describe("Delivery id from your current prompt"),
      step: z.string().min(1).max(40).describe("The step id from your prompt"),
      outcome: z.enum(REPORT_OUTCOMES as [ReportOutcome, ...ReportOutcome[]]).describe('"done"; "failed" on a pass/fail step that does not pass (or when you cannot finish); "needs_input" when a person must decide'),
      summary: z.string().min(1).max(40_000).describe("The step's result in Markdown (a plan, what changed, evidence, findings). The next steps read it."),
      question: z.string().max(4_000).optional().describe('With outcome "needs_input": the question for the human'),
      choice: z.string().max(40).optional().describe("Only when your prompt lists model choices: the id of the one you pick for the steps after this"),
      providerId: z.string().max(200).optional().describe("Only when your step chooses the model: the BB provider id you pick (from `bb provider list`)"),
      model: z.string().max(200).optional().describe("Only when your step chooses the model: the model id you pick (from `bb provider models <providerId>`)"),
      reasoningLevel: z.string().max(50).optional().describe("Only when your step chooses the model: the reasoning level you pick, if the model supports one"),
    }),
    async execute(params, ctx) {
      const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      const tracked = cos.store.getWorkItemByThread(ctx.threadId) ?? await recoverSpawn(cos, ctx.threadId);
      if (!tracked) return err("This thread is not tracked by Chief of Staff; nothing to report.");
      return withItemLock(tracked.id, async () => {
        const item = cos.store.getWorkItem(tracked.id);
        if (!item) return err("This thread is not tracked by Chief of Staff; nothing to report.");
        if (item.status === "failed") return err("This task has failed; retry it before reporting new work.");
        if (item.status === "done") return "This task is already finished.";
        const tc = threadContext(cos, item, ctx.threadId);
        if (!tc?.step) return err("Chief of Staff has no step running on this thread right now.");
        if (params.step !== tc.step.id) return err(`This thread is working on the step "${tc.step.id}" (${tc.step.name}), not "${params.step}". Report step "${tc.step.id}".`);
        const node = item.nodes[tc.step.id];
        // A step parked on this agent's question resumed (we may have missed the turn starting): its report counts.
        const resumed = node?.status === "waiting" && node.waiting && ["question", "no_report", "stalled"].includes(node.waiting.kind);
        if (node?.status !== "running" && !resumed && !deliveryWait(item, tc.step.id)) return err(`The step ${tc.step.name} is not running (it is ${node?.status ?? "unknown"}).`);
        if (params.outcome === "needs_input" && !params.question?.trim()) return err('With outcome "needs_input", put the question for the human in `question`.');
        if (tc.step.chooses.length && params.outcome === "done" && !chosenModel(tc.step, { reports: [{ choice: params.choice }] })) {
          return err(`This step picks a model: set \`choice\` to one of ${tc.step.chooses.map((c) => `"${c.id}"`).join(", ")}.`);
        }
        const pick = { providerId: params.providerId?.trim() || null, model: params.model?.trim() || null, reasoningLevel: params.reasoningLevel?.trim() || null };
        if (tc.step.picksModel && params.outcome === "done" && !pickedModel({ reports: [{ pick }] })) {
          return err("This step chooses the model: set `providerId` and `model` (and `reasoningLevel` if the model has levels) to what you pick.");
        }
        if (!reportMatches(cos, item, tc.step, tc.agent, ctx.threadId, params.delivery)) return err("This report is from an earlier or unconfirmed delivery. Use the delivery id from the current prompt.");
        await acknowledgeReport(cos, item, tc.step, tc.agent, ctx.threadId);
        const report = { ...(params.delivery ? { delivery: params.delivery } : {}), step: tc.step.id, round: node!.round, outcome: params.outcome, summary: params.summary, question: params.question ?? null, choice: params.choice?.trim() || null, ...(tc.step.picksModel ? { pick } : {}), at: cos.now().toISOString(), via: "tool" as const };
        if (tc.row) cos.store.updateThread(ctx.threadId, { pendingReport: report });
        else cos.store.upsertThread({ threadId: ctx.threadId, itemId: item.id, role: "builder", stepId: null, agent: 0, environmentId: item.environmentId, round: node!.round, promptSentAt: null, pendingReport: report });
        cos.store.updateWorkItem(item.id, { lastActivityAt: cos.now().toISOString() });
        cos.store.log({ level: "info", kind: "report", repo: item.repo, workItemId: item.id, message: `${tc.step.name}${tc.step.agents > 1 ? ` agent ${tc.agent + 1}` : ""} reported ${params.outcome}`, actor: `tool:${ctx.threadId}` });
        cos.invalidate();
        return params.outcome === "needs_input"
          ? "Recorded. End your turn; your question goes to a human and their answer comes back to this thread."
          : `Recorded ${tc.step.name}: ${params.outcome}. End your turn now; Chief of Staff takes it from here.`;
      });
    },
  });

  bb.agents.registerTool({
    name: "chief_of_staff_status",
    description: "Roster of tasks the Chief of Staff plugin runs: workflow and current steps, who holds the ball (agent, Chief of Staff, human), repo, issue, PR, activity.",
    parameters: z.object({
      repo: z.string().optional().describe("Limit to one owner/repo"),
      includeDone: z.boolean().default(false).describe("Include finished and failed items"),
    }),
    async execute(params) {
      const entries = await buildRoster(cos, { repo: params.repo, includeDone: params.includeDone });
      const lines = entries.map(
        (e) =>
          `- [${e.current.join(", ") || e.detail}/${e.actor}] ${e.repo}${e.issueNumber ? `#${e.issueNumber}` : ""} "${e.issueTitle}": ${e.activity}${e.stalled ? " (stalled)" : ""}${e.prNumber ? ` PR #${e.prNumber}` : ""} thread=${e.threadId ?? "-"} id=${e.id}${e.waitingReason ? ` waiting_on="${e.waitingReason.slice(0, 200)}"` : ""}`,
      );
      const text = [`${entries.length} tracked item(s)`, ...lines];
      return text.join("\n").slice(0, 20_000);
    },
  });

  bb.agents.registerTool({
    name: "cos_start_task",
    description: "Delegate a task to Chief of Staff: it starts an agent on a configured repository and takes the task through that repository's workflow. Use when the user asks to hand work to Chief of Staff.",
    parameters: z.object({
      repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/).describe("owner/repo, as configured in Chief of Staff"),
      title: z.string().max(200).optional().describe("Optional short task title; defaults to the description"),
      description: z.string().min(1).max(20_000).describe("What needs doing and why, with any acceptance criteria"),
    }),
    async execute(params, ctx) {
      const item = await startTask(cos, { repo: params.repo, title: params.title, body: params.description }, `tool:${ctx.threadId}`);
      if (!item) return { content: [{ type: "text", text: "Could not start the task." }], isError: true };
      return `Started "${item.issueTitle}" on ${params.repo} (item ${item.id}, workflow ${item.workflow.name}${item.threadId ? `, thread ${item.threadId}` : ""}). Track it with chief_of_staff_status.`;
    },
  });
}
