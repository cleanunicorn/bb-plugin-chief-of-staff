// `bb cos …` commands.
import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { liveWarnings, type Cos } from "./context";
import { buildRoster, type RosterEntry } from "./roster";
import { runIntake, startTask } from "./intake";
import { itemAction } from "./rpc";

const MAX_OUT = 60_000;
const out = (text: string) => ({ exitCode: 0, stdout: text.length > MAX_OUT ? text.slice(0, MAX_OUT) + "\n…(truncated)\n" : text });
// Never truncated: cut JSON cannot be parsed, and paging cursors would be lost.
const json = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value, null, 2) + "\n" });

export function formatRoster(entries: RosterEntry[]): string {
  if (!entries.length) return "No agents tracked.\n";
  const rows = entries.map((e) => [
    (e.current.join("+") || e.detail).slice(0, 24),
    e.actor + (e.stalled ? " (stalled)" : ""),
    e.repo + (e.issueNumber ? `#${e.issueNumber}` : ""),
    e.prNumber ? `PR #${e.prNumber}` : "-",
    e.threadId ?? "-",
    e.activity.slice(0, 60),
    e.issueTitle.slice(0, 40),
  ]);
  const header = ["STEP", "BALL", "ISSUE", "PR", "THREAD", "NOW", "TITLE"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const waiting = entries.filter((e) => e.waitingReason).map((e) => `  ${e.repo}${e.issueNumber ? `#${e.issueNumber}` : ""} [${e.id}] (${e.threadId ?? "-"}): ${e.waitingReason}`);
  return [line(header), ...rows.map(line), ...(waiting.length ? ["", "Waiting on you:", ...waiting] : [])].join("\n") + "\n";
}

export function registerCli(bb: BbPluginApi, cos: Cos): void {
  bb.cli.register(
    defineCli({
      name: "cos",
      summary: "Chief of Staff: take issues and tasks through your agent workflows",
      commands: {
        status: cliCommand({
          summary: "Show the agent roster",
          options: {
            repo: { type: "string", description: "Limit to owner/repo" },
            all: { type: "boolean", description: "Add the most recently finished items after the active ones" },
            "finished-limit": { type: "integer", description: "Finished items per page with --all (default 50)", min: 1, max: 500 },
            before: { type: "string", description: "Cursor from an earlier page: list only the next page of finished items (implies --all)" },
            usage: { type: "boolean", description: "Include token usage / cost when the provider reports it" },
            json: { type: "boolean", description: "JSON output" },
          },
          async run(input) {
            const { repo, all, before, usage } = input.options;
            const finishedLimit = input.options["finished-limit"];
            let roster;
            try {
              roster = await buildRoster(cos, { repo, includeDone: all || before !== undefined, finishedLimit, before, withUsage: usage });
            } catch (error) {
              if (error instanceof Error && error.message === "invalid cursor") throw new PluginCliError("invalid --before cursor", { hint: "Use the cursor printed by an earlier bb cos status --all" });
              throw error;
            }
            const { entries, nextBefore } = roster;
            const overview = await cos.config();
            const warnings = liveWarnings(cos, overview);
            if (input.options.json) return json({ nextBefore, errors: overview.errors, warnings, entries });
            const notes = [...overview.errors.map((e) => `config error: ${e}`), ...warnings.map((w) => `warning: ${w}`)];
            const result = out(formatRoster(entries) + (notes.length ? "\n" + notes.join("\n") + "\n" : ""));
            // After truncation, so the cursor always shows.
            if (nextBefore) result.stdout += `\nMore finished: bb cos status --all${repo ? ` --repo ${repo}` : ""}${finishedLimit ? ` --finished-limit ${finishedLimit}` : ""} --before ${nextBefore}\n`;
            return result;
          },
        }),
        intake: cliCommand({
          summary: "Pick up eligible GitHub issues now",
          options: { repo: { type: "string", description: "Limit to owner/repo" }, "dry-run": { type: "boolean", description: "Report without spawning" }, json: { type: "boolean", description: "JSON output" } },
          async run(input, ctx) {
            const results = await runIntake(cos, { repo: input.options.repo, dryRun: input.options["dry-run"], actor: `cli${ctx.threadId ? `:${ctx.threadId}` : ""}` });
            if (input.options.json) return json(results);
            return out(
              results
                .map((r) => `${r.repo}: considered ${r.considered}, started ${r.started.length}${r.started.length ? ` (#${r.started.map((s) => s.issue).join(", #")})` : ""}, skipped ${r.skipped.length}${r.error ? `\n  error: ${r.error}` : ""}${r.skipped.map((s) => `\n  #${s.issue}: ${s.reason}`).join("")}`)
                .join("\n") + "\n",
            );
          },
        }),
        item: cliCommand({
          summary: "Act on a tracked work item",
          positionals: [
            { name: "action", description: "approve | revise | retry | rerun | done | failed", required: true },
            { name: "id", description: "Work item id (see bb cos status --json)", required: true },
          ],
          options: {
            step: { type: "string", description: "Step id (defaults to the step waiting on you; required for rerun)" },
            message: { type: "string", description: "Feedback for revise / rerun: sent to the agent" },
          },
          async run(input, ctx) {
            const map = { approve: "approve", revise: "revise", retry: "retry", resume: "retry", rerun: "rerun_step", done: "mark_done", failed: "mark_failed" } as const;
            const action = map[input.positionals.action as keyof typeof map];
            if (!action) throw new PluginCliError(`unknown action ${input.positionals.action}`, { hint: Object.keys(map).join(" | ") });
            if (action === "revise" && !input.options.message) throw new PluginCliError("revise needs --message with feedback for the agent");
            if (action === "rerun_step" && !input.options.step) throw new PluginCliError("rerun needs --step <id>");
            const item = await itemAction(cos, input.positionals.id, action, `cli${ctx.threadId ? `:${ctx.threadId}` : ""}`, { step: input.options.step, feedback: input.options.message });
            return out(`${input.positionals.id}: ${item?.status ?? "unknown"}\n`);
          },
        }),
        task: cliCommand({
          summary: "Start a task without a GitHub issue and take it through the workflow",
          positionals: [{ name: "prompt", description: "What needs doing", required: true }],
          options: {
            repo: { type: "string", description: "owner/repo (required)" },
            body: { type: "string", description: "Additional task details; defaults to the prompt" },
            json: { type: "boolean", description: "JSON output" },
          },
          async run(input, ctx) {
            if (!input.options.repo) throw new PluginCliError("--repo owner/repo is required");
            const item = await startTask(cos, { repo: input.options.repo, title: input.options.body !== undefined ? input.positionals.prompt : undefined, body: input.options.body ?? input.positionals.prompt }, `cli${ctx.threadId ? `:${ctx.threadId}` : ""}`);
            if (!item) throw new PluginCliError("could not start the task");
            if (input.options.json) return json(item);
            return out(`started ${item.id} on ${item.repo} (workflow ${item.workflow.name}): ${item.status}${item.threadId ? ` (thread ${item.threadId})` : ""}\n`);
          },
        }),
        log: cliCommand({
          summary: "Show the activity log",
          options: { limit: { type: "integer", description: "Max entries", default: 50, min: 1, max: 500 }, item: { type: "string", description: "Only entries for one work item" } },
          async run(input) {
            const entries = cos.store.listLog({ limit: input.options.limit, workItemId: input.options.item });
            return out(entries.reverse().map((e) => `${e.at} [${e.level}] ${e.kind}${e.repo ? ` ${e.repo}` : ""}: ${e.message} (${e.actor})`).join("\n") + "\n");
          },
        }),
      },
    }),
  );
}

