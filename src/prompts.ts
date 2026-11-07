// Prompts Chief of Staff sends to the agents working on workflow steps. Every
// prompt names the step, says whether the agent may change code, carries the
// step's instructions, the reports of the steps that feed into it and any
// feedback that sent it back, and ends with the reporting contract, so the
// agent says explicitly when the step is finished.
import type { NodeState, Nodes } from "./machine";
import type { WorkItem } from "./state";
import { depths, predecessors, stepById, topoOrder, type AgentStep, type Workflow } from "./workflow";

export const REPORT_TOOL = "cos_report";
const CONTEXT_MAX = 8_000;
const FEEDBACK_MAX = 12_000;
const clip = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

/** "Plan → Build → (Review ∥ Docs) → Ship", with the current step in bold. */
export function pipelineLine(wf: Workflow, current?: string): string {
  const depth = depths(wf);
  const groups = new Map<number, string[]>();
  for (const id of topoOrder(wf)) {
    const d = depth.get(id) ?? 0;
    groups.set(d, [...(groups.get(d) ?? []), id]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ids]) => {
      const names = ids.map((id) => (id === current ? `**${stepById(wf, id)?.name ?? id}**` : (stepById(wf, id)?.name ?? id)));
      return names.length > 1 ? `(${names.join(" ∥ ")})` : names[0];
    })
    .join(" → ");
}

/** The latest reports of the steps feeding into `stepId`. */
export function inputReports(wf: Workflow, nodes: Nodes, stepId: string): string[] {
  const out: string[] = [];
  for (const p of predecessors(wf, stepId)) {
    const n = nodes[p];
    const s = stepById(wf, p);
    if (!n || !s) continue;
    const reports = n.reports.filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (reports.length) {
      const body = reports.length > 1 ? reports.map((r, i) => `#### Agent ${i + 1}\n${r.summary}`).join("\n\n") : reports[0]!.summary;
      out.push(`### From ${s.name}\n${clip(body, CONTEXT_MAX)}`);
    } else if (s.type === "check" && n.output) {
      out.push(`### From ${s.name} (passed)\n\`\`\`\n${clip(n.output, 2_000)}\n\`\`\``);
    }
  }
  return out;
}

function contract(step: AgentStep): string[] {
  const outcomes = step.verdict ? '`"done"` if it passes, or `"failed"` with the findings that must change' : '`"done"`';
  return [
    ``,
    `### When you finish this step`,
    `Call the \`${REPORT_TOOL}\` tool with \`step: "${step.id}"\`, \`outcome\`: ${outcomes}, and a Markdown \`summary\` of your result (the next steps read it).`,
    `If you need a decision from a person, ask it with your question tool, or call \`${REPORT_TOOL}\` with \`outcome: "needs_input"\` and the \`question\`. Do not stop without doing one of these: Chief of Staff waits for the report before moving on.`,
    `If the \`${REPORT_TOOL}\` tool is unavailable, end your final message with:`,
    "```",
    `## Step report`,
    `step: ${step.id}`,
    `outcome: done`,
    `summary: <your result>`,
    "```",
  ];
}

/** The prompt that starts (or restarts) an agent on a step. */
export function stepPrompt(item: WorkItem, step: AgentStep, agent: number, ctx: { defaultBranch?: string } = {}): string {
  const wf = item.workflow;
  const node: NodeState | undefined = item.nodes[step.id];
  const lines: string[] = [`**[Chief of Staff · ${wf.name} · ${step.name}]**  ${pipelineLine(wf, step.id)}`, ``];
  if (step.writes) {
    lines.push(`You may change code in this step. Commit your work on the current branch. Do not push and do not open a pull request; Chief of Staff does that.`);
  } else {
    lines.push(`This step is read-only: do not change, commit or delete files.${ctx.defaultBranch ? ` The work so far is \`git diff origin/${ctx.defaultBranch}...HEAD\`.` : ""}`);
  }
  if (step.agents > 1) lines.push(`${step.agents} agents work on this step independently; you are agent ${agent + 1}. Do your own work; Chief of Staff combines the reports.`);
  if (step.approval) lines.push(`A person approves your report before the workflow moves on.`);
  if (step.instructions.trim()) lines.push(``, `### Instructions`, step.instructions.trim());
  const inputs = inputReports(wf, item.nodes, step.id);
  if (inputs.length) lines.push(``, `### Input from earlier steps`, ...inputs);
  if (node?.feedback) lines.push(``, `### Why this step runs again`, clip(node.feedback, FEEDBACK_MAX));
  lines.push(...contract(step));
  return lines.join("\n");
}

export function nudgePrompt(step: AgentStep): string {
  return [
    `You ended your turn without reporting the step **${step.name}**.`,
    `- Finished? Call \`${REPORT_TOOL}\` with \`step: "${step.id}"\` now.`,
    `- Need a decision? Ask it, or report \`outcome: "needs_input"\` with the question.`,
    `- Not finished? Keep working, then report.`,
  ].join("\n");
}

/** Opening context for a thread spawned for a read-only step (it has not seen the task). */
export function stepThreadBrief(item: WorkItem, step: AgentStep, task: string): string {
  return [
    `You work on one step (“${step.name}”) of a task in ${item.repo}. ${item.threadId ? "Another agent builds the change in this workspace; judge and inform, do not edit." : "Nothing has been built yet."}`,
    ``,
    `## Task`,
    task,
  ].join("\n");
}

/** Split a report that starts with "Title: …" into a PR title and body. */
export function splitTitle(summary: string): { title: string | null; body: string } {
  const match = /^\s*Title:\s*(.+)\s*$/im.exec(summary);
  if (!match || match.index > 200) return { title: null, body: summary.trim() };
  return { title: match[1].trim(), body: summary.replace(match[0], "").trim() };
}

/** The step a builder-thread turn belongs to: the code-writing step that is running. */
export function runningWriter(item: WorkItem): AgentStep | null {
  for (const s of item.workflow.steps) {
    if (s.type === "agent" && s.writes && ["running", "waiting"].includes(item.nodes[s.id]?.status ?? "")) return s;
  }
  return null;
}
