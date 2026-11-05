// Per-minute sweep driven by one durable bb.background.schedule: issue
// intake, CI watching, stall detection and routine dispatch.
import type { Cos } from "./context";
import { runIntake } from "./intake";
import { watchCi } from "./delivery";
import { detectStalls } from "./roster";
import { dueRoutines } from "./schedule";
import { runRoutine } from "./routines/index";

const KV_LAST_INTAKE = "sweep:lastIntakeAt";
const KV_LAST_CI = "sweep:lastCiAt";

let running = false;
const activeRoutines = new Set<string>();

export function isRoutineRunning(name: string): boolean {
  return activeRoutines.has(name);
}

export async function runRoutineGuarded(cos: Cos, routine: Parameters<typeof runRoutine>[1], opts: Parameters<typeof runRoutine>[2]) {
  if (activeRoutines.has(routine.name)) throw new Error(`routine "${routine.name}" is already running`);
  activeRoutines.add(routine.name);
  try {
    return await runRoutine(cos, routine, opts);
  } finally {
    activeRoutines.delete(routine.name);
  }
}

export async function sweep(cos: Cos, signal?: AbortSignal): Promise<void> {
  if (running) return;
  running = true;
  try {
    const config = await cos.config();
    const now = cos.now();
    const kv = cos.bb.storage.kv;

    const lastIntake = await kv.get<string>(KV_LAST_INTAKE);
    if (config.repos.length && (!lastIntake || now.getTime() - Date.parse(lastIntake) >= Math.max(1, config.values.intakeIntervalMinutes) * 60_000)) {
      await kv.set(KV_LAST_INTAKE, now.toISOString());
      await runIntake(cos, { actor: "schedule:intake" }).catch((error) => cos.bb.log.warn(`intake failed: ${error instanceof Error ? error.message : String(error)}`));
    }

    const lastCi = await kv.get<string>(KV_LAST_CI);
    if (!lastCi || now.getTime() - Date.parse(lastCi) >= Math.max(1, config.values.ciPollIntervalMinutes) * 60_000) {
      await kv.set(KV_LAST_CI, now.toISOString());
      await watchCi(cos, "schedule:ci").catch((error) => cos.bb.log.warn(`ci watch failed: ${error instanceof Error ? error.message : String(error)}`));
    }

    await detectStalls(cos, "schedule:stall").catch((error) => cos.bb.log.warn(`stall detection failed: ${error instanceof Error ? error.message : String(error)}`));

    const lastRuns = new Map(config.routines.map((r) => [r.name, toDate(cos.store.getLastRunAt(r.name))]));
    const overrides = new Map(config.routines.map((r) => [r.name, cos.store.getEnabledOverride(r.name)]));
    for (const routine of dueRoutines(config.routines, now, lastRuns, overrides)) {
      if (activeRoutines.has(routine.name)) continue;
      cos.store.setLastRunAt(routine.name, now.toISOString());
      // Routines run detached from the sweep so a long deploy does not block monitoring.
      void runRoutineGuarded(cos, routine, { actor: `schedule:${routine.name}`, signal }).catch((error) => cos.bb.log.error(`routine ${routine.name} crashed: ${error instanceof Error ? error.message : String(error)}`));
    }
  } finally {
    running = false;
  }
}

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
