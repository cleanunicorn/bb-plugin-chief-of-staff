// `bb cos …` commands.
import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { Cos } from "./context";
import { buildRoster, type RosterEntry } from "./roster";
import { runIntake, startTask } from "./intake";
import { describeRoutines, itemAction } from "./rpc";
import { runRoutineGuarded } from "./sweep";

const MAX_OUT = 60_000;
const out = (text: string) => ({ exitCode: 0, stdout: text.length > MAX_OUT ? text.slice(0, MAX_OUT) + "\n…(truncated)\n" : text });
const json = (value: unknown) => out(JSON.stringify(value, null, 2) + "\n");

export function formatRoster(entries: RosterEntry[]): string {
  if (!entries.length) return "No agents tracked.\n";
  const rows = entries.map((e) => [
    e.stage.toUpperCase(),
    e.actor + (e.stalled ? " (stalled)" : ""),
    e.repo + (e.issueNumber ? `#${e.issueNumber}` : ""),
    e.prNumber ? `PR #${e.prNumber}` : "-",
    e.threadId ?? "-",
    e.activity.slice(0, 60),
    e.issueTitle.slice(0, 40),
  ]);
  const header = ["STAGE", "BALL", "ISSUE", "PR", "THREAD", "NOW", "TITLE"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const waiting = entries.filter((e) => e.waitingReason).map((e) => `  ${e.repo}${e.issueNumber ? `#${e.issueNumber}` : ""} [${e.id}] (${e.threadId ?? "-"}): ${e.waitingReason}`);
  return [line(header), ...rows.map(line), ...(waiting.length ? ["", "Waiting on you:", ...waiting] : [])].join("\n") + "\n";
}

export function registerCli(bb: BbPluginApi, cos: Cos): void {
  bb.cli.register(
    defineCli({
      name: "cos",
      summary: "Chief of Staff: agent roster, GitHub issue intake, PR delivery, routines",
      commands: {
        status: cliCommand({
          summary: "Show the agent roster",
          options: {
            repo: { type: "string", description: "Limit to owner/repo" },
            all: { type: "boolean", description: "Include finished items" },
            usage: { type: "boolean", description: "Include token usage / cost when the provider reports it" },
            json: { type: "boolean", description: "JSON output" },
          },
          async run(input) {
            const entries = await buildRoster(cos, { repo: input.options.repo, includeDone: input.options.all, withUsage: input.options.usage });
            const overview = await cos.config();
            if (input.options.json) return json({ entries, errors: overview.errors, warnings: overview.warnings });
            const notes = [...overview.errors.map((e) => `config error: ${e}`), ...overview.warnings.map((w) => `warning: ${w}`)];
            return out(formatRoster(entries) + (notes.length ? "\n" + notes.join("\n") + "\n" : ""));
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
        run: cliCommand({
          summary: "Run a routine now",
          positionals: [{ name: "routine", description: "Routine name", required: true }],
          options: { "dry-run": { type: "boolean", description: "Report what would happen without mutating anything" }, json: { type: "boolean", description: "JSON output" } },
          async run(input, ctx) {
            const { routines } = await cos.config();
            const routine = routines.find((r) => r.name === input.positionals.routine);
            if (!routine) throw new PluginCliError(`routine "${input.positionals.routine}" not found`, { hint: "bb cos routines list" });
            const run = await runRoutineGuarded(cos, routine, { dryRun: input.options["dry-run"] || undefined, actor: `cli${ctx.threadId ? `:${ctx.threadId}` : ""}`, signal: ctx.signal });
            if (input.options.json) return json(run);
            const lines = [`${run.routine} on ${run.repo}: ${run.status}${run.dryRun ? " (dry run)" : ""}`, ...run.steps.map((s) => `  ${s.index + 1}. ${s.type}: ${s.status} — ${s.summary}`)];
            return { exitCode: run.status === "failed" ? 1 : 0, stdout: lines.join("\n") + "\n" };
          },
        }),
        "routines list": cliCommand({
          summary: "List routines",
          options: { json: { type: "boolean", description: "JSON output" } },
          async run(input) {
            const routines = await describeRoutines(cos);
            if (input.options.json) return json(routines);
            if (!routines.length) return out("No routines configured.\n");
            return out(routines.map((r) => `${r.enabled ? "[on ]" : "[off]"} ${r.name} — ${r.repo} — ${r.schedule ?? "manual"} — steps: ${r.steps.join(" → ")}${r.dryRun ? " (dry-run)" : ""}${r.nextRunAt ? ` — next ${r.nextRunAt}` : ""}${r.configured ? "" : " — repo not configured"}`).join("\n") + "\n");
          },
        }),
        "routines enable": cliCommand({
          summary: "Enable a routine",
          positionals: [{ name: "routine", description: "Routine name", required: true }],
          async run(input) {
            await setEnabled(cos, input.positionals.routine, true);
            return out(`enabled ${input.positionals.routine}\n`);
          },
        }),
        "routines disable": cliCommand({
          summary: "Disable a routine",
          positionals: [{ name: "routine", description: "Routine name", required: true }],
          async run(input) {
            await setEnabled(cos, input.positionals.routine, false);
            return out(`disabled ${input.positionals.routine}\n`);
          },
        }),
        "routines runs": cliCommand({
          summary: "Show recent routine runs",
          options: { routine: { type: "string", description: "Filter by routine" }, limit: { type: "integer", description: "Max runs", default: 10, min: 1, max: 200 } },
          async run(input) {
            const runs = cos.store.listRuns({ routine: input.options.routine, limit: input.options.limit });
            return out(runs.map((r) => `${r.startedAt} ${r.routine} (${r.repo}) ${r.status}${r.dryRun ? " dry-run" : ""} by ${r.triggeredBy}\n${r.steps.map((s) => `  ${s.type}: ${s.status} — ${s.summary}`).join("\n")}`).join("\n") + "\n");
          },
        }),
        item: cliCommand({
          summary: "Act on a tracked work item",
          positionals: [
            { name: "action", description: "approve | revise | retry | resume | rerun-checks | done | failed", required: true },
            { name: "id", description: "Work item id (see bb cos status --json)", required: true },
          ],
          options: { message: { type: "string", description: "Feedback for revise: sent to the agent with the stage" } },
          async run(input, ctx) {
            const map = { approve: "approve", revise: "revise", retry: "retry", resume: "resume", "rerun-checks": "rerun_checks", "rerun-verify": "rerun_checks", done: "mark_done", failed: "mark_failed" } as const;
            const action = map[input.positionals.action as keyof typeof map];
            if (!action) throw new PluginCliError(`unknown action ${input.positionals.action}`, { hint: Object.keys(map).join(" | ") });
            if (action === "revise" && !input.options.message) throw new PluginCliError("revise needs --message with feedback for the agent");
            const item = await itemAction(cos, input.positionals.id, action, `cli${ctx.threadId ? `:${ctx.threadId}` : ""}`, input.options.message);
            return out(`${input.positionals.id}: ${item ? `${item.stage}/${item.status}` : "unknown"}\n`);
          },
        }),
        task: cliCommand({
          summary: "Start a task without a GitHub issue and take it through the workflow",
          positionals: [{ name: "title", description: "Short task title", required: true }],
          options: {
            repo: { type: "string", description: "owner/repo (required)" },
            body: { type: "string", description: "What needs doing; defaults to the title" },
            json: { type: "boolean", description: "JSON output" },
          },
          async run(input, ctx) {
            if (!input.options.repo) throw new PluginCliError("--repo owner/repo is required");
            const item = await startTask(cos, { repo: input.options.repo, title: input.positionals.title, body: input.options.body ?? "" }, `cli${ctx.threadId ? `:${ctx.threadId}` : ""}`);
            if (!item) throw new PluginCliError("could not start the task");
            if (input.options.json) return json(item);
            return out(`started ${item.id} on ${item.repo}: ${item.stage}/${item.status}${item.threadId ? ` (thread ${item.threadId})` : ""}\n`);
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

async function setEnabled(cos: Cos, name: string, enabled: boolean): Promise<void> {
  const { routines } = await cos.config();
  if (!routines.some((r) => r.name === name)) throw new PluginCliError(`routine "${name}" not found`);
  cos.store.setEnabledOverride(name, enabled);
  cos.store.log({ level: "info", kind: "routine", repo: null, workItemId: null, message: `routine "${name}" ${enabled ? "enabled" : "disabled"}`, actor: "cli" });
  cos.invalidate();
}
