// Per-minute sweep driven by one durable bb.background.schedule: issue
// intake, CI watching, PR state, thread sync, retries, stall detection,
// finished tasks' token usage and daily retention.
import type { Cos } from "./context";
import { runIntake } from "./intake";
import { watchCi } from "./delivery";
import { refreshPrStates } from "./prState";
import { detectStalls } from "./roster";
import { syncThreads, tickItems } from "./sync";
import { groupExistingThreads } from "./threadGroups";
import { maybeRunRetention } from "./retention";
import { countFinishedUsage } from "./usage";

const KV_LAST_INTAKE = "sweep:lastIntakeAt";
const KV_LAST_CI = "sweep:lastCiAt";
const KV_NEXT_GITHUB_PHASE = "sweep:nextGithubPhase";
/** CI is polled at most this often. */
const CI_POLL_MS = 2 * 60_000;
/**
 * Time after which a sweep starts no further GitHub work. Intake and CI
 * take turns going first, so neither can consume every sweep's budget.
 * Checked between items, so a phase stops after the item in hand, never in
 * the middle of one: a sweep can run over by one item's requests. What is
 * left waits until the phase is next due.
 */
export const GITHUB_PHASE_BUDGET_MS = 2 * 60_000;

let running = false;
/** Whether the last sweep saw a GitHub rate limit (its end refreshes the dashboard). */
let wasLimited = false;

export async function sweep(cos: Cos): Promise<void> {
  if (running || cos.store.isPaused()) return;
  running = true;
  const warn = (what: string) => (error: unknown) => cos.bb.log.warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  try {
    const config = await cos.config();
    const now = cos.now();
    const kv = cos.bb.storage.kv;
    // During a GitHub rate limit the GitHub phases are skipped without being
    // stamped, so they run as soon as they are due after the reset.
    const limited = () => cos.githubLimit() !== null;
    const deadline = now.getTime() + GITHUB_PHASE_BUDGET_MS;
    const overBudget = () => cos.now().getTime() >= deadline;
    if (wasLimited && !limited()) cos.invalidate();
    wasLimited = limited();

    const nextPhase = await kv.get<string>(KV_NEXT_GITHUB_PHASE);
    const phases = nextPhase === "ci" ? ["ci", "intake"] as const : ["intake", "ci"] as const;
    for (const phase of phases) {
      if (cos.store.isPaused()) return;
      if (limited() || overBudget()) break;
      if (phase === "intake" && !config.repos.length) continue;
      const lastKey = phase === "intake" ? KV_LAST_INTAKE : KV_LAST_CI;
      const interval = phase === "intake" ? Math.max(1, config.values.intakeIntervalMinutes) * 60_000 : CI_POLL_MS;
      const last = await kv.get<string>(lastKey);
      const started = cos.now();
      if (last && started.getTime() - Date.parse(last) < interval) continue;
      // Persist before starting: even an error or reload gives the other
      // overdue phase the next turn instead of resetting intake to first.
      await kv.set(KV_NEXT_GITHUB_PHASE, phase === "intake" ? "ci" : "intake");
      await kv.set(lastKey, started.toISOString());
      if (phase === "intake") await runIntake(cos, { actor: "schedule:intake", deadline }).catch(warn("intake"));
      else await watchCi(cos, "schedule:ci", { deadline }).catch(warn("ci watch"));
    }

    if (cos.store.isPaused()) return;
    // Last of the GitHub work, every sweep: intake and CI keep alternating
    // first, and this pass only gets the budget they leave. Each PR's own
    // staleness (PR_STALE_MS) is its throttle, so it is not stamped.
    if (!limited() && !overBudget()) await refreshPrStates(cos, "schedule:pr-state", { deadline }).catch(warn("PR state refresh"));

    // Before stall detection, so a thread resumed or answered in BB is not
    // mistaken for a stalled one.
    if (cos.store.isPaused()) return;
    await groupExistingThreads(cos).catch(warn("thread grouping"));
    await syncThreads(cos, "schedule:sync").catch(warn("thread sync"));
    await tickItems(cos, "schedule:tick").catch(warn("item tick"));
    await detectStalls(cos, "schedule:stall").catch(warn("stall detection"));
    // A bounded batch of finished tasks' token usage, summed over all their threads.
    await countFinishedUsage(cos).catch(warn("usage count"));
    await maybeRunRetention(cos, "schedule:retention").catch(warn("retention"));
    // A limit this sweep ran into: its end refreshes the dashboard too.
    wasLimited ||= limited();
  } finally {
    running = false;
  }
}
