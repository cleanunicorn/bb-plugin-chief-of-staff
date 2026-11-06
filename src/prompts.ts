// Stage prompts Chief of Staff sends to the builder and reviewer threads.
// Every prompt names the stage, carries the operator's instructions for it,
// and ends with the reporting contract, so the agent says explicitly when a
// stage is finished instead of Chief of Staff guessing from its last message.
import type { PromptKind } from "./machine";
import type { WorkItem } from "./state";
import { activeStages, STAGE_LABEL, type Stage, type Workflow } from "./workflow";

const LOG_TAIL = 12_000;
const tail = (text: string | undefined, max = LOG_TAIL) => (text && text.length > max ? `…${text.slice(-max)}` : (text ?? ""));

export const REPORT_TOOL = "cos_report";

/** Stage a prompt kind belongs to. */
export function promptStage(kind: PromptKind, current: Stage): Stage {
  switch (kind) {
    case "plan":
    case "plan_revise":
      return "plan";
    case "build":
    case "fix_verify":
    case "fix_review":
    case "fix_ci":
    case "fix_human":
      return "build";
    case "verify":
      return "verify";
    case "review":
    case "rereview":
      return "review";
    case "ship":
      return "ship";
    case "nudge":
      return current;
  }
}

function header(workflow: Workflow, stage: Stage): string {
  const stages = activeStages(workflow);
  const index = stages.indexOf(stage);
  const position = index >= 0 ? ` · stage ${index + 1} of ${stages.length}` : "";
  return `**[Chief of Staff${position} · ${STAGE_LABEL[stage]}]**  Pipeline: ${stages.map((s) => (s === stage ? `**${STAGE_LABEL[s]}**` : STAGE_LABEL[s])).join(" → ")}`;
}

function outcomes(stage: Stage): string {
  switch (stage) {
    case "verify":
      return '`"done"` (verified, with evidence) or `"failed"` (what is broken)';
    case "review":
      return '`"done"` (approve) or `"changes_requested"` (findings in the summary)';
    default:
      return '`"done"`';
  }
}

/** The contract appended to every stage prompt. */
export function reportContract(stage: Stage, summaryHint: string): string {
  return [
    ``,
    `### When you finish this stage`,
    `Call the \`${REPORT_TOOL}\` tool with \`stage: "${stage}"\`, \`outcome\`: ${outcomes(stage)}, and \`summary\`: ${summaryHint}`,
    `If you need a decision from a person, ask it with your question tool, or call \`${REPORT_TOOL}\` with \`outcome: "needs_input"\` and the \`question\`. Do not stop without doing one of these: Chief of Staff waits for the report before moving on.`,
    `If the \`${REPORT_TOOL}\` tool is unavailable, end your final message with:`,
    "```",
    `## Stage report`,
    `stage: ${stage}`,
    `outcome: done`,
    `summary: <${summaryHint.replace(/\.$/, "")}>`,
    "```",
  ].join("\n");
}

function instructions(text: string): string[] {
  return text.trim() ? [``, `### Instructions for this stage`, text.trim()] : [];
}

function approvedPlan(item: WorkItem): string[] {
  const plan = item.reports.plan?.summary;
  return plan ? [``, `### Approved plan`, plan] : [];
}

const NO_PUSH = "Commit your work on the current branch. Do not push and do not open a pull request; Chief of Staff does that.";

