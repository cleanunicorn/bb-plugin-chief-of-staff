// Helpers around bb.sdk.threads for spawning and inspecting agent threads.
import type { Cos } from "./context";
import type { RepoConfig } from "./config";
import type { KnownSkill, SkillMention } from "./skills";
import { resolveAgent, type AgentSettings } from "./workflow";

/** A prompt as `prompt`, or as text input carrying skill mentions when there are any. */
function promptArgs(prompt: string, mentions: SkillMention[] | undefined) {
  return mentions?.length ? { input: [{ type: "text" as const, text: prompt, mentions }] } : { prompt };
}

/** Skills available to agents in a workspace; empty when bb cannot list them. */
export async function listSkills(cos: Cos, projectId: string, environmentId: string | null): Promise<KnownSkill[]> {
  try {
    const { skills } = await cos.bb.sdk.skills.list({ projectId, environmentId });
    return skills.map((s) => ({ name: s.name, description: s.description, scope: s.scope }));
  } catch (error) {
    cos.bb.log.debug(`skills list failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export interface DeliveryHooks {
  sending(): void;
  accepted(thread?: { id: string; environmentId?: string | null; providerId?: string | null }): void;
}

export interface SpawnOptions {
  delivery?: DeliveryHooks;
  repo: RepoConfig;
  title: string;
  prompt: string;
  /** Skill mentions inside `prompt`. */
  mentions?: SkillMention[];
  /** Base the worktree on this branch instead of the default branch. */
  baseBranch?: string;
  /** Set by model steps of the workflow; wins over the repository and global defaults. */
  settings?: AgentSettings;
  pluginMetadata: Record<string, string | number | boolean | null>;
  parentThreadId?: string;
}

export async function spawnWorktreeThread(cos: Cos, opts: SpawnOptions) {
  const { values } = await cos.config();
  const checkout = await cos.checkout(opts.repo);
  const { providerId, model, reasoningLevel } = resolveAgent(opts.settings, opts.repo, { providerId: values.defaultProviderId, model: values.defaultModel });
  opts.delivery?.sending();
  const thread = await cos.bb.sdk.threads.spawn({
    projectId: opts.repo.projectId,
    environment: {
      type: "host",
      hostId: checkout.hostId,
      workspace: { type: "managed-worktree", baseBranch: opts.baseBranch ? { kind: "named", name: opts.baseBranch } : { kind: "default" } },
    },
    ...promptArgs(opts.prompt, opts.mentions),
    title: opts.title,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    permissionMode: opts.repo.permissionMode,
    visibility: "visible",
    pluginMetadata: opts.pluginMetadata,
    ...(opts.parentThreadId ? { parentThreadId: opts.parentThreadId, parentNotifications: "off" as const } : {}),
  });
  opts.delivery?.accepted(thread);
  return { thread, providerId: thread.providerId ?? providerId ?? null, model: model ?? null, hostId: checkout.hostId };
}

export interface StepSpawnOptions {
  delivery?: DeliveryHooks;
  repo: RepoConfig;
  /** The builder's environment, when it exists: read-only steps then see exactly what was built. */
  environmentId: string | null;
  parentThreadId?: string;
  title: string;
  prompt: string;
  mentions?: SkillMention[];
  settings?: AgentSettings;
  pluginMetadata: Record<string, string | number | boolean | null>;
  /**
   * Without a builder workspace, run in the project's own checkout instead of a
   * fresh worktree: for steps that only read (choosing a model), where a
   * worktree would be created for nothing and never reused.
   */
  inCheckout?: boolean;
}

/**
 * Spawn an agent for a read-only step: in the builder's workspace when there
 * is one, otherwise in a fresh worktree of the default branch (nothing has been
 * built yet, so there is nothing to see but the repository), or with
 * `inCheckout` in the project's own checkout.
 */
export async function spawnStepThread(cos: Cos, opts: StepSpawnOptions) {
  if (!opts.environmentId && !opts.inCheckout) return spawnWorktreeThread(cos, { repo: opts.repo, delivery: opts.delivery, title: opts.title, prompt: opts.prompt, mentions: opts.mentions, settings: opts.settings, pluginMetadata: opts.pluginMetadata, parentThreadId: opts.parentThreadId });
  const { values } = await cos.config();
  // `path: null` is the host's configured checkout of the project: no worktree is created.
  const environment = opts.environmentId
    ? { type: "reuse" as const, environmentId: opts.environmentId }
    : { type: "host" as const, hostId: (await cos.checkout(opts.repo)).hostId, workspace: { type: "unmanaged" as const, path: null } };
  const { providerId, model, reasoningLevel } = resolveAgent(opts.settings, opts.repo, { providerId: values.defaultProviderId, model: values.defaultModel });
  opts.delivery?.sending();
  const thread = await cos.bb.sdk.threads.spawn({
    projectId: opts.repo.projectId,
    environment,
    ...promptArgs(opts.prompt, opts.mentions),
    title: opts.title,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    permissionMode: opts.repo.permissionMode,
    visibility: "visible",
    pluginMetadata: opts.pluginMetadata,
    ...(opts.parentThreadId ? { parentThreadId: opts.parentThreadId, parentNotifications: "off" as const } : {}),
  });
  opts.delivery?.accepted(thread);
  return { thread, providerId: thread.providerId ?? providerId ?? null, model: model ?? null };
}

export interface ThreadUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: { amount: number; currency: string } | null;
}

/** A thread's usage, and whether both usage queries answered (an empty answer or a deleted thread counts: nothing is reported). */
export interface UsageRead {
  usage: ThreadUsage;
  complete: boolean;
}

const pick = (obj: unknown, path: string[]): unknown => path.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);

/** Token usage / cost from the thread's latest usage events, when the provider reports them. */
export async function readThreadUsage(cos: Cos, threadId: string): Promise<UsageRead> {
  const usage: ThreadUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null };
  const latest = async (type: "thread/tokenUsage/updated" | "thread/contextWindowUsage/updated") => {
    const result = await cos.bb.sdk.threads.events.list({ threadId, types: [type], order: "desc", limit: "1" });
    const event = (result as unknown[])[0] as Record<string, unknown> | undefined;
    return (event?.data ?? event) as unknown;
  };
  const [tokens, cost] = await Promise.allSettled([latest("thread/tokenUsage/updated"), latest("thread/contextWindowUsage/updated")]);
  if (tokens.status === "fulfilled") {
    const total = pick(tokens.value, ["tokenUsage", "total"]) as Record<string, unknown> | undefined;
    if (total) {
      usage.inputTokens = typeof total.inputTokens === "number" ? total.inputTokens : null;
      usage.outputTokens = typeof total.outputTokens === "number" ? total.outputTokens : null;
      usage.totalTokens = typeof total.totalTokens === "number" ? total.totalTokens : null;
    }
  }
  if (cost.status === "fulfilled") {
    const amount = pick(cost.value, ["contextWindowUsage", "cost"]) as Record<string, unknown> | undefined;
    if (amount && typeof amount.amount === "number") usage.cost = { amount: amount.amount, currency: typeof amount.currency === "string" ? amount.currency : "USD" };
  }
  // A deleted thread answers 404: it has nothing more to report, so the read is complete.
  const answered = (r: PromiseSettledResult<unknown>) => r.status === "fulfilled" || (r.reason as { status?: number } | null)?.status === 404;
  return { usage, complete: answered(tokens) && answered(cost) };
}

export async function sendToThread(cos: Cos, threadId: string, text: string, mentions: SkillMention[] = [], delivery?: DeliveryHooks): Promise<void> {
  delivery?.sending();
  await cos.bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions }] });
  delivery?.accepted();
}

export async function lastAssistantText(cos: Cos, threadId: string): Promise<string | null> {
  try {
    const output = await cos.bb.sdk.threads.output({ threadId });
    return output.output ?? null;
  } catch {
    return null;
  }
}

/**
 * The thread's web URL for text others read (issue comments, PR bodies), or
 * null when BB has no public app URL. `bb://` links only mean something to the
 * operator, so they never belong in public text.
 */
export function publicThreadUrl(cos: Cos, threadId: string): string | null {
  const base = cos.bb.server.experimental_appUrl;
  return base ? `${base.replace(/\/$/, "")}/threads/${threadId}` : null;
}

/** The thread's link for the operator's own dashboard; falls back to the `bb://` scheme. */
export function threadUrl(cos: Cos, threadId: string): string {
  return publicThreadUrl(cos, threadId) ?? `bb://threads/${threadId}`;
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
