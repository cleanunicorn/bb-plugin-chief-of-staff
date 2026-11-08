// Agent tools: the step report every workflow agent files, the roster, and
// starting a task from a conversation.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { dispatchLocked, withItemLock } from "./delivery";
import { deliveryWait, saveDelivery } from "./agent-delivery";
import type { Cos } from "./context";
import { buildRoster } from "./roster";
import { REPORT_OUTCOMES } from "./report";
import { threadContext } from "./sync";
import { startTask } from "./intake";
import type { ReportOutcome } from "./machine";
import { chosenModel } from "./workflow";

export function registerTools(bb: BbPluginApi, cos: Cos): void {
  bb.agents.registerTool({
    name: "cos_report",
    description:
      "Report to Chief of Staff that you finished your current workflow step, or that you need a human decision. Chief of Staff moves the task on when your turn ends. Only for threads Chief of Staff started; your prompt names the step id.",
    parameters: z.object({
      attempt: z.string().max(80).optional().describe("The delivery attempt id in your current prompt, when provided"),
      step: z.string().min(1).max(40).describe("The step id from your prompt"),
      outcome: z.enum(REPORT_OUTCOMES as [ReportOutcome, ...ReportOutcome[]]).describe('"done"; "failed" on a pass/fail step that does not pass (or when you cannot finish); "needs_input" when a person must decide'),
      summary: z.string().min(1).max(40_000).describe("The step's result in Markdown (a plan, what changed, evidence, findings). The next steps read it."),
      question: z.string().max(4_000).optional().describe('With outcome "needs_input": the question for the human'),
      choice: z.string().max(40).optional().describe("Only when your prompt lists model choices: the id of the one you pick for the steps after this"),
    }),
    async execute(params, ctx) {
      const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      const tracked = cos.store.getWorkItemByThread(ctx.threadId);
      if (!tracked) return err("This thread is not tracked by Chief of Staff; nothing to report.");
      return withItemLock(tracked.id, async () => {
        const item = cos.store.getWorkItemByThread(ctx.threadId);
        if (!item) return err("This thread is not tracked by Chief of Staff; nothing to report.");
        if (item.status === "done") return "This task is already finished.";
        const tc = threadContext(cos, item, ctx.threadId);
        if (!tc?.step) return err("Chief of Staff has no step running on this thread right now.");
        if (params.step !== tc.step.id) return err(`This thread is working on the step "${tc.step.id}" (${tc.step.name}), not "${params.step}". Report step "${tc.step.id}".`);
        const node = item.nodes[tc.step.id];
        // A step parked on this agent's question resumed (we may have missed the turn starting): its report counts.
        if (item.status === "failed" || item.queuedEvent) return err("This task is not accepting reports.");
        if (tc.row && tc.row.round !== node?.round) return err("This thread belongs to an earlier step round.");
        if (tc.role === "step" && cos.store.stepThread(item.id, tc.step.id, tc.agent)?.threadId !== ctx.threadId) return err("This agent thread has been replaced.");
        const delivery = node?.deliveries?.[tc.agent];
        if (delivery && (delivery.threadId && delivery.threadId !== ctx.threadId || params.attempt && params.attempt !== delivery.id)) return err("This report belongs to a different delivery attempt.");
        if (delivery && delivery.status !== "sent" && params.attempt !== delivery.id) return err("Include the attempt id from your current prompt to confirm delivery.");
        const recoverable = deliveryWait(item, tc.step.id, tc.agent);
        const otherDeliveryWait = node?.waiting?.kind === "cos_error" && node.retry?.effect.type === "agent" && !node.retry.effect.fresh && node.retry.effect.agent !== tc.agent;
        const resumed = node?.status === "waiting" && node.waiting && ["question", "no_report", "stalled"].includes(node.waiting.kind) && (node.waiting.agent ?? tc.agent) === tc.agent;
        if (node?.status !== "running" && !resumed && !recoverable && !otherDeliveryWait) return err(`The step ${tc.step.name} is not running (it is ${node?.status ?? "unknown"}).`);
        if (params.outcome === "needs_input" && !params.question?.trim()) return err('With outcome "needs_input", put the question for the human in `question`.');
        if (tc.step.chooses.length && params.outcome === "done" && !chosenModel(tc.step, { reports: [{ choice: params.choice }] })) {
          return err(`This step picks a model: set \`choice\` to one of ${tc.step.chooses.map((c) => `"${c.id}"`).join(", ")}.`);
        }
        if (delivery?.status === "preparing") return err("The current prompt has not been sent yet.");
        if (delivery && params.attempt === delivery.id) saveDelivery(cos, item.id, tc.step.id, tc.agent, { ...delivery, status: "sent" });
        if (recoverable || node?.retry?.effect.type === "agent" && node.retry.effect.agent === tc.agent) {
          await dispatchLocked(cos, item.id, { type: "delivery_confirmed", step: tc.step.id, agent: tc.agent, round: node!.round, attempt: delivery?.id }, `tool:${ctx.threadId}`);
        }
        const report = { ...(params.attempt ? { attempt: params.attempt } : {}), step: tc.step.id, round: node!.round, outcome: params.outcome, summary: params.summary, question: params.question ?? null, choice: params.choice?.trim() || null, at: cos.now().toISOString(), via: "tool" as const };
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
    description: "Hand a task to Chief of Staff: it starts an agent on a configured repository and takes the task through the workflow (plan, build, verify, review, ship). Use when the user asks to delegate work to Chief of Staff.",
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
