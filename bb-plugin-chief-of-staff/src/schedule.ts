// Pure routine scheduling: decide which routines are due given the current
// time and each routine's last run. The server calls this once a minute from
// a durable bb.background.schedule sweep.
import { CronExpressionParser } from "cron-parser";
import type { Routine } from "./config";

export function intervalToMs(every: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(every);
  if (!match) throw new Error(`invalid interval: ${every}`);
  const n = Number(match[1]);
  return n * (match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000);
}

export function validateCron(cron: string, timezone?: string): string | null {
  try {
    CronExpressionParser.parse(cron, { tz: timezone });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The most recent fire time at or before `now`, or null when none. */
export function previousFireTime(routine: Pick<Routine, "cron" | "every" | "timezone">, now: Date, lastRunAt: Date | null): Date | null {
  if (routine.cron) {
    const expr = CronExpressionParser.parse(routine.cron, { currentDate: new Date(now.getTime() + 1000), tz: routine.timezone });
    return expr.prev().toDate();
  }
  if (routine.every) {
    const ms = intervalToMs(routine.every);
    if (!lastRunAt) return now;
    const next = new Date(lastRunAt.getTime() + ms);
    return next.getTime() <= now.getTime() ? next : null;
  }
  return null;
}

export function nextFireTime(routine: Pick<Routine, "cron" | "every" | "timezone">, now: Date, lastRunAt: Date | null): Date | null {
  if (routine.cron) {
    try {
      return CronExpressionParser.parse(routine.cron, { currentDate: now, tz: routine.timezone }).next().toDate();
    } catch {
      return null;
    }
  }
  if (routine.every) {
    const ms = intervalToMs(routine.every);
    return new Date((lastRunAt ?? now).getTime() + ms);
  }
  return null;
}

/**
 * A routine is due when a fire time exists in (lastRunAt, now]. When it has
 * never run, only fire times within `catchUpWindowMs` of now count, so a
 * freshly configured daily routine does not run immediately at install.
 */
export function isDue(routine: Pick<Routine, "cron" | "every" | "timezone" | "enabled">, now: Date, lastRunAt: Date | null, catchUpWindowMs = 10 * 60_000): boolean {
  if (!routine.enabled) return false;
  let fire: Date | null;
  try {
    fire = previousFireTime(routine, now, lastRunAt);
  } catch {
    return false;
  }
  if (!fire) return false;
  if (fire.getTime() > now.getTime()) return false;
  if (lastRunAt) return fire.getTime() > lastRunAt.getTime();
  return now.getTime() - fire.getTime() <= catchUpWindowMs;
}

export function dueRoutines(routines: Routine[], now: Date, lastRuns: Map<string, Date | null>, enabledOverrides: Map<string, boolean | null> = new Map()): Routine[] {
  return routines.filter((routine) => {
    const override = enabledOverrides.get(routine.name);
    const enabled = override === null || override === undefined ? routine.enabled : override;
    return isDue({ ...routine, enabled }, now, lastRuns.get(routine.name) ?? null);
  });
}
