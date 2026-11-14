// Usage limits: an agent's turn fails because its Claude or Codex subscription
// window (the 5-hour limit, say) is used up. That is not the agent failing:
// the step waits for the window to reset and BB retries the failed turn, which
// continues where the agent stopped. BB's provider-retry plugin usually queues
// that retry; Chief of Staff queues one too when it did not (disabled, or the
// reset was past its maximum wait), and hands the step to a person when a
// limit will not lift.
import type { Cos } from "./context";
import { dispatchLocked, withItemLock } from "./delivery";
import { MAX_USAGE_LIMIT_WAITS, resetTime } from "./machine";
import { threadContext } from "./sync";

/** The parts of a failed turn that say whether it hit a usage limit (BB's turn.failed event). */
export interface TurnFailure {
  errorInfo: { category: string; httpStatusCode: number | null } | null;
  rateLimits: { kind: string; status: string; windows: { status: string; resetsAtMs: number | null }[] } | null;
}

/** Longest reset Chief of Staff waits for; BB's provider-retry waits 6 hours by default too. A weekly cap goes to a person. */
export const MAX_USAGE_LIMIT_WAIT_MS = 6 * 60 * 60_000;
/** After the reset, how long the thread may stay failed with no retry before Chief of Staff retries it itself. */
export const LIMIT_RETRY_GRACE_MS = 10 * 60_000;
/** Past the grace, how often Chief of Staff retries a thread whose limit has not lifted. */
export const LIMIT_RETRY_EVERY_MS = 30 * 60_000;
/** After the reset, how long before a limit that will not lift goes to a person. */
export const LIMIT_GIVE_UP_MS = 2 * 60 * 60_000;

/**
 * When the usage limit behind a failed turn resets (epoch ms), or null when
 * the turn did not fail on a resettable usage limit. Follows BB's
 * provider-retry rule: a rate-limit error while a subscription window is
 * blocked; the latest reset among the blocked windows. Credit and spend
 * limits do not reset on their own, so they stay failures.
 */
export function usageLimitResetAt(failure: TurnFailure | null | undefined): number | null {
  const info = failure?.errorInfo;
  if (!info || (info.category !== "rate-limit" && info.httpStatusCode !== 429)) return null;
  const limits = failure.rateLimits;
  if (!limits || limits.status !== "blocked" || limits.kind !== "subscription-window") return null;
  const blocked = limits.windows.filter((w) => w.status === "blocked");
  const resets = (blocked.length ? blocked : limits.windows).flatMap((w) => (w.resetsAtMs === null ? [] : [w.resetsAtMs]));
  return resets.length ? Math.max(...resets) : null;
}

/**
 * Read the failure of a thread's latest turn from its events: the provider's
 * error, if it came after the latest turn request, and the latest rate-limit
 * snapshot. Used when the thread failed and BB's turn.failed has not arrived
 * (it follows thread.failed) or was missed.
 */
