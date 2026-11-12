// Per-minute sweep driven by one durable bb.background.schedule: issue
// intake, CI watching, thread sync, retries and stall detection.
import type { Cos } from "./context";
import { runIntake } from "./intake";
import { watchCi } from "./delivery";
import { detectStalls } from "./roster";
import { syncThreads, tickItems } from "./sync";
import { groupExistingThreads } from "./threadGroups";

const KV_LAST_INTAKE = "sweep:lastIntakeAt";
const KV_LAST_CI = "sweep:lastCiAt";
/** CI is polled at most this often. */
const CI_POLL_MS = 2 * 60_000;
/**
 * Time after which a sweep starts no further GitHub work (intake, then CI).
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

    const lastIntake = await kv.get<string>(KV_LAST_INTAKE);
    if (config.repos.length && !limited() && (!lastIntake || now.getTime() - Date.parse(lastIntake) >= Math.max(1, config.values.intakeIntervalMinutes) * 60_000)) {
      await kv.set(KV_LAST_INTAKE, now.toISOString());
      await runIntake(cos, { actor: "schedule:intake", deadline }).catch(warn("intake"));
    }

    if (cos.store.isPaused()) return;
    const lastCi = await kv.get<string>(KV_LAST_CI);
    if (!limited() && !overBudget() && (!lastCi || now.getTime() - Date.parse(lastCi) >= CI_POLL_MS)) {
      await kv.set(KV_LAST_CI, now.toISOString());
      await watchCi(cos, "schedule:ci", { deadline }).catch(warn("ci watch"));
    }

    // Before stall detection, so a thread resumed or answered in BB is not
    // mistaken for a stalled one.
    if (cos.store.isPaused()) return;
    await groupExistingThreads(cos).catch(warn("thread grouping"));
    await syncThreads(cos, "schedule:sync").catch(warn("thread sync"));
    await tickItems(cos, "schedule:tick").catch(warn("item tick"));
    await detectStalls(cos, "schedule:stall").catch(warn("stall detection"));
    // A limit this sweep ran into: its end refreshes the dashboard too.
    wasLimited ||= limited();
  } finally {
    running = false;
  }
}
