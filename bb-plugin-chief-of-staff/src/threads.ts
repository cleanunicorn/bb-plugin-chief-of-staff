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
