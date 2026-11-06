// Helpers around bb.sdk.threads for spawning and inspecting agent threads.
import type { Cos } from "./context";
import type { RepoConfig } from "./config";

export interface SpawnOptions {
  repo: RepoConfig;
  title: string;
  prompt: string;
  /** Base the worktree on this branch instead of the default branch. */
  baseBranch?: string;
  pluginMetadata: Record<string, string | number | boolean | null>;
  parentThreadId?: string;
}

export async function spawnWorktreeThread(cos: Cos, opts: SpawnOptions) {
  const { values } = await cos.config();
  const checkout = await cos.checkout(opts.repo);
  const providerId = opts.repo.providerId || values.defaultProviderId || undefined;
  const model = opts.repo.model || values.defaultModel || undefined;
  const thread = await cos.bb.sdk.threads.spawn({
    projectId: opts.repo.projectId,
    environment: {
      type: "host",
      hostId: checkout.hostId,
      workspace: { type: "managed-worktree", baseBranch: opts.baseBranch ? { kind: "named", name: opts.baseBranch } : { kind: "default" } },
    },
    prompt: opts.prompt,
    title: opts.title,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(opts.repo.reasoningLevel ? { reasoningLevel: opts.repo.reasoningLevel } : {}),
    permissionMode: opts.repo.permissionMode,
    visibility: "visible",
    pluginMetadata: opts.pluginMetadata,
    ...(opts.parentThreadId ? { parentThreadId: opts.parentThreadId } : {}),
  });
  return { thread, providerId: thread.providerId ?? providerId ?? null, model: model ?? null, hostId: checkout.hostId };
}

export interface ReviewerSpawnOptions {
  repo: RepoConfig;
  /** The builder's environment: the reviewer reads the same worktree. */
  environmentId: string;
  parentThreadId?: string;
  title: string;
  prompt: string;
  pluginMetadata: Record<string, string | number | boolean | null>;
}

/** Spawn the independent reviewer in the builder's workspace (it sees exactly what was built). */
export async function spawnReviewerThread(cos: Cos, opts: ReviewerSpawnOptions) {
  const { values } = await cos.config();
  const providerId = opts.repo.providerId || values.defaultProviderId || undefined;
  const model = opts.repo.model || values.defaultModel || undefined;
  const thread = await cos.bb.sdk.threads.spawn({
    projectId: opts.repo.projectId,
    environment: { type: "reuse", environmentId: opts.environmentId },
    prompt: opts.prompt,
    title: opts.title,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(opts.repo.reasoningLevel ? { reasoningLevel: opts.repo.reasoningLevel } : {}),
    permissionMode: opts.repo.permissionMode,
    visibility: "visible",
    pluginMetadata: opts.pluginMetadata,
    ...(opts.parentThreadId ? { parentThreadId: opts.parentThreadId } : {}),
  });
  return { thread };
}

export interface ThreadUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: { amount: number; currency: string } | null;
}

/** Token usage / cost from the thread's latest usage events, when the provider reports them. */
export async function readThreadUsage(cos: Cos, threadId: string): Promise<ThreadUsage> {
  const usage: ThreadUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null };
  const pick = (obj: unknown, path: string[]): unknown => path.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
  try {
    const result = await cos.bb.sdk.threads.events.list({ threadId, types: ["thread/tokenUsage/updated"], order: "desc", limit: "1" });
    const event = (result as unknown[])[0] as Record<string, unknown> | undefined;
    const payload = (event?.data ?? event) as unknown;
    const total = pick(payload, ["tokenUsage", "total"]) as Record<string, unknown> | undefined;
    if (total) {
      usage.inputTokens = typeof total.inputTokens === "number" ? total.inputTokens : null;
      usage.outputTokens = typeof total.outputTokens === "number" ? total.outputTokens : null;
      usage.totalTokens = typeof total.totalTokens === "number" ? total.totalTokens : null;
    }
  } catch {
    /* provider does not report usage */
  }
  try {
    const result = await cos.bb.sdk.threads.events.list({ threadId, types: ["thread/contextWindowUsage/updated"], order: "desc", limit: "1" });
    const event = (result as unknown[])[0] as Record<string, unknown> | undefined;
    const payload = (event?.data ?? event) as unknown;
    const cost = pick(payload, ["contextWindowUsage", "cost"]) as Record<string, unknown> | undefined;
    if (cost && typeof cost.amount === "number") usage.cost = { amount: cost.amount, currency: typeof cost.currency === "string" ? cost.currency : "USD" };
  } catch {
    /* no cost info */
  }
  return usage;
}

export async function sendToThread(cos: Cos, threadId: string, text: string): Promise<void> {
  await cos.bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
}

export async function lastAssistantText(cos: Cos, threadId: string): Promise<string | null> {
  try {
    const output = await cos.bb.sdk.threads.output({ threadId });
    return output.output ?? null;
  } catch {
    return null;
  }
}

export function threadUrl(cos: Cos, threadId: string): string {
  const base = cos.bb.server.experimental_appUrl;
  return base ? `${base.replace(/\/$/, "")}/threads/${threadId}` : `bb://threads/${threadId}`;
}

const REASON_MAX = 600;

/**
 * One-line, human-readable description of a pending interaction: the agent's
 * question, the approval it wants, or the request title. Reads the payload
 * defensively because interaction kinds are open-ended (`<ns>/<name>`).
 */
export function describeInteraction(interaction: unknown): string {
  const payload = (interaction as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const kind = typeof payload.kind === "string" ? payload.kind : "";
  if (kind === "user_question" && Array.isArray(payload.questions)) {
    const prompts = payload.questions.map((q) => (q && typeof (q as { prompt?: unknown }).prompt === "string" ? (q as { prompt: string }).prompt.trim() : "")).filter(Boolean);
    if (prompts.length) return clip(`Question: ${prompts.join(" / ")}`);
    return "The agent asked a question.";
  }
  if (kind === "approval") {
    const subject = payload.subject as { kind?: unknown } | undefined;
    const what = typeof subject?.kind === "string" ? subject.kind.replace(/_/g, " ") : "an action";
    const reason = typeof payload.reason === "string" && payload.reason.trim() ? `: ${payload.reason.trim()}` : "";
    return clip(`Approval needed for ${what}${reason}`);
  }
  if (typeof payload.title === "string" && payload.title.trim()) return clip(`Input needed: ${payload.title.trim()}`);
  const detail = (payload.presentation as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string" && detail.trim()) return clip(`Input needed: ${detail.trim()}`);
  return "The agent is waiting for a human decision.";
}

/** Pending (unanswered) interactions on a thread, described. Null when the read fails. */
export async function pendingInteractions(cos: Cos, threadId: string): Promise<string[] | null> {
  try {
    const list = await cos.bb.sdk.threads.interactions.list({ threadId });
    return list.filter((i) => i.status === "pending" || i.status === "resolving").map(describeInteraction);
  } catch (error) {
    cos.bb.log.debug(`interactions.list ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Did the agent end its turn by asking a question in plain text instead of
 * reporting a finished result? True when the reply has no "Summary" section
 * and its last paragraph ends with a question mark. Returns the question.
 */
export function plainTextQuestion(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/^#{1,4}\s*Summary\s*$/im.test(text)) return null;
  const paragraphs = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paragraphs[paragraphs.length - 1];
  if (!last || !/\?\s*(\*\*|_|`)?\s*$/.test(last)) return null;
  return clip(`Question: ${last.replace(/\s+/g, " ")}`);
}

function clip(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}