/** The prompt body for a stage. `detail` is the failure log, findings or operator feedback. */
export function stagePrompt(kind: PromptKind, item: WorkItem, workflow: Workflow, ctx: { detail?: string; verifyCommand?: string; defaultBranch?: string } = {}): string {
  const current = item.stage === "done" ? "build" : item.stage;
  const stage = promptStage(kind, current);
  const lines: string[] = [header(workflow, stage), ``];
  switch (kind) {
    case "plan":
      lines.push(
        `Investigate the codebase and write an implementation plan for the task. Do not change files and do not commit in this stage.`,
        `Cover: the approach, the files you will change, risks and open questions, and how you will test it.`,
        workflow.plan.requireApproval ? `A person approves the plan before you build it.` : ``,
        ...instructions(workflow.plan.instructions),
        reportContract("plan", "the full plan in Markdown."),
      );
      break;
    case "plan_revise":
      lines.push(`Your plan was sent back with this feedback:`, ``, ctx.detail ?? "", ``, `Revise the plan. Do not change files yet.`, ...instructions(workflow.plan.instructions), reportContract("plan", "the full revised plan in Markdown."));
      break;
    case "build":
      lines.push(`Implement the task${item.reports.plan ? " following the approved plan" : ""}. ${NO_PUSH}`, ...approvedPlan(item), ...instructions(workflow.build.instructions), reportContract("build", "what changed and why, and the tests you ran with their results."));
      break;
    case "fix_verify":
      lines.push(
        `Verification failed${ctx.verifyCommand ? ` (\`${ctx.verifyCommand}\`)` : ""}. Fix the problem. ${NO_PUSH}`,
        ``,
        "```",
        tail(ctx.detail),
        "```",
        ...instructions(workflow.build.instructions),
        reportContract("build", "what you fixed."),
      );
      break;
    case "fix_review":
      lines.push(`The review requested changes. Address every finding. ${NO_PUSH}`, ``, `### Review findings`, ctx.detail ?? "", ...instructions(workflow.build.instructions), reportContract("build", "how you addressed each finding."));
      break;
    case "fix_ci":
      lines.push(`CI failed on pull request #${item.prNumber ?? "?"}. Fix the failure. ${NO_PUSH}`, ``, "```", tail(ctx.detail), "```", reportContract("build", "what you fixed."));
      break;
    case "fix_human":
      lines.push(`Instructions from the operator:`, ``, ctx.detail ?? "", ``, NO_PUSH, reportContract("build", "what you changed."));
      break;
    case "verify":
      lines.push(
        ctx.verifyCommand ? `\`${ctx.verifyCommand}\` passed. Now verify the change actually does what the task asks.` : `Verify the change actually does what the task asks.`,
        `Exercise it the way a user would and collect evidence (commands and output, screenshots, logs). Only fix trivial problems here; report anything real as failed.`,
        ...instructions(workflow.verify.instructions),
        reportContract("verify", "what you checked and the evidence, or what is broken."),
      );
      break;
    case "review":
    case "rereview": {
      const self = workflow.review.mode === "self";
      const diff = `git diff ${ctx.defaultBranch ? `origin/${ctx.defaultBranch}` : "<default branch>"}...HEAD`;
      if (kind === "rereview") {
        lines.push(`The builder addressed the previous findings:`, ``, item.reports.build?.summary ?? "(no summary)", ``, `Review the updated changes again (\`${diff}\`).`);
      } else {
        lines.push(self ? `Review your own changes critically, as a reviewer who did not write them would (\`${diff}\`).` : `Review the changes on this branch (\`${diff}\`).`);
      }
      lines.push(
        `Check correctness against the task, edge cases, tests, and the repository's conventions. Do not modify files in this stage.`,
        ...instructions(workflow.review.instructions),
        reportContract("review", "your verdict and, when requesting changes, a numbered list of concrete findings with file:line."),
      );
      break;
    }
    case "ship":
      lines.push(
        `Write the pull request description for this change. Do not push and do not open the pull request; Chief of Staff does that with your text.`,
        `Start the summary with a line \`Title: <pull request title>\`, then the description in Markdown.`,
        ...instructions(workflow.ship.instructions),
        reportContract("ship", "`Title: …` on the first line, then the pull request description."),
      );
      break;
    case "nudge":
      lines.push(
        `You ended your turn without reporting the ${STAGE_LABEL[current]} stage.`,
        `- Finished? Call \`${REPORT_TOOL}\` with \`stage: "${current}"\` now.`,
        `- Need a decision? Ask it, or report \`outcome: "needs_input"\` with the question.`,
        `- Not finished? Keep working, then report.`,
      );
      break;
  }
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

/** Context a newly spawned reviewer needs: it has not seen the task. */
export function reviewerBrief(item: WorkItem, task: string): string {
  return [
    `You are the reviewer for ${item.issueNumber ? `${item.repo}#${item.issueNumber}` : item.repo}: ${item.issueTitle}. Another agent built the change in this workspace. You did not write it; judge it on its merits.`,
    ``,
    `## Task`,
    task,
    ...approvedPlan(item),
    item.reports.build ? [``, `### Builder's summary`, item.reports.build.summary].join("\n") : ``,
    item.reports.verify ? [``, `### Verification`, item.reports.verify.summary].join("\n") : ``,
  ].join("\n");
}

/** Split an agent-written ship report into PR title and body. */
export function splitShipReport(summary: string): { title: string | null; body: string } {
  const match = /^\s*Title:\s*(.+)\s*$/im.exec(summary);
  if (!match) return { title: null, body: summary.trim() };
  return { title: match[1].trim(), body: summary.replace(match[0], "").trim() };
}