export async function readTurnFailure(cos: Cos, threadId: string): Promise<TurnFailure | null> {
  try {
    const [latest] = (await cos.bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested", "provider/error"], order: "desc", limit: "1" })) as { type: string; data?: { errorInfo?: TurnFailure["errorInfo"] } }[];
    if (latest?.type !== "provider/error" || !latest.data?.errorInfo) return null;
    const [limits] = (await cos.bb.sdk.threads.events.list({ threadId, types: ["provider/rateLimits/updated"], order: "desc", limit: "1" })) as { data?: { rateLimits?: TurnFailure["rateLimits"] } }[];
    return { errorInfo: latest.data.errorInfo, rateLimits: limits?.data?.rateLimits ?? null };
  } catch (error) {
    cos.bb.log.debug(`reading the failure of ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Whether a retry of the thread's failed turn is queued (by BB's provider-retry or by us). */
async function retryQueued(cos: Cos, threadId: string): Promise<boolean> {
  const rows = (await cos.bb.sdk.threads.queuedMessages.list({ threadId })) as { payload: { kind: string } }[];
  return rows.some((row) => row.payload.kind === "retry");
}

/** Queue a retry of the thread's failed turn at `sendAt` (now when omitted), unless one is queued already. */
async function ensureRetry(cos: Cos, threadId: string, sendAt?: number): Promise<void> {
  try {
    if (await retryQueued(cos, threadId)) return;
    await cos.bb.sdk.threads.retry({ threadId, ...(sendAt ? { sendAt } : {}), reason: "Usage limit reset: Chief of Staff continues the step" });
  } catch (error) {
    // retry_already_queued: provider-retry got there first. Anything else: the sweep tries again.
    cos.bb.log.info(`retry of ${threadId} after its usage limit not queued: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A thread of an item failed: if its turn hit a usage limit, park the step on
 * the reset instead of failing it, and make sure the turn is retried then.
 * Returns true when the failure is (still) a usage-limit wait, so the caller
 * must not treat it as a failure.
 *
 * `failure` is BB's turn.failed account; without it the thread's events are
 * read, which only opens a wait on a step still running. Only turn.failed may
 * take back a failure already recorded (it arrives just after thread.failed),
 * so a step handed to a person stays with them on later sweeps.
 */
export async function observeUsageLimit(cos: Cos, itemId: string, threadId: string, actor: string, failure?: TurnFailure | null): Promise<boolean> {
  const fromEvent = failure !== undefined;
  const resetAt = usageLimitResetAt(fromEvent ? failure : await readTurnFailure(cos, threadId));
  // Decided under the item's lock: thread.failed and turn.failed arrive back to back.
  const decision = await withItemLock(itemId, async (): Promise<{ wait: boolean; until?: number }> => {
    const item = cos.store.getWorkItem(itemId);
    if (!item || item.status === "done" || (item.status === "failed" && !fromEvent)) return { wait: false };
    const ctx = threadContext(cos, item, threadId);
    const node = ctx?.step ? item.nodes[ctx.step.id] : undefined;
    if (!ctx?.step || !node || (ctx.role === "step" && ctx.row && ctx.row.round !== node.round)) return { wait: false };
    const existing = node.limits?.[ctx.agent];
    const now = cos.now().getTime();
    // Nothing new to read, but the step already waits on this thread's limit: keep waiting (tickLimits watches the clock).
    if (resetAt === null) return { wait: Boolean(existing && existing.threadId === threadId) };
    const until = Math.max(resetAt, now);
    // The same wait seen again (the sweep re-reads the failed thread), or a stale
    // reset the provider still reports: keep the wait's clock, so it can end.
    if (existing && (Date.parse(existing.until) >= until || resetAt <= now)) return { wait: true };
    if (!existing && !fromEvent && node.status !== "running") return { wait: false };
    const why = until - now > MAX_USAGE_LIMIT_WAIT_MS
      ? `resets at ${new Date(until).toISOString()}, past the ${MAX_USAGE_LIMIT_WAIT_MS / 3_600_000}-hour wait`
      : !existing && (node.limitCount ?? 0) >= MAX_USAGE_LIMIT_WAITS ? `hit ${MAX_USAGE_LIMIT_WAITS} times on this step` : null;
    if (why) {
      cos.store.log({ level: "warn", kind: "usage_limit", repo: item.repo, workItemId: item.id, message: `usage limit ${why}: handing the step to a person`, actor });
      return { wait: false };
    }
    const iso = new Date(until).toISOString();
    await dispatchLocked(cos, item.id, { type: "usage_limited", step: ctx.step.id, agent: ctx.agent, until: iso, threadId }, actor);
    // The engine ignores a limit on a step parked on a person (a question, a stall): that stands.
    if (cos.store.getWorkItem(itemId)?.nodes[ctx.step.id]?.limits?.[ctx.agent]?.until !== iso) return { wait: false };
    if (!existing) cos.store.log({ level: "info", kind: "usage_limit", repo: item.repo, workItemId: item.id, message: `${ctx.step.name}: usage limit reached; continues after ${resetTime(iso)}`, actor });
    return { wait: true, until };
  });
  // Shortly after the reset, spread so threads on one account do not all wake at once.
  if (decision.until !== undefined) await ensureRetry(cos, threadId, decision.until + 15_000 + Math.floor(Math.random() * 30_000));
  return decision.wait;
}

/**
 * Per-minute watch over usage-limit waits whose reset has passed: retry a
 * thread nobody retried, and hand the step to a person when the limit will
 * not lift, so a task never hangs on a wait silently.
 */
export async function tickLimits(cos: Cos, actor: string): Promise<void> {
  const now = cos.now().getTime();
  for (const item of cos.store.listWorkItems({ activeOnly: true })) {
    if (cos.store.isPaused(item.repo)) continue;
    for (const [stepId, node] of Object.entries(item.nodes)) {
      for (const [agent, limit] of Object.entries(node.limits ?? {})) {
        const late = now - Date.parse(limit.until);
        if (node.status !== "running" || late < LIMIT_RETRY_GRACE_MS) continue;
        try {
          const thread = await cos.bb.sdk.threads.get({ threadId: limit.threadId });
          if (thread.status !== "error") continue; // the retry is running, or ran: the thread sync takes it from here
          if (late < LIMIT_GIVE_UP_MS) {
            // Once per retry interval (the sweep runs every minute), not every minute.
            if ((late - LIMIT_RETRY_GRACE_MS) % LIMIT_RETRY_EVERY_MS < 60_000) await ensureRetry(cos, limit.threadId);
            continue;
          }
          const ctx = threadContext(cos, item, limit.threadId);
          cos.store.log({ level: "warn", kind: "usage_limit", repo: item.repo, workItemId: item.id, message: `the usage limit did not lift ${Math.round(late / 60_000)} min after its reset`, actor });
          const error = `The provider's usage limit did not lift after its reset at ${resetTime(limit.until)}`;
          await withItemLock(item.id, () => dispatchLocked(cos, item.id, { type: "thread_failed", step: ctx?.role === "builder" ? null : stepId, agent: Number(agent), error }, actor));
        } catch (error) {
          cos.bb.log.warn(`usage limit watch ${item.id} failed: ${await cos.safe(error instanceof Error ? error.message : String(error))}`);
        }
      }
    }
  }
}
