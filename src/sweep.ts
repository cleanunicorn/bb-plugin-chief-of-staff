// Per-minute sweep driven by one durable bb.background.schedule: issue
// intake, CI watching, thread sync, retries and stall detection.
import type { Cos } from "./context";
import { runIntake } from "./intake";
import { watchCi } from "./delivery";
import { detectStalls } from "./roster";
import { syncThreads, tickItems } from "./sync";

const KV_LAST_INTAKE = "sweep:lastIntakeAt";
const KV_LAST_CI = "sweep:lastCiAt";
/** CI is polled at most this often. */
const CI_POLL_MS = 2 * 60_000;

let running = false;

export async function sweep(cos: Cos): Promise<void> {
  if (running) return;
  running = true;
  const warn = (what: string) => (error: unknown) => cos.bb.log.warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  try {
    const config = await cos.config();
    const now = cos.now();
    const kv = cos.bb.storage.kv;

    const lastIntake = await kv.get<string>(KV_LAST_INTAKE);
    if (config.repos.length && (!lastIntake || now.getTime() - Date.parse(lastIntake) >= Math.max(1, config.values.intakeIntervalMinutes) * 60_000)) {
      await kv.set(KV_LAST_INTAKE, now.toISOString());
      await runIntake(cos, { actor: "schedule:intake" }).catch(warn("intake"));
    }

    const lastCi = await kv.get<string>(KV_LAST_CI);
    if (!lastCi || now.getTime() - Date.parse(lastCi) >= CI_POLL_MS) {
      await kv.set(KV_LAST_CI, now.toISOString());
      await watchCi(cos, "schedule:ci").catch(warn("ci watch"));
    }

    // Before stall detection, so a thread resumed or answered in BB is not
    // mistaken for a stalled one.
    await syncThreads(cos, "schedule:sync").catch(warn("thread sync"));
    await tickItems(cos, "schedule:tick").catch(warn("item tick"));
    await detectStalls(cos, "schedule:stall").catch(warn("stall detection"));
  } finally {
    running = false;
  }
}
