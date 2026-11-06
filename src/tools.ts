// Agent tool exposing the roster to other agents.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Cos } from "./context";
import { buildRoster } from "./roster";
import { describeRoutines } from "./rpc";

export function registerTools(bb: BbPluginApi, cos: Cos): void {
  bb.agents.registerTool({
    name: "chief_of_staff_status",
    description: "Roster of agent threads the Chief of Staff plugin spawned or watches (status, repo, issue, PR, activity) plus configured routines.",
    parameters: z.object({
      repo: z.string().optional().describe("Limit to one owner/repo"),
      includeDone: z.boolean().default(false).describe("Include finished and failed items"),
      includeRoutines: z.boolean().default(false).describe("Also list routines with their next run time"),
    }),
    async execute(params) {
      const entries = await buildRoster(cos, { repo: params.repo, includeDone: params.includeDone });
      const lines = entries.map((e) => `- ${e.status}${e.stalled ? " (stalled)" : ""}: ${e.repo}${e.issueNumber ? `#${e.issueNumber}` : ""} "${e.issueTitle}"${e.prNumber ? ` PR #${e.prNumber}` : ""} thread=${e.threadId ?? "-"} last=${e.lastActivityAt ?? e.startedAt}${e.waitingReason ? ` waiting_on="${e.waitingReason.slice(0, 200)}"` : ""}${e.lastError ? ` error=${e.lastError.slice(0, 120)}` : ""}`);
      const text = [`${entries.length} tracked item(s)`, ...lines];
      if (params.includeRoutines) {
        const routines = await describeRoutines(cos);
        text.push("", "Routines:", ...routines.map((r) => `- ${r.name} (${r.repo}) ${r.enabled ? "enabled" : "disabled"} ${r.schedule ?? "manual"} next=${r.nextRunAt ?? "-"} steps=${r.steps.join(">")}`));
      }
      return text.join("\n").slice(0, 20_000);
    },
  });
}
